import type * as SessionClosedLoop from "@/session/closed-loop"

export type ReplanProposal = {
  id: string
  run_id: string
  source: "tester" | "reviewer" | "selfcheck" | "orchestrator"
  failed_task_id?: string
  failed_agent?: string
  failure_signal: string
  current_state_summary: string
  preserve_task_ids: string[]
  retry_task_ids: string[]
  replace_task_ids: string[]
  add_tasks: Array<{
    id: string
    task_role: "coder" | "tester" | "reviewer" | "research"
    description: string
    blockedBy: string[]
    tags: string[]
  }>
  rationale: string[]
  confidence: number
  created_at: string
}

export type ReplanNode = Pick<SessionClosedLoop.TaskNode, "id" | "task_role" | "description" | "blockedBy" | "tags">

export type DeriveReplanProposalInput = {
  run_id: string
  source: ReplanProposal["source"]
  normalized_graph?: { nodes: ReplanNode[] }
  completed_task_ids?: string[]
  failed_task_id?: string
  failed_agent?: string
  failure_signal: string
  current_state_summary?: string
  intent_anchor?: string
  evidence?: string[]
}

function compactText(input: string | undefined, max = 220) {
  if (!input) return ""
  const normalized = input.replace(/\s+/g, " ").trim()
  if (!normalized) return ""
  if (normalized.length <= max) return normalized
  return `${normalized.slice(0, Math.max(0, max - 15)).trimEnd()}...[truncated]`
}

function uniqueStrings(values: string[]) {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))]
}

function tokenize(text: string) {
  return [
    ...new Set(
      text
        .toLowerCase()
        .replace(/[^a-z0-9\u4e00-\u9fff\s._/-]+/g, " ")
        .split(/\s+/)
        .map((item) => item.trim())
        .filter((item) => item.length > 1),
    ),
  ]
}

function overlapCount(left: string[], right: string[]) {
  const rightSet = new Set(right)
  return left.filter((item) => rightSet.has(item)).length
}

function deterministicID(input: { runID: string; source: ReplanProposal["source"]; failedTaskID?: string; failureSignal: string }) {
  const base = `${input.runID}|${input.source}|${input.failedTaskID ?? "none"}|${input.failureSignal.toLowerCase()}`
  let hash = 2166136261
  for (let index = 0; index < base.length; index += 1) {
    hash ^= base.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return `replan:${(hash >>> 0).toString(16)}`
}

function isTransientProviderError(signal: string) {
  const text = signal.toLowerCase()
  if (!text) return false
  return [
    "rate limit",
    "too many requests",
    "provider",
    "model unavailable",
    "network error",
    "connection reset",
    "timeout",
    "server error",
    "429",
    "503",
  ].some((keyword) => text.includes(keyword))
}

function isMissingArtifactOrWrongPath(signal: string) {
  const text = signal.toLowerCase()
  return [
    "wrong path",
    "path mismatch",
    "no such file",
    "not found",
    "missing artifact",
    "artifact missing",
    "failed verification",
    "verification failed",
    "checksum mismatch",
    "fingerprint mismatch",
    "证书",
    "路径错误",
    "找不到文件",
    "验证失败",
  ].some((keyword) => text.includes(keyword))
}

function isTesterMissingImplementation(signal: string, source: ReplanProposal["source"]) {
  if (source !== "tester") return false
  const text = signal.toLowerCase()
  return [
    "missing implementation",
    "not implemented",
    "implementation missing",
    "stub",
    "todo",
    "未实现",
    "缺少实现",
  ].some((keyword) => text.includes(keyword))
}

function isReviewerGap(signal: string, source: ReplanProposal["source"]) {
  if (source !== "reviewer") return false
  const text = signal.toLowerCase()
  return [
    "reviewer requested fixes",
    "acceptance gap",
    "requirements not met",
    "missing verification",
    "insufficient evidence",
    "rejected",
    "验收",
    "缺少验证",
    "不通过",
  ].some((keyword) => text.includes(keyword))
}

function clampConfidence(value: number) {
  if (value < 0) return 0
  if (value > 1) return 1
  return value
}

function stateSummary(input: {
  graphNodes: ReplanNode[]
  completedTaskIDs: string[]
  failedTaskID?: string
  failureSignal: string
  intentAnchor?: string
  currentStateSummary?: string
}) {
  const explicit = compactText(input.currentStateSummary, 220)
  if (explicit) return explicit
  return compactText(
    [
      `graph_nodes=${input.graphNodes.length}`,
      `completed=${input.completedTaskIDs.length}`,
      input.failedTaskID ? `failed_task=${input.failedTaskID}` : "",
      `failure=${compactText(input.failureSignal, 120)}`,
      input.intentAnchor ? `intent=${compactText(input.intentAnchor, 80)}` : "",
    ]
      .filter(Boolean)
      .join("; "),
    260,
  )
}

function relatedTaskIDs(input: { graphNodes: ReplanNode[]; failureSignal: string; failedTaskID?: string }) {
  const failed = input.failedTaskID ? input.graphNodes.find((node) => node.id === input.failedTaskID) : undefined
  const failedTokens = tokenize(
    [failed?.description ?? "", ...(failed?.tags ?? []), input.failureSignal]
      .filter(Boolean)
      .join(" "),
  )
  const byOverlap = input.graphNodes
    .filter((node) => {
      const nodeTokens = tokenize(`${node.description} ${(node.tags ?? []).join(" ")}`)
      return overlapCount(nodeTokens, failedTokens) >= 2
    })
    .map((node) => node.id)
  return uniqueStrings([...(failed ? [failed.id] : []), ...byOverlap])
}

function coderRepairDescription(signal: string) {
  if (isMissingArtifactOrWrongPath(signal)) {
    return "Repair implementation for artifact/path mismatch and produce verifiable outputs."
  }
  return "Repair implementation based on failure signal and ensure outputs satisfy verification."
}

function testerVerifyDescription(signal: string) {
  if (isMissingArtifactOrWrongPath(signal)) {
    return "Verify corrected artifact paths and rerun requirement checks."
  }
  return "Rerun verification for repaired implementation and confirm requirements."
}

function reviewerRecheckDescription() {
  return "Re-review repaired outputs and tester evidence for acceptance."
}

function addTaskID(seed: string, index: number) {
  return `replan_${seed}_${index + 1}`
}

export function deriveReplanProposalFromFailure(input: DeriveReplanProposalInput): ReplanProposal | undefined {
  const failureSignal = compactText(input.failure_signal, 280)
  if (!failureSignal) return
  if (isTransientProviderError(failureSignal)) return
  const graphNodes = input.normalized_graph?.nodes ?? []
  const completedTaskIDs = uniqueStrings(input.completed_task_ids ?? [])
  const evidence = uniqueStrings((input.evidence ?? []).map((item) => compactText(item, 160)).filter(Boolean) as string[])
  const insufficientEvidence =
    failureSignal.length < 18 &&
    !input.failed_task_id &&
    graphNodes.length === 0 &&
    completedTaskIDs.length === 0 &&
    evidence.length === 0
  if (insufficientEvidence) return

  const relatedIDs = new Set(relatedTaskIDs({ graphNodes, failureSignal, failedTaskID: input.failed_task_id }))
  const preserveTaskIDs = completedTaskIDs.filter((id) => !relatedIDs.has(id))
  const retryTaskIDs: string[] = []
  const replaceTaskIDs: string[] = []
  const addTasks: ReplanProposal["add_tasks"] = []
  const rationale: string[] = []
  const failedNode = input.failed_task_id ? graphNodes.find((node) => node.id === input.failed_task_id) : undefined
  const testerNodes = graphNodes.filter((node) => node.task_role === "tester")
  const reviewerNodes = graphNodes.filter((node) => node.task_role === "reviewer")
  const coderNodes = graphNodes.filter((node) => node.task_role === "coder")
  const failedRole = failedNode?.task_role
  const missingArtifactCase = isMissingArtifactOrWrongPath(failureSignal)
  const testerMissingImplementationCase = isTesterMissingImplementation(failureSignal, input.source)
  const reviewerGapCase = isReviewerGap(failureSignal, input.source)

  if (input.failed_task_id) {
    if (failedRole === "coder") replaceTaskIDs.push(input.failed_task_id)
    if (
      failedRole === "tester" ||
      failedRole === "research" ||
      (failedRole === "reviewer" && !reviewerGapCase)
    ) {
      retryTaskIDs.push(input.failed_task_id)
    }
  }

  if (missingArtifactCase) {
    const candidateCoder = failedRole === "coder" ? failedNode : coderNodes.find((node) => relatedIDs.has(node.id)) ?? coderNodes[0]
    const repairBlockedBy = uniqueStrings(candidateCoder?.blockedBy ?? [])
    const repairTaskID = addTaskID("coder_repair", addTasks.length)
    if (candidateCoder) {
      replaceTaskIDs.push(candidateCoder.id)
      rationale.push(`replace failed/related coder task: ${candidateCoder.id}`)
    } else {
      addTasks.push({
        id: repairTaskID,
        task_role: "coder",
        description: coderRepairDescription(failureSignal),
        blockedBy: repairBlockedBy,
        tags: ["replan", "repair", "artifact-path"],
      })
      rationale.push("add coder repair task because no clear coder replacement node exists")
    }
    const testerBlockedBy = candidateCoder ? [candidateCoder.id] : [repairTaskID]
    const hasTester = testerNodes.length > 0
    if (hasTester) {
      retryTaskIDs.push(...testerNodes.map((node) => node.id))
      rationale.push("retry tester tasks after artifact/path repair")
    } else {
      addTasks.push({
        id: addTaskID("tester_verify", addTasks.length),
        task_role: "tester",
        description: testerVerifyDescription(failureSignal),
        blockedBy: testerBlockedBy,
        tags: ["replan", "verify", "artifact-path"],
      })
      rationale.push("add tester verification task because tester node is missing")
    }
  }

  if (testerMissingImplementationCase) {
    const blockedBy = uniqueStrings(
      failedNode?.blockedBy.filter((id) => graphNodes.some((node) => node.id === id && node.task_role !== "tester")) ?? [],
    )
    const coderRepairID = addTaskID("coder_repair", addTasks.length)
    addTasks.push({
      id: coderRepairID,
      task_role: "coder",
      description: "Implement missing functionality required by tester failures.",
      blockedBy,
      tags: ["replan", "repair", "implementation-gap"],
    })
    const testerRetryID = failedNode?.id ?? testerNodes[0]?.id
    if (testerRetryID) {
      retryTaskIDs.push(testerRetryID)
    } else {
      addTasks.push({
        id: addTaskID("tester_verify", addTasks.length),
        task_role: "tester",
        description: testerVerifyDescription(failureSignal),
        blockedBy: [coderRepairID],
        tags: ["replan", "verify", "implementation-gap"],
      })
    }
    rationale.push("tester reported missing implementation; add coder repair then tester verification")
  }

  if (reviewerGapCase) {
    const blockedBy = uniqueStrings(
      failedNode?.blockedBy.filter((id) => graphNodes.some((node) => node.id === id && node.task_role !== "reviewer")) ?? [],
    )
    const coderRepairID = addTaskID("coder_repair", addTasks.length)
    addTasks.push({
      id: coderRepairID,
      task_role: "coder",
      description: "Repair implementation gaps identified by defect findings.",
      blockedBy,
      tags: ["replan", "repair", "defect-gap"],
    })
    const testerVerifyID = addTaskID("tester_verify", addTasks.length)
    addTasks.push({
      id: testerVerifyID,
      task_role: "tester",
      description: "Verify reviewer-requested fixes against requirements.",
      blockedBy: [coderRepairID],
      tags: ["replan", "verify", "review-gap"],
    })
    addTasks.push({
      id: addTaskID("reviewer_recheck", addTasks.length),
      task_role: "reviewer",
      description: reviewerRecheckDescription(),
      blockedBy: [testerVerifyID],
      tags: ["replan", "recheck", "review-gap"],
    })
    rationale.push("add reviewer recheck task after repair coder and tester verification")
  }

  if (!missingArtifactCase && !testerMissingImplementationCase && !reviewerGapCase) {
    if (failedNode?.task_role === "tester" || failedNode?.task_role === "reviewer") {
      retryTaskIDs.push(failedNode.id)
      rationale.push(`retry failed ${failedNode.task_role} task`)
    }
    if (failedNode?.task_role === "coder") {
      replaceTaskIDs.push(failedNode.id)
      rationale.push("replace failed coder task")
    }
  }

  const dedupedRetry = uniqueStrings(retryTaskIDs).filter((id) => !replaceTaskIDs.includes(id))
  const dedupedReplace = uniqueStrings(replaceTaskIDs)
  const dedupedAddTasks = addTasks.filter((task, index, array) => array.findIndex((item) => item.id === task.id) === index)
  const confidenceBase =
    (missingArtifactCase ? 0.76 : testerMissingImplementationCase || reviewerGapCase ? 0.72 : 0.58) +
    (input.failed_task_id ? 0.08 : 0) +
    (evidence.length > 0 ? 0.08 : 0) +
    (graphNodes.length > 0 ? 0.05 : 0)
  const confidence = clampConfidence(confidenceBase)
  const hasAction =
    dedupedRetry.length > 0 || dedupedReplace.length > 0 || dedupedAddTasks.length > 0 || preserveTaskIDs.length > 0
  if (!hasAction) return

  return {
    id: deterministicID({
      runID: input.run_id,
      source: input.source,
      failedTaskID: input.failed_task_id,
      failureSignal,
    }),
    run_id: input.run_id,
    source: input.source,
    failed_task_id: input.failed_task_id,
    failed_agent: input.failed_agent,
    failure_signal: failureSignal,
    current_state_summary: stateSummary({
      graphNodes,
      completedTaskIDs,
      failedTaskID: input.failed_task_id,
      failureSignal,
      intentAnchor: input.intent_anchor,
      currentStateSummary: input.current_state_summary,
    }),
    preserve_task_ids: preserveTaskIDs,
    retry_task_ids: dedupedRetry,
    replace_task_ids: dedupedReplace,
    add_tasks: dedupedAddTasks,
    rationale: uniqueStrings(rationale.length > 0 ? rationale : ["insufficient deterministic mapping; keep minimal retry/replace plan"]),
    confidence,
    created_at: new Date().toISOString(),
  }
}

export function formatReplanProposalForPrompt(
  proposal: ReplanProposal | undefined,
  input: { includeNone?: boolean } = {},
) {
  if (!proposal) {
    if (input.includeNone) return ["Replan proposal:", "- none"].join("\n")
    return ""
  }
  const addTaskLines =
    proposal.add_tasks.length === 0
      ? ["- none"]
      : proposal.add_tasks.flatMap((task) => [
          `- ${task.id} [${task.task_role}] ${compactText(task.description, 140)}`,
          `  blockedBy: ${task.blockedBy.length > 0 ? task.blockedBy.join(", ") : "[]"}`,
          `  tags: ${task.tags.length > 0 ? task.tags.join(", ") : "none"}`,
        ])
  return [
    "Replan proposal:",
    `- Failure: ${proposal.failure_signal}`,
    `- Preserve: ${proposal.preserve_task_ids.length > 0 ? proposal.preserve_task_ids.join(", ") : "none"}`,
    `- Retry: ${proposal.retry_task_ids.length > 0 ? proposal.retry_task_ids.join(", ") : "none"}`,
    `- Replace: ${proposal.replace_task_ids.length > 0 ? proposal.replace_task_ids.join(", ") : "none"}`,
    "- Add tasks:",
    ...addTaskLines,
    `- Rationale: ${proposal.rationale.join(" | ")}`,
    `- Confidence: ${proposal.confidence.toFixed(2)}`,
  ].join("\n")
}
