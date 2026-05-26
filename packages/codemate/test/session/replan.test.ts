import { describe, expect, test } from "bun:test"
import { deriveReplanProposalFromFailure, formatReplanProposalForPrompt } from "@/session/replan"

function baseGraph() {
  return {
    nodes: [
      {
        id: "research_tls",
        task_role: "research" as const,
        description: "Research TLS cert path requirements",
        blockedBy: [],
        tags: ["research", "tls"],
      },
      {
        id: "impl_cert",
        task_role: "coder" as const,
        description: "Create TLS certificate artifacts under expected path",
        blockedBy: ["research_tls"],
        tags: ["impl", "tls", "cert", "path"],
      },
      {
        id: "test_tls",
        task_role: "tester" as const,
        description: "Verify TLS certificates and artifact paths",
        blockedBy: ["impl_cert"],
        tags: ["test", "tls", "verify", "path"],
      },
      {
        id: "review_tls",
        task_role: "reviewer" as const,
        description: "Review TLS verification evidence",
        blockedBy: ["test_tls"],
        tags: ["review", "tls"],
      },
    ],
  }
}

describe("session.replan", () => {
  test("wrong path failure generates repair coder + tester verify proposal", () => {
    const proposal = deriveReplanProposalFromFailure({
      run_id: "run-replan-a",
      source: "tester",
      normalized_graph: baseGraph(),
      completed_task_ids: ["research_tls"],
      failed_task_id: "test_tls",
      failed_agent: "tester",
      failure_signal: "wrong path used for TLS artifacts; verification failed",
      evidence: ["wrong path -> corrected path pending"],
    })
    expect(proposal).toBeDefined()
    if (!proposal) return
    expect(proposal.replace_task_ids).toContain("impl_cert")
    expect(proposal.retry_task_ids).toContain("test_tls")
    expect(proposal.confidence).toBeGreaterThan(0.6)
  })

  test("tester reports missing implementation generates coder repair task", () => {
    const proposal = deriveReplanProposalFromFailure({
      run_id: "run-replan-b",
      source: "tester",
      normalized_graph: {
        nodes: [
          {
            id: "test_impl",
            task_role: "tester",
            description: "Verify implemented parser behavior",
            blockedBy: [],
            tags: ["test", "parser"],
          },
        ],
      },
      completed_task_ids: [],
      failed_task_id: "test_impl",
      failed_agent: "tester",
      failure_signal: "missing implementation in parser branch; tester failed",
      evidence: ["not implemented error thrown"],
    })
    expect(proposal).toBeDefined()
    if (!proposal) return
    expect(proposal.add_tasks.some((task) => task.task_role === "coder")).toBe(true)
    expect(proposal.retry_task_ids).toContain("test_impl")
  })

  test("reviewer rejects output generates coder repair + tester + reviewer recheck", () => {
    const proposal = deriveReplanProposalFromFailure({
      run_id: "run-replan-c",
      source: "reviewer",
      normalized_graph: baseGraph(),
      completed_task_ids: ["research_tls", "impl_cert", "test_tls"],
      failed_task_id: "review_tls",
      failed_agent: "reviewer",
      failure_signal: "reviewer requested fixes due to missing verification evidence",
      evidence: ["acceptance gap: requirement 2 not proven"],
    })
    expect(proposal).toBeDefined()
    if (!proposal) return
    expect(proposal.add_tasks.some((task) => task.task_role === "coder")).toBe(true)
    expect(proposal.add_tasks.some((task) => task.task_role === "tester")).toBe(true)
    expect(proposal.add_tasks.some((task) => task.task_role === "reviewer")).toBe(true)
    expect(proposal.retry_task_ids).not.toContain("review_tls")
  })

  test("transient provider error does not generate replan", () => {
    const proposal = deriveReplanProposalFromFailure({
      run_id: "run-replan-d",
      source: "selfcheck",
      failure_signal: "provider timeout with 429 rate limit",
    })
    expect(proposal).toBeUndefined()
  })

  test("completed unrelated tasks are preserved", () => {
    const proposal = deriveReplanProposalFromFailure({
      run_id: "run-replan-e",
      source: "tester",
      normalized_graph: {
        nodes: [
          ...baseGraph().nodes,
          {
            id: "impl_docs",
            task_role: "coder",
            description: "Update docs examples",
            blockedBy: [],
            tags: ["docs"],
          },
        ],
      },
      completed_task_ids: ["research_tls", "impl_docs"],
      failed_task_id: "test_tls",
      failed_agent: "tester",
      failure_signal: "verification failed with wrong path",
      evidence: ["wrong path in tls only"],
    })
    expect(proposal).toBeDefined()
    if (!proposal) return
    expect(proposal.preserve_task_ids).toContain("impl_docs")
  })

  test("low evidence returns undefined", () => {
    const proposal = deriveReplanProposalFromFailure({
      run_id: "run-replan-f",
      source: "orchestrator",
      failure_signal: "failed",
    })
    expect(proposal).toBeUndefined()
  })

  test("prompt payload includes proposal when available", () => {
    const proposal = deriveReplanProposalFromFailure({
      run_id: "run-replan-g",
      source: "tester",
      normalized_graph: baseGraph(),
      completed_task_ids: ["research_tls"],
      failed_task_id: "test_tls",
      failed_agent: "tester",
      failure_signal: "wrong path mismatch caused failed verification",
      evidence: ["wrong path used"],
    })
    const text = formatReplanProposalForPrompt(proposal)
    expect(text).toContain("Replan proposal:")
    expect(text).toContain("- Failure:")
    expect(text).toContain("- Preserve:")
    expect(text).toContain("- Retry:")
    expect(text).toContain("- Replace:")
    expect(text).toContain("- Add tasks:")
    expect(text).toContain("- Rationale:")
    expect(text).toContain("- Confidence:")
  })

  test("no proposal on success path", () => {
    const text = formatReplanProposalForPrompt(undefined)
    expect(text).toBe("")
    const withNone = formatReplanProposalForPrompt(undefined, { includeNone: true })
    expect(withNone).toContain("- none")
  })
})
