import { describe, expect, test } from "bun:test"
import { deriveReplanProposalFromFailure } from "@/session/replan"
import {
  applyTaskGraphPatch,
  collectRepairSubtree,
  deriveTaskGraphPatchFromReplanProposal,
  type TaskGraph,
  validateTaskGraphPatch,
} from "@/session/taskgraph-patch"

function baseGraph(): TaskGraph {
  return {
    nodes: [
      {
        id: "impl",
        task_role: "coder",
        agent: "coder",
        description: "Implement feature",
        blockedBy: [],
        tags: ["impl"],
        run_id: "run-1",
      },
      {
        id: "test_impl",
        task_role: "tester",
        agent: "tester",
        description: "Run tests",
        blockedBy: ["impl"],
        tags: ["test"],
        run_id: "run-1",
      },
      {
        id: "review_impl",
        task_role: "reviewer",
        agent: "reviewer",
        description: "Review acceptance",
        blockedBy: ["test_impl"],
        tags: ["review"],
        run_id: "run-1",
      },
      {
        id: "write",
        task_role: "writer",
        agent: "writer",
        description: "Write changelog",
        blockedBy: ["review_impl"],
        tags: ["writer"],
        run_id: "run-1",
      },
    ],
  }
}

describe("session.taskgraph-patch", () => {
  test("wrong path failure adds coder repair and tester verification patch ops", () => {
    const proposal = deriveReplanProposalFromFailure({
      run_id: "run-1",
      source: "tester",
      failed_task_id: "test_impl",
      failed_agent: "tester",
      failure_signal: "wrong path and artifact missing verification failed",
      normalized_graph: {
        nodes: baseGraph().nodes.map((node) => ({
          id: node.id,
          task_role: node.task_role,
          description: node.description,
          blockedBy: node.blockedBy,
          tags: node.tags,
        })),
      },
      completed_task_ids: ["impl"],
    })
    const patch = deriveTaskGraphPatchFromReplanProposal(proposal, baseGraph(), ["impl"], { minConfidence: 0.6 })
    expect(patch).toBeDefined()
    expect(patch!.operations.some((op) => op.op === "replace" || op.op === "add")).toBe(true)
    expect(patch!.operations.some((op) => op.op === "retry" && op.target_id === "test_impl")).toBe(true)
  })

  test("missing implementation failure adds coder repair", () => {
    const proposal = deriveReplanProposalFromFailure({
      run_id: "run-1",
      source: "tester",
      failed_task_id: "test_impl",
      failure_signal: "missing implementation not implemented",
      normalized_graph: {
        nodes: baseGraph().nodes.map((node) => ({
          id: node.id,
          task_role: node.task_role,
          description: node.description,
          blockedBy: node.blockedBy,
          tags: node.tags,
        })),
      },
      completed_task_ids: ["impl"],
    })
    const patch = deriveTaskGraphPatchFromReplanProposal(proposal, baseGraph(), ["impl"], { minConfidence: 0.6 })
    expect(patch).toBeDefined()
    expect(patch!.operations.some((op) => op.op === "add" && op.node.task_role === "coder")).toBe(true)
  })

  test("reviewer rejection with unsafe ordering yields no automatic patch", () => {
    const proposal = {
      id: "replan-reviewer-1",
      run_id: "run-1",
      source: "reviewer" as const,
      failed_task_id: "review_impl",
      failed_agent: "reviewer",
      failure_signal: "reviewer requested fixes",
      current_state_summary: "review failed",
      preserve_task_ids: ["impl"],
      retry_task_ids: ["review_impl"],
      replace_task_ids: [],
      add_tasks: [
        {
          id: "repair_impl",
          task_role: "coder" as const,
          description: "Repair implementation based on reviewer findings",
          blockedBy: [],
          tags: ["replan", "repair"],
        },
      ],
      rationale: ["reviewer recheck required"],
      confidence: 0.82,
      created_at: new Date().toISOString(),
    }
    const patch = deriveTaskGraphPatchFromReplanProposal(proposal, baseGraph(), [], { minConfidence: 0.6 })
    expect(patch).toBeUndefined()
  })

  test("reviewer rejection proposal serializes repair coder -> tester reverify -> reviewer recheck", () => {
    const proposal = deriveReplanProposalFromFailure({
      run_id: "run-1",
      source: "reviewer",
      failed_task_id: "review_impl",
      failed_agent: "reviewer",
      failure_signal: "reviewer requested fixes due to missing verification evidence",
      normalized_graph: {
        nodes: baseGraph().nodes.map((node) => ({
          id: node.id,
          task_role: node.task_role,
          description: node.description,
          blockedBy: node.blockedBy,
          tags: node.tags,
        })),
      },
      completed_task_ids: ["impl", "test_impl"],
      evidence: ["review notes: requirement proof missing"],
    })
    const patch = deriveTaskGraphPatchFromReplanProposal(proposal, baseGraph(), ["impl", "test_impl"], {
      minConfidence: 0.6,
    })
    expect(patch).toBeDefined()
    if (!patch) return
    expect(patch.operations.some((op) => op.op === "retry" && op.target_id === "review_impl")).toBe(false)
    const added = patch.operations.flatMap((op) => (op.op === "add" ? [op.node] : []))
    const repairCoder = added.find((node) => node.task_role === "coder")
    const testerReverify = added.find((node) => node.task_role === "tester")
    const reviewerRecheck = added.find((node) => node.task_role === "reviewer")
    expect(repairCoder).toBeDefined()
    expect(testerReverify).toBeDefined()
    expect(reviewerRecheck).toBeDefined()
    if (!repairCoder || !testerReverify || !reviewerRecheck) return
    expect(testerReverify.blockedBy).toContain(repairCoder.id)
    expect(reviewerRecheck.blockedBy).toContain(testerReverify.id)
  })

  test("validate rejects cycles", () => {
    const patch = {
      id: "patch-cycle",
      run_id: "run-1",
      source_replan_id: "replan-1",
      confidence: 0.8,
      rationale: ["test"],
      created_at: new Date().toISOString(),
      operations: [
        {
          op: "add" as const,
          node: {
            id: "cycle_node",
            task_role: "coder" as const,
            agent: "coder",
            description: "cycle",
            blockedBy: ["review_impl", "cycle_node"],
            tags: ["impl"],
            run_id: "run-1",
          },
        },
      ],
    }
    const validation = validateTaskGraphPatch(patch, baseGraph(), { completedTaskIDs: [] })
    expect(validation.valid).toBe(false)
    expect(validation.errors.join("\n")).toContain("cycle")
  })

  test("validate rejects coder final verification", () => {
    const patch = {
      id: "patch-coder-final",
      run_id: "run-1",
      source_replan_id: "replan-1",
      confidence: 0.8,
      rationale: ["test"],
      created_at: new Date().toISOString(),
      operations: [
        {
          op: "add" as const,
          node: {
            id: "coder_final",
            task_role: "coder" as const,
            agent: "coder",
            description: "Final verification and acceptance",
            blockedBy: ["impl"],
            tags: ["final", "verify"],
            run_id: "run-1",
          },
        },
      ],
    }
    const validation = validateTaskGraphPatch(patch, baseGraph(), { completedTaskIDs: [] })
    expect(validation.valid).toBe(false)
    expect(validation.errors.join("\n")).toContain("coder")
  })

  test("patch preserves unrelated completed nodes", () => {
    const proposal = deriveReplanProposalFromFailure({
      run_id: "run-1",
      source: "tester",
      failed_task_id: "test_impl",
      failure_signal: "wrong path artifact missing",
      normalized_graph: {
        nodes: baseGraph().nodes.map((node) => ({
          id: node.id,
          task_role: node.task_role,
          description: node.description,
          blockedBy: node.blockedBy,
          tags: node.tags,
        })),
      },
      completed_task_ids: ["impl"],
    })
    const patch = deriveTaskGraphPatchFromReplanProposal(proposal, baseGraph(), ["impl"], { minConfidence: 0.6 })
    expect(patch).toBeDefined()
    expect(patch!.operations.some((op) => op.op === "preserve" && op.target_id === "impl")).toBe(true)
  })

  test("apply patch updates downstream blockedBy", () => {
    const patch = {
      id: "patch-replace",
      run_id: "run-1",
      source_replan_id: "replan-1",
      confidence: 0.9,
      rationale: ["replace impl"],
      created_at: new Date().toISOString(),
      operations: [
        {
          op: "replace" as const,
          target_id: "impl",
          node: {
            id: "impl_repair",
            task_role: "coder" as const,
            agent: "coder",
            description: "Repair impl",
            blockedBy: [],
            tags: ["repair"],
            run_id: "run-1",
          },
        },
      ],
    }
    const applied = applyTaskGraphPatch(baseGraph(), patch)
    expect(applied.applied).toBe(true)
    const tester = applied.graph.nodes.find((node) => node.id === "test_impl")
    expect(tester?.blockedBy).toContain("impl_repair")
  })

  test("apply patch keeps preserved completed nodes untouched", () => {
    const patch = {
      id: "patch-preserve",
      run_id: "run-1",
      source_replan_id: "replan-1",
      confidence: 0.9,
      rationale: ["preserve"],
      created_at: new Date().toISOString(),
      operations: [
        { op: "preserve" as const, target_id: "impl" },
        { op: "retry" as const, target_id: "test_impl" },
      ],
    }
    const applied = applyTaskGraphPatch(baseGraph(), patch, { completedTaskIDs: ["impl"] })
    expect(applied.applied).toBe(true)
    expect(applied.affectedTaskIDs).toContain("test_impl")
    expect(applied.affectedTaskIDs).not.toContain("impl")
  })

  test("collectRepairSubtree includes downstream dependencies", () => {
    const tree = collectRepairSubtree(baseGraph(), ["impl"])
    expect(tree.nodes.map((node) => node.id)).toContain("impl")
    expect(tree.nodes.map((node) => node.id)).toContain("test_impl")
    expect(tree.nodes.map((node) => node.id)).toContain("review_impl")
  })

  test("low-confidence proposal returns undefined patch", () => {
    const proposal = {
      id: "r1",
      run_id: "run-1",
      source: "tester" as const,
      failure_signal: "minor",
      current_state_summary: "s",
      preserve_task_ids: [],
      retry_task_ids: ["test_impl"],
      replace_task_ids: [],
      add_tasks: [],
      rationale: ["x"],
      confidence: 0.2,
      created_at: new Date().toISOString(),
    }
    const patch = deriveTaskGraphPatchFromReplanProposal(proposal, baseGraph(), [], { minConfidence: 0.6 })
    expect(patch).toBeUndefined()
  })
})
