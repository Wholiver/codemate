import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import {
  appendTrajectoryRecord,
  createTrajectoryRecord,
  pathProjectTrajectories,
  readTrajectoryRecords,
  searchRecentTrajectories,
} from "@/session/trajectory"

const tmpDirs: string[] = []

afterEach(async () => {
  await Promise.all(
    tmpDirs.splice(0, tmpDirs.length).map((dir) =>
      fs.rm(dir, { recursive: true, force: true }).catch(() => undefined),
    ),
  )
})

async function createProjectRoot() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codemate-trajectory-"))
  tmpDirs.push(dir)
  return dir
}

function makeTrajectory(overrides?: Partial<Parameters<typeof createTrajectoryRecord>[0]>) {
  return createTrajectoryRecord({
    run_id: "run-a",
    task_id: "coder_tls",
    task_graph_id: "graph-a",
    source_user_message_id: "user-msg-1",
    intent_anchor_hash: "ia:abcd1234",
    agent: "coder",
    action_summary: "create tls artifacts",
    expected_outputs: ["~/app/ssl/server.crt"],
    actual_outputs: ["created ~/app/ssl/server.crt"],
    artifact_paths: ["~/app/ssl/server.crt"],
    commands_run: ["openssl req -x509 -newkey rsa:2048 -keyout ~/app/ssl/server.key"],
    verification_results: ["fingerprint verified"],
    tool_results: ["subagent_session:s1"],
    outcome: "success",
    quality_signals: { command_success: true },
    ...overrides,
  })
}

describe("session.trajectory persistence", () => {
  test("append trajectory writes valid JSONL", async () => {
    const projectRoot = await createProjectRoot()
    const record = makeTrajectory()
    const result = await appendTrajectoryRecord(projectRoot, record)

    expect(result.written).toBe(true)
    expect(result.path).toBe(pathProjectTrajectories(projectRoot))

    const file = Bun.file(pathProjectTrajectories(projectRoot))
    expect(await file.exists()).toBe(true)

    const lines = (await file.text())
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
    expect(lines.length).toBe(1)

    const parsed = JSON.parse(lines[0]!) as Record<string, unknown>
    expect(parsed["version"]).toBe(1)
    expect(parsed["run_id"]).toBe("run-a")
    expect(parsed["task_id"]).toBe("coder_tls")
    expect(parsed["source_user_message_id"]).toBe("user-msg-1")
    expect(parsed["intent_anchor_hash"]).toBe("ia:abcd1234")
  })

  test("readTrajectoryRecords reads records back", async () => {
    const projectRoot = await createProjectRoot()
    await appendTrajectoryRecord(projectRoot, makeTrajectory({ run_id: "run-1", task_id: "t1" }))
    await appendTrajectoryRecord(projectRoot, makeTrajectory({ run_id: "run-2", task_id: "t2" }))

    const result = await readTrajectoryRecords(projectRoot)
    expect(result.warnings.length).toBe(0)
    expect(result.records.length).toBe(2)
    expect(result.records.map((item) => item.run_id)).toContain("run-1")
    expect(result.records.map((item) => item.run_id)).toContain("run-2")
  })

  test("filters by run_id / agent / outcome", async () => {
    const projectRoot = await createProjectRoot()
    await appendTrajectoryRecord(projectRoot, makeTrajectory({ run_id: "run-x", agent: "coder", outcome: "success" }))
    await appendTrajectoryRecord(projectRoot, makeTrajectory({ run_id: "run-y", agent: "tester", outcome: "failure" }))
    await appendTrajectoryRecord(projectRoot, makeTrajectory({ run_id: "run-y", agent: "tester", outcome: "recovered" }))

    const byRun = await readTrajectoryRecords(projectRoot, { run_id: "run-y" })
    expect(byRun.records.length).toBe(2)

    const byAgent = await readTrajectoryRecords(projectRoot, { agent: "tester" })
    expect(byAgent.records.length).toBe(2)

    const byOutcome = await readTrajectoryRecords(projectRoot, { outcome: "failure" })
    expect(byOutcome.records.length).toBe(1)
    expect(byOutcome.records[0]?.outcome).toBe("failure")
  })

  test("cancelled trajectory is persisted as cancelled, not success", async () => {
    const projectRoot = await createProjectRoot()
    await appendTrajectoryRecord(projectRoot, makeTrajectory({ run_id: "run-c", outcome: "cancelled" }))

    const cancelled = await readTrajectoryRecords(projectRoot, { run_id: "run-c", outcome: "cancelled" })
    const success = await readTrajectoryRecords(projectRoot, { run_id: "run-c", outcome: "success" })

    expect(cancelled.records.length).toBe(1)
    expect(cancelled.records[0]?.outcome).toBe("cancelled")
    expect(success.records.length).toBe(0)
  })

  test("private key / PEM body is redacted", async () => {
    const projectRoot = await createProjectRoot()
    const sensitive = makeTrajectory({
      actual_outputs: [
        "-----BEGIN PRIVATE KEY-----\\nMIIEvwIBADANBgkqhkiG9w0BAQEFAASCBKkwggSl...\\n-----END PRIVATE KEY-----",
        "-----BEGIN CERTIFICATE-----\\nMIIDCTCCAfGgAwIBAgIUdummysamplecertdata...\\n-----END CERTIFICATE-----",
        "Authorization: Bearer sk-very-secret-token-value",
      ],
      verification_results: ["subject=CN=dev-internal.company.local", "fingerprint=AA:BB:CC"],
    })

    await appendTrajectoryRecord(projectRoot, sensitive)
    const { records } = await readTrajectoryRecords(projectRoot)
    const first = records[0]
    expect(first).toBeDefined()
    if (!first) return

    const packed = [
      first.action_summary,
      ...first.actual_outputs,
      ...first.verification_results,
      ...first.commands_run,
      ...first.tool_results,
    ].join("\n")

    expect(packed).not.toContain("BEGIN PRIVATE KEY")
    expect(packed).not.toContain("MIIEvwIB")
    expect(packed).not.toContain("BEGIN CERTIFICATE")
    expect(packed).not.toContain("MIIDCTCC")
    expect(packed).not.toContain("sk-very-secret-token-value")
    expect(packed).toContain("[REDACTED_PRIVATE_KEY_BLOCK]")
    expect(packed).toContain("[REDACTED_CERTIFICATE_PEM_BLOCK]")
    expect(packed).toContain("subject=CN=dev-internal.company.local")
    expect(packed).toContain("fingerprint=AA:BB:CC")
  })

  test("long fields are truncated", async () => {
    const projectRoot = await createProjectRoot()
    const longText = `very-long-${"x".repeat(1200)}`
    await appendTrajectoryRecord(
      projectRoot,
      makeTrajectory({
        action_summary: longText,
        actual_outputs: [longText],
        commands_run: [longText],
      }),
    )

    const { records } = await readTrajectoryRecords(projectRoot)
    const first = records[0]
    expect(first).toBeDefined()
    if (!first) return

    expect(first.action_summary.length).toBeLessThan(260)
    expect(first.action_summary).toContain("[truncated]")
    expect(first.actual_outputs[0]?.length ?? 0).toBeLessThan(320)
    expect(first.actual_outputs[0] ?? "").toContain("[truncated]")
  })

  test("corrupt JSONL line does not crash read, returns warning/skip", async () => {
    const projectRoot = await createProjectRoot()
    const file = pathProjectTrajectories(projectRoot)
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(
      file,
      [
        JSON.stringify(makeTrajectory({ run_id: "good-run" })),
        "{this is not json}",
        "",
      ].join("\n"),
      "utf8",
    )

    const result = await readTrajectoryRecords(projectRoot)
    expect(result.records.length).toBe(1)
    expect(result.records[0]?.run_id).toBe("good-run")
    expect(result.warnings.length).toBeGreaterThan(0)
    expect(result.warnings.join("\n")).toContain("JSON parse failed")
  })

  test("writing failure does not crash main flow if possible to test", async () => {
    const projectRoot = await createProjectRoot()
    await fs.writeFile(path.join(projectRoot, ".codemate"), "not-a-directory", "utf8")

    const result = await appendTrajectoryRecord(projectRoot, makeTrajectory())
    expect(result.written).toBe(false)
    expect((result.warning ?? "").length).toBeGreaterThan(0)
  })

  test("trajectory persistence does not change lessons.jsonl or changelog.md", async () => {
    const projectRoot = await createProjectRoot()
    await appendTrajectoryRecord(projectRoot, makeTrajectory({ run_id: "run-preserve" }))

    const lessons = Bun.file(path.join(projectRoot, ".codemate", "lessons.jsonl"))
    const changelog = Bun.file(path.join(projectRoot, ".codemate", "changelog.md"))

    expect(await lessons.exists()).toBe(false)
    expect(await changelog.exists()).toBe(false)
  })

  test("searchRecentTrajectories supports simple query", async () => {
    const projectRoot = await createProjectRoot()
    await appendTrajectoryRecord(
      projectRoot,
      makeTrajectory({
        run_id: "run-tls",
        action_summary: "fix tls path mismatch and recover",
        actual_outputs: ["corrected tls path and reran verification"],
      }),
    )
    await appendTrajectoryRecord(projectRoot, makeTrajectory({ run_id: "run-other", action_summary: "update docs" }))

    const result = await searchRecentTrajectories(projectRoot, { query: "tls path", limit: 5 })
    expect(result.records.length).toBe(1)
    expect(result.records[0]?.run_id).toBe("run-tls")
  })
})
