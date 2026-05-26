import type { MessageID } from "@/session/schema"
import type { ReplanProposal } from "@/session/replan"

export type TaskGraphNodeRole = "planner" | "coder" | "tester" | "research" | "reviewer" | "writer"

export type TaskGraphNode = {
  id: string
  task_role: TaskGraphNodeRole
  agent: string
  description: string
  blockedBy: string[]
  tags: string[]
  needsResearch?: boolean
  run_id?: string
  source_user_message_id?: MessageID
  intent_anchor_hash?: string
}

export type TaskGraph = {
  nodes: TaskGraphNode[]
}

export type TaskGraphPatchOperation =
  | { op: "add"; node: TaskGraphNode }
  | { op: "replace"; target_id: string; node: TaskGraphNode }
  | { op: "retry"; target_id: string }
  | { op: "preserve"; target_id: string }
  | { op: "remove"; target_id: string }

export type TaskGraphPatch = {
  id: string
  run_id: string
  source_replan_id: string
  operations: TaskGraphPatchOperation[]
  rationale: string[]
  confidence: number
  created_at: string
}

export type TaskGraphPatchValidation = {
  valid: boolean
  errors: string[]
  warnings: string[]
}

const FINAL_VERIFY_HINTS = ["final", "acceptance", "verify", "verification", "review", "requirement", "selfcheck"]

function compact(input: string | undefined) {
  if (!input) return ""
  return input.trim()
}

function normalizeID(value: string | undefined) {
  const id = compact(value)
  return id.length > 0 ? id : undefined
}

function normalizeList(values: string[] | undefined) {
  return [...new Set((values ?? []).map((value) => compact(value)).filter((value) => value.length > 0))]
}

function roleAgent(role: TaskGraphNodeRole) {
  return role
}

function isReplacedNode(node: TaskGraphNode) {
  return node.tags.includes("replaced")
}

function cloneNode(node: TaskGraphNode): TaskGraphNode {
  return {
    ...node,
    blockedBy: [...node.blockedBy],
    tags: [...node.tags],
  }
}

function topologicalOrder(graph: TaskGraph) {
  const indegree = new Map<string, number>()
  const out = new Map<string, string[]>()
  for (const node of graph.nodes) {
    indegree.set(node.id, node.blockedBy.length)
    for (const dep of node.blockedBy) {
      const prev = out.get(dep) ?? []
      out.set(dep, [...prev, node.id])
    }
  }
  const ready = [...graph.nodes.filter((node) => (indegree.get(node.id) ?? 0) === 0).map((node) => node.id)].sort()
  const order: string[] = []
  while (ready.length > 0) {
    const current = ready.shift()!
    order.push(current)
    for (const next of out.get(current) ?? []) {
      const value = (indegree.get(next) ?? 0) - 1
      indegree.set(next, value)
      if (value === 0) {
        ready.push(next)
        ready.sort()
      }
    }
  }
  return {
    order,
    hasCycle: order.length !== graph.nodes.length,
  }
}

function isFinalVerificationNode(node: TaskGraphNode) {
  const text = `${node.description} ${node.tags.join(" ")}`.toLowerCase()
  return FINAL_VERIFY_HINTS.some((keyword) => text.includes(keyword))
}

function applyPatchInternal(graph: TaskGraph, patch: TaskGraphPatch) {
  const nodes = graph.nodes.map(cloneNode)
  const byID = new Map(nodes.map((node) => [node.id, node] as const))
  const replacedMap = new Map<string, string>()
  const warnings: string[] = []

  for (const operation of patch.operations) {
    if (operation.op === "add") {
      if (byID.has(operation.node.id)) {
        warnings.push(`add operation skipped; node already exists: ${operation.node.id}`)
        continue
      }
      const node = cloneNode(operation.node)
      nodes.push(node)
      byID.set(node.id, node)
      continue
    }

    if (operation.op === "replace") {
      const target = byID.get(operation.target_id)
      if (!target) {
        warnings.push(`replace operation skipped; target missing: ${operation.target_id}`)
        continue
      }
      if (byID.has(operation.node.id)) {
        warnings.push(`replace operation skipped; replacement id exists: ${operation.node.id}`)
        continue
      }
      const replacement = cloneNode(operation.node)
      nodes.push(replacement)
      byID.set(replacement.id, replacement)
      replacedMap.set(operation.target_id, replacement.id)
      target.tags = normalizeList([...target.tags, "replaced"])
      continue
    }

    if (operation.op === "remove") {
      const index = nodes.findIndex((node) => node.id === operation.target_id)
      if (index < 0) {
        warnings.push(`remove operation skipped; target missing: ${operation.target_id}`)
        continue
      }
      nodes.splice(index, 1)
      byID.delete(operation.target_id)
      continue
    }
  }

  if (replacedMap.size > 0) {
    for (const node of nodes) {
      node.blockedBy = normalizeList(node.blockedBy.map((id) => replacedMap.get(id) ?? id).filter((id) => id !== node.id))
    }
  }

  const removed = new Set(
    patch.operations.flatMap((operation) =>
      operation.op === "remove" ? [operation.target_id] : [],
    ),
  )
  if (removed.size > 0) {
    for (const node of nodes) {
      node.blockedBy = normalizeList(node.blockedBy.filter((id) => !removed.has(id) && id !== node.id))
    }
  }

  return {
    graph: { nodes },
    warnings,
  }
}

export function deriveTaskGraphPatchFromReplanProposal(
  proposal: ReplanProposal | undefined,
  graph: TaskGraph,
  completedTaskIDs: string[],
  input: { minConfidence?: number } = {},
): TaskGraphPatch | undefined {
  if (!proposal) return
  const minConfidence = input.minConfidence ?? 0.6
  if (proposal.confidence < minConfidence) return

  const byID = new Map(graph.nodes.map((node) => [node.id, node] as const))
  const operations: TaskGraphPatchOperation[] = []

  for (const targetID of normalizeList(proposal.preserve_task_ids)) {
    if (!byID.has(targetID)) continue
    operations.push({ op: "preserve", target_id: targetID })
  }

  const retryTargets = normalizeList(proposal.retry_task_ids)
  if (retryTargets.some((id) => !byID.has(id))) return
  for (const targetID of retryTargets) {
    operations.push({ op: "retry", target_id: targetID })
  }

  const replaceTargets = normalizeList(proposal.replace_task_ids)
  if (replaceTargets.some((id) => !byID.has(id))) return

  let replacementIndex = 0
  for (const targetID of replaceTargets) {
    const target = byID.get(targetID)
    if (!target) return
    const nextRole: TaskGraphNodeRole = target.task_role === "writer" ? "writer" : target.task_role
    const node: TaskGraphNode = {
      id: `${target.id}__repair_${replacementIndex + 1}`,
      task_role: nextRole,
      agent: roleAgent(nextRole),
      description: `Repair ${target.task_role} task: ${target.description}`,
      blockedBy: normalizeList(target.blockedBy),
      tags: normalizeList([...target.tags, "replan", "repair"]),
      needsResearch: target.needsResearch,
      run_id: target.run_id,
      source_user_message_id: target.source_user_message_id,
      intent_anchor_hash: target.intent_anchor_hash,
    }
    replacementIndex += 1
    operations.push({ op: "replace", target_id: targetID, node })
  }

  for (const added of proposal.add_tasks) {
    const role = added.task_role
    const node: TaskGraphNode = {
      id: normalizeID(added.id) ?? `replan_add_${operations.length + 1}`,
      task_role: role,
      agent: roleAgent(role),
      description: compact(added.description) || "repair task",
      blockedBy: normalizeList(added.blockedBy),
      tags: normalizeList(added.tags),
      run_id: proposal.run_id,
    }
    operations.push({ op: "add", node })
  }

  if (proposal.source === "reviewer") {
    const reviewerRecheckID = [...proposal.add_tasks]
      .reverse()
      .find((task) => task.task_role === "reviewer")
      ?.id
    if (reviewerRecheckID && byID.has(reviewerRecheckID) === false) {
      let writerReplaceIndex = 0
      for (const writerNode of graph.nodes.filter((node) => node.task_role === "writer")) {
        const nonReviewerDeps = writerNode.blockedBy.filter((dep) => byID.get(dep)?.task_role !== "reviewer")
        const replacement: TaskGraphNode = {
          id: `${writerNode.id}__recheck_${writerReplaceIndex + 1}`,
          task_role: "writer",
          agent: "writer",
          description: writerNode.description,
          blockedBy: normalizeList([...nonReviewerDeps, reviewerRecheckID]),
          tags: normalizeList([...writerNode.tags, "replan", "recheck-gated"]),
          needsResearch: writerNode.needsResearch,
          run_id: writerNode.run_id,
          source_user_message_id: writerNode.source_user_message_id,
          intent_anchor_hash: writerNode.intent_anchor_hash,
        }
        operations.push({ op: "replace", target_id: writerNode.id, node: replacement })
        writerReplaceIndex += 1
      }
    }
  }

  if (operations.length === 0) return

  const validate = validateTaskGraphPatch(
    {
      id: `patch:${proposal.id}`,
      run_id: proposal.run_id,
      source_replan_id: proposal.id,
      operations,
      rationale: normalizeList(proposal.rationale),
      confidence: proposal.confidence,
      created_at: proposal.created_at,
    },
    graph,
    { completedTaskIDs },
  )
  if (!validate.valid) return

  return {
    id: `patch:${proposal.id}`,
    run_id: proposal.run_id,
    source_replan_id: proposal.id,
    operations,
    rationale: normalizeList(proposal.rationale),
    confidence: proposal.confidence,
    created_at: proposal.created_at,
  }
}

export function validateTaskGraphPatch(
  patch: TaskGraphPatch,
  graph: TaskGraph,
  input: { completedTaskIDs?: string[] } = {},
): TaskGraphPatchValidation {
  const errors: string[] = []
  const warnings: string[] = []
  const completed = new Set(normalizeList(input.completedTaskIDs))
  const baseByID = new Map(graph.nodes.map((node) => [node.id, node] as const))

  const seenAdds = new Set<string>()
  const replaceByTarget = new Map<string, TaskGraphNode>()

  for (const operation of patch.operations) {
    if (operation.op === "add") {
      if (baseByID.has(operation.node.id) || seenAdds.has(operation.node.id)) {
        errors.push(`duplicate node id in add operation: ${operation.node.id}`)
      }
      seenAdds.add(operation.node.id)
      if (operation.node.task_role === "coder" && isFinalVerificationNode(operation.node)) {
        errors.push(`coder node cannot be final verification: ${operation.node.id}`)
      }
      continue
    }

    if (operation.op === "replace") {
      const target = baseByID.get(operation.target_id)
      if (!target) {
        errors.push(`replace target does not exist: ${operation.target_id}`)
        continue
      }
      if (replaceByTarget.has(operation.target_id)) {
        errors.push(`duplicate replace target: ${operation.target_id}`)
      }
      replaceByTarget.set(operation.target_id, operation.node)
      if (operation.node.id === operation.target_id) {
        errors.push(`replacement node id must differ from target: ${operation.target_id}`)
      }
      if (seenAdds.has(operation.node.id) || baseByID.has(operation.node.id)) {
        errors.push(`replacement node id collides: ${operation.node.id}`)
      }
      seenAdds.add(operation.node.id)
      if (target.task_role === "writer" && operation.node.task_role !== "writer") {
        errors.push(`writer task cannot be replaced by non-writer: ${operation.target_id}`)
      }
      if (operation.node.task_role === "coder" && isFinalVerificationNode(operation.node)) {
        errors.push(`coder node cannot be final verification: ${operation.node.id}`)
      }
      continue
    }

    if (operation.op === "retry" || operation.op === "preserve" || operation.op === "remove") {
      if (!baseByID.has(operation.target_id)) {
        errors.push(`${operation.op} target does not exist: ${operation.target_id}`)
      }
      if (operation.op === "remove") {
        const target = baseByID.get(operation.target_id)
        if (target?.task_role === "tester" || target?.task_role === "reviewer") {
          errors.push(`cannot remove ${target.task_role} task: ${operation.target_id}`)
        }
        if (target?.task_role === "writer") {
          errors.push(`cannot remove writer task: ${operation.target_id}`)
        }
      }
      if ((operation.op === "retry" || operation.op === "remove") && completed.has(operation.target_id)) {
        errors.push(`patch attempts to mutate completed node without preserve-only semantics: ${operation.target_id}`)
      }
    }
  }

  const preserveSet = new Set(
    patch.operations.flatMap((operation) => (operation.op === "preserve" ? [operation.target_id] : [])),
  )
  for (const completedID of completed) {
    if (!baseByID.has(completedID)) continue
    if (!preserveSet.has(completedID)) {
      warnings.push(`completed node not explicitly preserved: ${completedID}`)
    }
  }

  const simulated = applyPatchInternal(graph, patch)
  warnings.push(...simulated.warnings)
  const nextGraph = simulated.graph

  const idSet = new Set<string>()
  for (const node of nextGraph.nodes) {
    if (idSet.has(node.id)) errors.push(`duplicate node id after patch: ${node.id}`)
    idSet.add(node.id)

    if (patch.run_id && node.run_id && node.run_id !== patch.run_id) {
      errors.push(`run_id mismatch in node ${node.id}: ${node.run_id} != ${patch.run_id}`)
    }

    if (node.task_role === "coder" && isFinalVerificationNode(node)) {
      errors.push(`coder node cannot own final verification: ${node.id}`)
    }

    if (node.tags.includes("parallel") && node.blockedBy.length > 0) {
      warnings.push(`node ${node.id} has parallel tag with blockedBy dependencies; blockedBy takes precedence`)
    }

    for (const dependency of node.blockedBy) {
      if (!idSet.has(dependency) && !nextGraph.nodes.some((item) => item.id === dependency)) {
        errors.push(`node ${node.id} depends on missing node ${dependency}`)
      }
    }
  }

  const topo = topologicalOrder(nextGraph)
  if (topo.hasCycle) {
    errors.push("patched task graph contains cycle")
  }

  if (!topo.hasCycle) {
    const indexByID = new Map(topo.order.map((id, index) => [id, index] as const))
    const activeNodes = nextGraph.nodes.filter((node) => !isReplacedNode(node))
    const testerIndices = activeNodes.filter((node) => node.task_role === "tester").map((node) => indexByID.get(node.id) ?? -1)
    const reviewerIndices = activeNodes.filter((node) => node.task_role === "reviewer").map((node) => indexByID.get(node.id) ?? -1)
    const writerIndices = activeNodes.filter((node) => node.task_role === "writer").map((node) => indexByID.get(node.id) ?? -1)

    if (testerIndices.length > 0 && reviewerIndices.some((index) => index < Math.min(...testerIndices))) {
      errors.push("reviewer tasks appear before tester tasks in execution order")
    }
    const maxVerify = Math.max(...testerIndices, ...reviewerIndices, -1)
    if (writerIndices.some((index) => index <= maxVerify)) {
      errors.push("writer task appears before tester/reviewer completion")
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  }
}

export function applyTaskGraphPatch(
  graph: TaskGraph,
  patch: TaskGraphPatch,
  input: { completedTaskIDs?: string[] } = {},
): {
  graph: TaskGraph
  applied: boolean
  warnings: string[]
  affectedTaskIDs: string[]
} {
  const validation = validateTaskGraphPatch(patch, graph, input)
  if (!validation.valid) {
    return {
      graph,
      applied: false,
      warnings: validation.errors,
      affectedTaskIDs: [],
    }
  }

  const applied = applyPatchInternal(graph, patch)
  const affected = new Set<string>()
  for (const operation of patch.operations) {
    if (operation.op === "retry") affected.add(operation.target_id)
    if (operation.op === "replace") {
      affected.add(operation.target_id)
      affected.add(operation.node.id)
    }
    if (operation.op === "add") affected.add(operation.node.id)
  }
  return {
    graph: applied.graph,
    applied: true,
    warnings: [...validation.warnings, ...applied.warnings],
    affectedTaskIDs: [...affected],
  }
}

export function collectRepairSubtree(graph: TaskGraph, seeds: string[]) {
  const seedSet = new Set(normalizeList(seeds))
  if (seedSet.size === 0) return { nodes: [] as TaskGraphNode[] }
  const dependents = new Map<string, string[]>()
  for (const node of graph.nodes) {
    for (const dependency of node.blockedBy) {
      const prev = dependents.get(dependency) ?? []
      dependents.set(dependency, [...prev, node.id])
    }
  }
  const queue = [...seedSet]
  while (queue.length > 0) {
    const current = queue.shift()!
    for (const next of dependents.get(current) ?? []) {
      if (seedSet.has(next)) continue
      seedSet.add(next)
      queue.push(next)
    }
  }
  const keep = new Set(seedSet)
  const nodes = graph.nodes
    .filter((node) => keep.has(node.id))
    .map((node) => ({
      ...cloneNode(node),
      blockedBy: normalizeList(node.blockedBy.filter((dependency) => keep.has(dependency) || !graph.nodes.some((item) => item.id === dependency))),
    }))
  return { nodes }
}
