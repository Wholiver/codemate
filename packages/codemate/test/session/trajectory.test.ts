import { describe, expect, test } from "bun:test"
import os from "os"
import {
  createTrajectoryRecord,
  extractTrajectoryEvidenceFromSubtask,
  filterTrajectoryByRun,
  formatTrajectoryEvidenceForWriter,
  sanitizeArtifactPathsForCurrentRun,
} from "@/session/trajectory"
import { deriveLessonProposalsFromTrajectory, formatLessonProposalsForWriter } from "@/session/lesson-proposal"

describe("session.trajectory", () => {
  const home = os.homedir().replaceAll("\\", "/").replace(/\/+$/, "")
  const homeApp = `${home}/app`

  test("trajectory record can be created and formatted", () => {
    const record = createTrajectoryRecord({
      run_id: "run-a",
      task_id: "coder_tls",
      agent: "coder",
      action_summary: "create tls artifacts",
      expected_outputs: ["/app/ssl/server.crt"],
      actual_outputs: [`created ${homeApp}/ssl/server.crt with CN=dev-internal.company.local`],
      artifact_paths: [`${homeApp}/ssl/server.crt`],
      commands_run: ["openssl req -x509 -newkey rsa:2048 ..."],
      verification_results: ["chmod 600 verified"],
      tool_results: ["subagent_session:s1"],
      outcome: "success",
      quality_signals: { command_success: true },
    })
    const text = formatTrajectoryEvidenceForWriter([record])
    expect(record.id.length).toBeGreaterThan(0)
    expect(record.created_at.length).toBeGreaterThan(10)
    expect(text).toContain("Execution evidence from this run:")
    expect(text).toContain("Task: coder_tls")
    expect(text).toContain(`${homeApp}/ssl/server.crt`)
    expect(text).not.toContain("<task_result>")
  })

  test("extractTrajectoryEvidenceFromSubtask picks artifacts, commands and verification", () => {
    const record = extractTrajectoryEvidenceFromSubtask({
      run_id: "run-a",
      task: {
        task_id: "coder_tls",
        task_role: "coder",
        description: "Apply TLS certificate workflow",
        prompt: `create certs under ${homeApp}/ssl`,
      },
      output: [
        `created ${homeApp}/ssl/server.key with 600 permissions`,
        `created ${homeApp}/ssl/server.crt with O=DevOps Team, CN=dev-internal.company.local`,
        `python ${homeApp}/check_cert.py`,
        "verification passed",
      ].join("\n"),
      metadata: { sessionId: "sub-1" },
      outcome: "success",
    })
    expect(record.artifact_paths).toContain(`${homeApp}/ssl/server.key`)
    expect(record.artifact_paths).toContain(`${homeApp}/check_cert.py`)
    expect(record.commands_run).toContain(`python ${homeApp}/check_cert.py`)
    expect(record.verification_results.some((item) => item.toLowerCase().includes("passed"))).toBe(true)
  })

  test("thinking lines are excluded from trajectory evidence fields", () => {
    const record = extractTrajectoryEvidenceFromSubtask({
      run_id: "run-thinking-filter",
      task: {
        task_id: "coder_reasoning_text",
        task_role: "coder",
        description: "capture execution evidence only",
        prompt: "produce output",
      },
      output: [
        "_Thinking:_ run verification quickly",
        `created ${homeApp}/ssl/server.crt`,
        "verification passed",
      ].join("\n"),
      outcome: "success",
      evidence_refs: ["_Thinking:_ plan before writing", "verified cert path"],
    })

    expect(record.actual_outputs.some((item) => item.toLowerCase().includes("thinking"))).toBe(false)
    expect(record.verification_results.some((item) => item.toLowerCase().includes("thinking"))).toBe(false)
    expect(record.evidence_refs?.some((item) => item.toLowerCase().includes("thinking")) ?? false).toBe(false)
    expect(record.evidence_refs).toContain("verified cert path")
  })

  test("artifact extraction rejects tags, counts and non-path fragments", () => {
    const record = extractTrajectoryEvidenceFromSubtask({
      run_id: "run-artifact-sanitize",
      task: {
        task_id: "writer_tls",
        task_role: "writer",
        description: "persist tls evidence",
        prompt: "persist outputs",
      },
      output: [
        "paths: coder/tester/research/reviewer/writer shell/file /task 39/0 /失败",
        `created ${homeApp}/ssl/server.crt`,
        `created ${homeApp}/check_cert.py`,
      ].join("\n"),
      outcome: "success",
    })
    expect(record.artifact_paths).toContain(`${homeApp}/ssl/server.crt`)
    expect(record.artifact_paths).toContain(`${homeApp}/check_cert.py`)
    expect(record.artifact_paths).not.toContain("coder/tester/research/reviewer/writer")
    expect(record.artifact_paths).not.toContain("shell/file")
    expect(record.artifact_paths).not.toContain("/task")
    expect(record.artifact_paths).not.toContain("39/0")
  })

  test("sanitizeArtifactPathsForCurrentRun keeps current-run paths and rejects stale tls paths", () => {
    const sanitized = sanitizeArtifactPathsForCurrentRun(
      [
        "coder/tester/research/reviewer/writer",
        "39/0",
        "ssl/certs/server.crt",
        "test/certs/server.crt",
        `${homeApp}/ssl/server.key`,
        `${homeApp}/check_cert.py`,
      ],
      "tls cert workflow",
      [`${homeApp}/ssl/server.key`, `${homeApp}/check_cert.py`],
    )
    expect(sanitized.accepted_paths).toContain(`${homeApp}/ssl/server.key`)
    expect(sanitized.accepted_paths).toContain(`${homeApp}/check_cert.py`)
    expect(sanitized.accepted_paths).not.toContain("ssl/certs/server.crt")
    expect(sanitized.accepted_paths).not.toContain("test/certs/server.crt")
    expect(sanitized.rejected_paths).toContain("39/0")
    expect(sanitized.warnings.some((item) => item.includes("rejected_path_outside_current_run"))).toBe(true)
  })

  test("home path fallback keeps absolute HOME paths without hardcoded /home", () => {
    const absoluteFallback = `${home}/app/ssl/server.crt`
    const sanitized = sanitizeArtifactPathsForCurrentRun([absoluteFallback], "tls cert workflow", [absoluteFallback])
    expect(sanitized.accepted_paths).toContain(absoluteFallback)
    expect(sanitized.accepted_paths).not.toContain("~/app/ssl/server.crt")
  })

  test("no evidence case renders evidence missing", () => {
    const text = formatTrajectoryEvidenceForWriter([])
    expect(text).toContain("evidence missing")
    expect(text).not.toContain("glob **/ssl/**")
  })

  test("trajectory scoped by run filters unrelated records", () => {
    const runA = createTrajectoryRecord({
      run_id: "run-a",
      task_id: "a",
      agent: "coder",
      action_summary: "a",
      expected_outputs: [],
      actual_outputs: [`${homeApp}/ssl/server.crt`],
      artifact_paths: [`${homeApp}/ssl/server.crt`],
      commands_run: [],
      verification_results: [],
      tool_results: [],
      outcome: "success",
      quality_signals: {},
    })
    const runB = createTrajectoryRecord({
      run_id: "run-b",
      task_id: "b",
      agent: "coder",
      action_summary: "b",
      expected_outputs: [],
      actual_outputs: ["packages/codemate/ssl/server.crt"],
      artifact_paths: ["packages/codemate/ssl/server.crt"],
      commands_run: [],
      verification_results: [],
      tool_results: [],
      outcome: "success",
      quality_signals: {},
    })
    const scoped = filterTrajectoryByRun([runA, runB], "run-a")
    const text = formatTrajectoryEvidenceForWriter(scoped)
    expect(scoped).toHaveLength(1)
    expect(text).toContain(`${homeApp}/ssl/server.crt`)
    expect(text).not.toContain("packages/codemate/ssl/server.crt")
  })

  test("tester/reviewer evidence is included in formatted trajectory", () => {
    const tester = createTrajectoryRecord({
      run_id: "run-a",
      task_id: "tester_tls",
      agent: "tester",
      action_summary: "verify cert script",
      expected_outputs: [],
      actual_outputs: [],
      artifact_paths: [`${homeApp}/check_cert.py`],
      commands_run: [`python ${homeApp}/check_cert.py`],
      verification_results: ["all tests passed"],
      tool_results: [],
      outcome: "success",
      quality_signals: { tester_passed: true, command_success: true },
    })
    const reviewer = createTrajectoryRecord({
      run_id: "run-a",
      task_id: "review_tls",
      agent: "reviewer",
      action_summary: "review tls output",
      expected_outputs: [],
      actual_outputs: [],
      artifact_paths: [],
      commands_run: [],
      verification_results: ["approved"],
      tool_results: [],
      outcome: "success",
      quality_signals: { reviewer_approved: true },
    })
    const text = formatTrajectoryEvidenceForWriter([tester, reviewer])
    expect(text).toContain("tester_passed=true")
    expect(text).toContain("reviewer_approved=true")
    expect(text).toContain("all tests passed")
    expect(text).toContain("approved")
  })

  test("recovered trajectory produces failure_pattern proposal", () => {
    const recovered = createTrajectoryRecord({
      run_id: "run-proposal-a",
      task_id: "tester_retry",
      agent: "tester",
      action_summary: "rerun tests after correcting wrong path",
      expected_outputs: ["packages/codemate/src/session/prompt.ts"],
      actual_outputs: ["retry succeeded after fixing path"],
      artifact_paths: ["packages/codemate/src/session/prompt.ts"],
      commands_run: ["bun test test/session/prompt.test.ts"],
      verification_results: ["tests passed after retry"],
      tool_results: [],
      outcome: "recovered",
      quality_signals: { tester_passed: true, command_success: true },
      failure: {
        signal: "wrong path used for fixture update",
        failed_behavior: "editing stale path first",
      },
      recovery: {
        repair_action: "switch to correct path and rerun tests",
        success_signal: "tests passed after retry",
      },
      evidence_refs: ["wrong path -> corrected path"],
    })
    const proposals = deriveLessonProposalsFromTrajectory([recovered], { run_id: "run-proposal-a" })
    const failure = proposals.find((item) => item.proposed_type === "failure_pattern")
    expect(failure).toBeDefined()
    if (!failure) return
    expect(failure.applies_when.length).toBeGreaterThan(0)
    expect(failure.do.length).toBeGreaterThan(0)
    expect(failure.dont.length).toBeGreaterThan(0)
    expect(failure.evidence.join(" ")).toContain("wrong path")
    expect(failure.evidence.join(" ")).toContain("tests passed after retry")
  })

  test("successful verified workflow produces workflow_rule proposal", () => {
    const coder = createTrajectoryRecord({
      run_id: "run-proposal-b",
      task_id: "coder_apply",
      agent: "coder",
      action_summary: "apply session prompt update",
      expected_outputs: ["packages/codemate/src/session/prompt.ts"],
      actual_outputs: ["updated writer payload block"],
      artifact_paths: ["packages/codemate/src/session/prompt.ts"],
      commands_run: ["bun typecheck"],
      verification_results: ["typecheck passed"],
      tool_results: [],
      outcome: "success",
      quality_signals: { command_success: true },
    })
    const tester = createTrajectoryRecord({
      run_id: "run-proposal-b",
      task_id: "tester_verify",
      agent: "tester",
      action_summary: "run session tests",
      expected_outputs: [],
      actual_outputs: [],
      artifact_paths: ["packages/codemate/test/session/trajectory.test.ts"],
      commands_run: ["bun test test/session/trajectory.test.ts"],
      verification_results: ["tests passed"],
      tool_results: [],
      outcome: "success",
      quality_signals: { tester_passed: true, command_success: true },
    })
    const reviewer = createTrajectoryRecord({
      run_id: "run-proposal-b",
      task_id: "reviewer_check",
      agent: "reviewer",
      action_summary: "confirm proposal quality",
      expected_outputs: [],
      actual_outputs: [],
      artifact_paths: ["packages/codemate/src/session/lesson-proposal.ts"],
      commands_run: [],
      verification_results: ["approved"],
      tool_results: [],
      outcome: "success",
      quality_signals: { reviewer_approved: true },
    })
    const proposals = deriveLessonProposalsFromTrajectory([coder, tester, reviewer], { run_id: "run-proposal-b" })
    const workflow = proposals.find((item) => item.proposed_type === "workflow_rule")
    expect(workflow).toBeDefined()
    if (!workflow) return
    expect(workflow.evidence.length).toBeGreaterThan(0)
    expect(workflow.do.join(" ")).toContain("verification")
  })

  test("changelog fact does not produce proposal", () => {
    const changelogLike = createTrajectoryRecord({
      run_id: "run-proposal-c",
      task_id: "coder_note",
      agent: "coder",
      action_summary: "created file src/new.ts",
      expected_outputs: [],
      actual_outputs: ["created src/new.ts"],
      artifact_paths: ["src/new.ts"],
      commands_run: [],
      verification_results: [],
      tool_results: [],
      outcome: "success",
      quality_signals: {},
    })
    const proposals = deriveLessonProposalsFromTrajectory([changelogLike], { run_id: "run-proposal-c" })
    expect(proposals.length).toBe(0)
  })

  test("no evidence no proposal", () => {
    const summaryOnly = createTrajectoryRecord({
      run_id: "run-proposal-d",
      task_id: "coder_summary_only",
      agent: "coder",
      action_summary: "completed subtask summary only",
      expected_outputs: [],
      actual_outputs: [],
      artifact_paths: [],
      commands_run: [],
      verification_results: [],
      tool_results: [],
      outcome: "success",
      quality_signals: {},
    })
    const proposals = deriveLessonProposalsFromTrajectory([summaryOnly], { run_id: "run-proposal-d" })
    expect(proposals.length).toBe(0)
  })

  test("writer payload formatter includes proposal confidence and evidence", () => {
    const recovered = createTrajectoryRecord({
      run_id: "run-proposal-e",
      task_id: "tester_retry",
      agent: "tester",
      action_summary: "retry after fixing path",
      expected_outputs: [],
      actual_outputs: ["retry succeeded"],
      artifact_paths: ["packages/codemate/src/session/prompt.ts"],
      commands_run: ["bun test test/session/prompt.test.ts"],
      verification_results: ["tests passed"],
      tool_results: [],
      outcome: "recovered",
      quality_signals: { tester_passed: true },
      failure: { signal: "wrong path first" },
      recovery: { repair_action: "fix path", success_signal: "tests passed" },
    })
    const proposals = deriveLessonProposalsFromTrajectory([recovered], { run_id: "run-proposal-e" })
    const text = formatLessonProposalsForWriter(proposals)
    expect(text).toContain("Lesson proposals from trajectory:")
    expect(text).toContain("Type:")
    expect(text).toContain("Evidence:")
    expect(text).toContain("Confidence:")
  })

  test("lesson proposal with polluted path like 39/0 is dropped", () => {
    const coderA = createTrajectoryRecord({
      run_id: "run-polluted-path",
      task_id: "coder_a",
      agent: "coder",
      action_summary: "write a",
      expected_outputs: [],
      actual_outputs: ["done"],
      artifact_paths: ["39/0"],
      commands_run: [],
      verification_results: ["passed"],
      tool_results: [],
      outcome: "success",
      quality_signals: { command_success: true },
    })
    const coderB = createTrajectoryRecord({
      run_id: "run-polluted-path",
      task_id: "coder_b",
      agent: "coder",
      action_summary: "write b",
      expected_outputs: [],
      actual_outputs: ["done"],
      artifact_paths: ["20/0"],
      commands_run: [],
      verification_results: ["passed"],
      tool_results: [],
      outcome: "success",
      quality_signals: { command_success: true },
    })
    const proposals = deriveLessonProposalsFromTrajectory([coderA, coderB], { run_id: "run-polluted-path" })
    expect(proposals.some((item) => item.proposed_type === "project_convention")).toBe(false)
    expect(proposals.flatMap((item) => item.evidence).join(" ")).not.toContain("39/0")
  })

  test("capability guard: coder trajectory cannot emit tester/reviewer/selfcheck/drift signals", () => {
    const coder = createTrajectoryRecord({
      run_id: "run-guard-a",
      task_id: "coder_guard",
      agent: "coder",
      action_summary: "implement change",
      expected_outputs: [],
      actual_outputs: [],
      artifact_paths: [],
      commands_run: [],
      verification_results: ["all requirements verified"],
      tool_results: [],
      outcome: "success",
      quality_signals: {
        tester_passed: true,
        reviewer_approved: true,
        selfcheck_passed: true,
        drift_detected: true,
        command_success: true,
      },
    })
    expect(coder.quality_signals.command_success).toBe(true)
    expect(coder.quality_signals.tester_passed).toBeUndefined()
    expect(coder.quality_signals.reviewer_approved).toBeUndefined()
    expect(coder.quality_signals.selfcheck_passed).toBeUndefined()
    expect(coder.quality_signals.drift_detected).toBeUndefined()
  })

  test("capability guard: tester trajectory can emit tester_passed", () => {
    const tester = createTrajectoryRecord({
      run_id: "run-guard-b",
      task_id: "tester_guard",
      agent: "tester",
      action_summary: "verify requirements",
      expected_outputs: [],
      actual_outputs: [],
      artifact_paths: [],
      commands_run: [],
      verification_results: ["tests passed"],
      tool_results: [],
      outcome: "success",
      quality_signals: {
        tester_passed: true,
        artifact_paths_verified: true,
      },
    })
    expect(tester.quality_signals.tester_passed).toBe(true)
    expect(tester.quality_signals.artifact_paths_verified).toBe(true)
  })

  test("capability guard: reviewer trajectory can emit reviewer_approved", () => {
    const reviewer = createTrajectoryRecord({
      run_id: "run-guard-c",
      task_id: "reviewer_guard",
      agent: "reviewer",
      action_summary: "review evidence",
      expected_outputs: [],
      actual_outputs: [],
      artifact_paths: [],
      commands_run: [],
      verification_results: ["approved"],
      tool_results: [],
      outcome: "success",
      quality_signals: {
        reviewer_approved: true,
      },
    })
    expect(reviewer.quality_signals.reviewer_approved).toBe(true)
  })
})
