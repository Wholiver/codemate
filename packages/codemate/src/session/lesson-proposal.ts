import { ulid } from "ulid"
import type { TrajectoryRecord } from "@/session/trajectory"

type LessonProposalSource = "trajectory" | "failure_recovery" | "writer" | "manual"

type LessonProposalType =
  | "failure_pattern"
  | "workflow_rule"
  | "project_convention"
  | "research_insight"
  | "user_preference"

type LessonProposalScope = "project" | "global"

type FailureRecoveryCandidateLike = {
  id: string
  run_id?: string
  failed_stage?: string
  failed_agent?: string
  failure_signal: string
  repair_action?: string
  success_signal?: string
  evidence_refs?: string[]
}

export type LessonProposal = {
  id: string
  run_id: string
  source: LessonProposalSource
  source_trajectory_ids: string[]

  proposed_type: LessonProposalType
  proposed_scope: LessonProposalScope

  summary: string
  applies_when: string[]
  do: string[]
  dont: string[]

  evidence: string[]
  confidence: number

  tags: string[]
  created_at: string
}

type DeriveLessonProposalContext = {
  run_id?: string
  failure_recovery_candidates?: FailureRecoveryCandidateLike[]
}

function compactText(input: string | undefined, max = 180) {
  if (!input) return ""
  const normalized = input.replace(/\s+/g, " ").trim()
  if (!normalized) return ""
  if (normalized.length <= max) return normalized
  return `${normalized.slice(0, Math.max(0, max - 15)).trimEnd()}...[truncated]`
}

function normalizeList(input: string[] | undefined, options?: { maxItems?: number; maxChars?: number }) {
  if (!input || input.length === 0) return []
  const maxItems = options?.maxItems ?? 10
  const maxChars = options?.maxChars ?? 180
  const deduped = [...new Set(input.map((item) => compactText(item, maxChars)).filter(Boolean))]
  return deduped.slice(0, Math.max(1, maxItems))
}

function hasVerificationSignal(record: TrajectoryRecord) {
  if (record.quality_signals.tester_passed === true) return true
  if (record.quality_signals.reviewer_approved === true) return true
  if (record.quality_signals.selfcheck_passed === true) return true
  if (record.quality_signals.command_success === true) return true
  return record.verification_results.some((item) => /\b(pass|passed|approved|verify|verified|success|succeeded)\b/i.test(item))
}

function hasExecutionEvidence(record: TrajectoryRecord) {
  if (record.artifact_paths.length > 0) return true
  if (record.commands_run.length > 0) return true
  if (record.verification_results.length > 0) return true
  if (record.actual_outputs.length > 0) return true
  return false
}

function scoreFailurePatternConfidence(record: TrajectoryRecord) {
  const score =
    0.58 +
    (record.outcome === "recovered" ? 0.14 : 0) +
    (record.failure ? 0.1 : 0) +
    (record.recovery ? 0.1 : 0) +
    (hasVerificationSignal(record) ? 0.1 : 0)
  return Math.min(0.96, Number(score.toFixed(2)))
}

function toProjectPath(input: string) {
  const trimmed = input.trim()
  if (!trimmed) return
  if (trimmed.startsWith("~/")) return
  if (trimmed.startsWith("/")) return
  if (/^[a-z]+:\/\//i.test(trimmed)) return
  if (!trimmed.includes("/")) return
  if (/^\d+\/\d+$/.test(trimmed)) return
  if (/[\u3400-\u9fff]/.test(trimmed)) return
  const normalized = trimmed.toLowerCase()
  if (normalized === "/task" || normalized === "/task_result") return
  const segments = normalized.split("/").filter(Boolean)
  const nonPathSegments = new Set([
    "coder",
    "tester",
    "research",
    "reviewer",
    "writer",
    "shell",
    "file",
    "adapter",
    "script",
    "task",
    "task_result",
  ])
  if (segments.length > 0 && segments.every((segment) => nonPathSegments.has(segment))) return
  return trimmed
}

function isUsableArtifactPath(input: string) {
  const trimmed = input.trim()
  if (!trimmed) return false
  if (/^[a-z]+:\/\//i.test(trimmed)) return false
  if (/^\d+\/\d+$/.test(trimmed)) return false
  if (/[\u3400-\u9fff]/.test(trimmed)) return false
  const normalized = trimmed.toLowerCase()
  if (normalized === "/task" || normalized === "/task_result") return false
  const segments = normalized.split("/").filter(Boolean)
  const nonPathSegments = new Set([
    "coder",
    "tester",
    "research",
    "reviewer",
    "writer",
    "shell",
    "file",
    "adapter",
    "script",
    "task",
    "task_result",
  ])
  if (segments.length > 0 && segments.every((segment) => nonPathSegments.has(segment))) return false
  return trimmed.includes("/")
}

function sharedDirectory(paths: string[]) {
  const normalized = paths.map((item) => toProjectPath(item)).filter((item): item is string => !!item)
  if (normalized.length < 2) return
  const buckets = normalized
    .map((item) => item.split("/").slice(0, 2).join("/"))
    .filter((item) => item.includes("/"))
  if (buckets.length < 2) return
  const counts = new Map<string, number>()
  for (const bucket of buckets) {
    counts.set(bucket, (counts.get(bucket) ?? 0) + 1)
  }
  const best = [...counts.entries()].sort((a, b) => b[1] - a[1]).at(0)
  if (!best || best[1] < 2) return
  return best[0]
}

function buildFailurePatternFromTrajectory(record: TrajectoryRecord, runID: string) {
  const qualifies = record.outcome === "recovered" || !!record.failure || !!record.recovery
  if (!qualifies) return
  if (!hasExecutionEvidence(record) && !record.failure && !record.recovery) return
  const failureSignal = compactText(record.failure?.signal, 160)
  const failedBehavior = compactText(record.failure?.failed_behavior, 160)
  const recoveryAction = compactText(record.recovery?.repair_action, 160)
  const successSignal = compactText(record.recovery?.success_signal, 160)
  const appliesWhen = normalizeList(
    [
      failureSignal ? `when ${record.agent} reports ${failureSignal}` : "",
      failedBehavior ? `when behavior is ${failedBehavior}` : "",
      record.action_summary ? `when task resembles: ${compactText(record.action_summary, 140)}` : "",
    ],
    { maxItems: 4, maxChars: 170 },
  )
  const doList = normalizeList(
    [
      recoveryAction || "apply targeted repair and rerun verification",
      record.commands_run[0] ? `rerun command: ${compactText(record.commands_run[0], 120)}` : "",
      successSignal ? `require success signal: ${successSignal}` : "",
    ],
    { maxItems: 4, maxChars: 170 },
  )
  const dontList = normalizeList(
    [
      failedBehavior ? `do not repeat failed behavior: ${failedBehavior}` : "",
      failureSignal ? `do not persist output before resolving: ${failureSignal}` : "",
    ],
    { maxItems: 4, maxChars: 170 },
  )
  const evidence = normalizeList(
    [
      failureSignal ? `failure: ${failureSignal}` : "",
      successSignal ? `recovery: ${successSignal}` : "",
      ...record.verification_results.slice(0, 3),
      ...(record.evidence_refs ?? []).slice(0, 3),
    ],
    { maxItems: 8, maxChars: 170 },
  )
  if (appliesWhen.length === 0 || doList.length === 0 || evidence.length === 0) return
  return {
    id: ulid(),
    run_id: runID,
    source: "trajectory" as const,
    source_trajectory_ids: [record.id],
    proposed_type: "failure_pattern" as const,
    proposed_scope: "project" as const,
    summary: compactText(
      failureSignal
        ? `Failure pattern: ${failureSignal}`
        : `Failure pattern: ${record.agent} needed recovery before completion`,
      180,
    ),
    applies_when: appliesWhen,
    do: doList,
    dont: dontList.length > 0 ? dontList : ["do not skip verification after applying recovery"],
    evidence,
    confidence: scoreFailurePatternConfidence(record),
    tags: normalizeList(["trajectory", "failure", "recovery", record.agent], { maxItems: 6, maxChars: 40 }),
    created_at: new Date().toISOString(),
  } satisfies LessonProposal
}

function buildFailurePatternFromRecoveryCandidate(candidate: FailureRecoveryCandidateLike, runID: string) {
  const failureSignal = compactText(candidate.failure_signal, 160)
  const recoveryAction = compactText(candidate.repair_action, 160)
  const successSignal = compactText(candidate.success_signal, 160)
  if (!failureSignal) return
  if (!recoveryAction && !successSignal) return
  return {
    id: ulid(),
    run_id: runID,
    source: "failure_recovery" as const,
    source_trajectory_ids: [],
    proposed_type: "failure_pattern" as const,
    proposed_scope: "project" as const,
    summary: compactText(`Failure pattern: ${failureSignal}`, 180),
    applies_when: normalizeList(
      [
        candidate.failed_stage ? `when stage ${candidate.failed_stage} fails with ${failureSignal}` : `when ${failureSignal}`,
      ],
      { maxItems: 3, maxChars: 170 },
    ),
    do: normalizeList([recoveryAction || "apply repair action and rerun checks", successSignal ? `confirm: ${successSignal}` : ""], {
      maxItems: 3,
      maxChars: 170,
    }),
    dont: normalizeList([`do not persist while unresolved failure remains: ${failureSignal}`], { maxItems: 2, maxChars: 170 }),
    evidence: normalizeList(
      [failureSignal, successSignal, ...(candidate.evidence_refs ?? []).slice(0, 3)].filter(Boolean) as string[],
      { maxItems: 7, maxChars: 170 },
    ),
    confidence: Number((successSignal ? 0.82 : 0.72).toFixed(2)),
    tags: normalizeList(["failure_recovery", candidate.failed_stage ?? "unknown"], { maxItems: 4, maxChars: 40 }),
    created_at: new Date().toISOString(),
  } satisfies LessonProposal
}

function buildWorkflowRule(records: TrajectoryRecord[], runID: string) {
  const successful = records.filter((record) => record.outcome === "success" || record.outcome === "recovered")
  if (successful.length < 2) return
  const verified = successful.filter((record) => hasVerificationSignal(record))
  if (verified.length < 2) return
  const withArtifacts = verified.filter((record) => record.artifact_paths.some((path) => isUsableArtifactPath(path)))
  if (withArtifacts.length < 2) return
  const hasCommandOrVerification = verified.some(
    (record) => record.commands_run.length > 0 || record.verification_results.length > 0,
  )
  if (!hasCommandOrVerification) return
  const summary = compactText(
    "Workflow rule: implement change, run verification, and require tester/reviewer confirmation before persistence.",
    180,
  )
  const appliesWhen = normalizeList(
    withArtifacts
      .slice(0, 3)
      .map((record) => `when executing ${compactText(record.action_summary, 120) || record.task_id || record.agent}`),
    { maxItems: 4, maxChars: 170 },
  )
  const doList = normalizeList(
    [
      "run implementation first, then tester/reviewer verification before writer persistence",
      verified.flatMap((record) => record.commands_run).at(0) ? `execute: ${verified.flatMap((record) => record.commands_run).at(0)}` : "",
      verified.flatMap((record) => record.verification_results).at(0)
        ? `require verification signal: ${verified.flatMap((record) => record.verification_results).at(0)}`
        : "",
    ],
    { maxItems: 4, maxChars: 170 },
  )
  const evidence = normalizeList(
    [
      ...withArtifacts
        .slice(0, 4)
        .map((record) => {
          const filtered = record.artifact_paths.filter((path) => isUsableArtifactPath(path)).slice(0, 2)
          if (filtered.length === 0) return ""
          return `artifacts: ${filtered.join(", ")}`
        })
        .filter(Boolean),
      ...verified.flatMap((record) => record.verification_results).slice(0, 3),
    ],
    { maxItems: 8, maxChars: 170 },
  )
  if (appliesWhen.length === 0 || doList.length === 0 || evidence.length === 0) return
  const dontList = normalizeList(
    ["do not skip tester/reviewer confirmation", "do not persist lessons before verification evidence is present"],
    { maxItems: 3, maxChars: 170 },
  )
  return {
    id: ulid(),
    run_id: runID,
    source: "trajectory" as const,
    source_trajectory_ids: withArtifacts.map((record) => record.id).slice(0, 6),
    proposed_type: "workflow_rule" as const,
    proposed_scope: "project" as const,
    summary,
    applies_when: appliesWhen,
    do: doList,
    dont: dontList,
    evidence,
    confidence: Number((0.79 + Math.min(0.12, withArtifacts.length * 0.02)).toFixed(2)),
    tags: normalizeList(["trajectory", "workflow", "verification"], { maxItems: 6, maxChars: 40 }),
    created_at: new Date().toISOString(),
  } satisfies LessonProposal
}

function buildProjectConvention(records: TrajectoryRecord[], runID: string) {
  const successful = records.filter((record) => record.outcome === "success" || record.outcome === "recovered")
  if (successful.length < 2) return
  const withPaths = successful.filter((record) => record.artifact_paths.some((path) => isUsableArtifactPath(path)))
  if (withPaths.length < 2) return
  const projectPaths = withPaths.flatMap((record) =>
    record.artifact_paths
      .filter((path) => isUsableArtifactPath(path))
      .map((path) => toProjectPath(path))
      .filter((path): path is string => !!path),
  )
  if (projectPaths.length < 2) return
  const baseDir = sharedDirectory(projectPaths)
  if (!baseDir) return
  const hasTrustedVerification = withPaths.some((record) => hasVerificationSignal(record))
  if (!hasTrustedVerification) return
  const appliesWhen = normalizeList(
    [
      `when creating or updating artifacts under ${baseDir}`,
      ...withPaths.slice(0, 2).map((record) => `when task resembles: ${compactText(record.action_summary, 120)}`),
    ],
    { maxItems: 4, maxChars: 170 },
  )
  const doList = normalizeList(
    [
      `keep related artifacts under ${baseDir}`,
      withPaths.flatMap((record) => record.commands_run).at(0) ? `verify with command: ${withPaths.flatMap((record) => record.commands_run).at(0)}` : "",
    ],
    { maxItems: 4, maxChars: 170 },
  )
  const dontList = normalizeList(
    [
      `do not scatter related artifacts outside ${baseDir}`,
      "do not treat one-off changelog facts as reusable convention",
    ],
    { maxItems: 4, maxChars: 170 },
  )
  const evidence = normalizeList(
    [...projectPaths.slice(0, 6), ...withPaths.flatMap((record) => record.verification_results).slice(0, 2)],
    { maxItems: 8, maxChars: 170 },
  )
  if (appliesWhen.length === 0 || doList.length === 0 || evidence.length === 0) return
  return {
    id: ulid(),
    run_id: runID,
    source: "trajectory" as const,
    source_trajectory_ids: withPaths.map((record) => record.id).slice(0, 6),
    proposed_type: "project_convention" as const,
    proposed_scope: "project" as const,
    summary: compactText(`Project convention: keep related artifacts under ${baseDir}.`, 180),
    applies_when: appliesWhen,
    do: doList,
    dont: dontList,
    evidence,
    confidence: Number((0.74 + Math.min(0.12, projectPaths.length * 0.02)).toFixed(2)),
    tags: normalizeList(["trajectory", "project", "convention"], { maxItems: 6, maxChars: 40 }),
    created_at: new Date().toISOString(),
  } satisfies LessonProposal
}

function buildRecoveredByStage(records: TrajectoryRecord[], runID: string) {
  const agents: Array<"tester" | "reviewer" | "selfcheck"> = ["tester", "reviewer", "selfcheck"]
  return agents
    .flatMap((agent) => {
      const failed = records.find(
        (record) =>
          record.agent === agent &&
          (record.outcome === "failure" ||
            record.quality_signals.tester_passed === false ||
            record.quality_signals.reviewer_approved === false ||
            record.quality_signals.selfcheck_passed === false ||
            !!record.failure),
      )
      if (!failed) return []
      const recovered = records.find(
        (record) =>
          record.agent === agent &&
          record.created_at >= failed.created_at &&
          (record.outcome === "success" || record.outcome === "recovered") &&
          hasVerificationSignal(record),
      )
      if (!recovered) return []
      const evidence = normalizeList(
        [
          failed.failure?.signal ? `failure: ${failed.failure.signal}` : `${agent} failed`,
          recovered.recovery?.success_signal ? `recovered: ${recovered.recovery.success_signal}` : `${agent} passed on retry`,
          ...failed.verification_results.slice(0, 2),
          ...recovered.verification_results.slice(0, 2),
        ],
        { maxItems: 6, maxChars: 170 },
      )
      if (evidence.length === 0) return []
      return [
        {
          id: ulid(),
          run_id: runID,
          source: "trajectory" as const,
          source_trajectory_ids: [failed.id, recovered.id],
          proposed_type: "failure_pattern" as const,
          proposed_scope: "project" as const,
          summary: compactText(`Failure pattern: ${agent} can fail first and must pass retry before persistence.`, 180),
          applies_when: normalizeList([`when ${agent} initially fails`, `when recovery retry is needed before finalization`], {
            maxItems: 4,
            maxChars: 170,
          }),
          do: normalizeList(
            [
              `apply targeted fix after ${agent} failure`,
              `rerun ${agent} and require explicit pass signal`,
            ],
            { maxItems: 4, maxChars: 170 },
          ),
          dont: normalizeList([`do not treat first ${agent} failure as acceptable completion`], { maxItems: 3, maxChars: 170 }),
          evidence,
          confidence: 0.84,
          tags: normalizeList(["trajectory", "failure", agent], { maxItems: 5, maxChars: 40 }),
          created_at: new Date().toISOString(),
        } satisfies LessonProposal,
      ]
    })
}

function isChangelogFactLike(record: TrajectoryRecord) {
  const text = `${record.action_summary} ${record.actual_outputs.join(" ")}`.toLowerCase()
  if (!/\b(created|updated|modified|added|wrote)\b/.test(text)) return false
  if (hasVerificationSignal(record)) return false
  if (record.commands_run.length > 0 || record.verification_results.length > 0) return false
  return true
}

export function deriveLessonProposalsFromTrajectory(records: TrajectoryRecord[], context?: DeriveLessonProposalContext) {
  const runID = context?.run_id?.trim() || records.at(0)?.run_id || "unknown-run"
  const candidates = records.filter((record) => record.run_id === runID)
  if (candidates.length === 0) return []
  const trajectoryProposals = candidates.flatMap((record) => {
    if (isChangelogFactLike(record)) return []
    const proposal = buildFailurePatternFromTrajectory(record, runID)
    if (!proposal) return []
    return [proposal]
  })
  const recoveredByStage = buildRecoveredByStage(candidates, runID)
  const workflowRule = buildWorkflowRule(candidates, runID)
  const projectConvention = buildProjectConvention(candidates, runID)
  const fromFailureRecovery = (context?.failure_recovery_candidates ?? [])
    .filter((candidate) => !candidate.run_id || candidate.run_id === runID)
    .flatMap((candidate) => {
      const proposal = buildFailurePatternFromRecoveryCandidate(candidate, runID)
      if (!proposal) return []
      return [proposal]
    })
  const merged = [
    ...trajectoryProposals,
    ...recoveredByStage,
    ...(workflowRule ? [workflowRule] : []),
    ...(projectConvention ? [projectConvention] : []),
    ...fromFailureRecovery,
  ]
  const unique = merged.filter(
    (proposal, index, array) =>
      array.findIndex(
        (other) =>
          other.proposed_type === proposal.proposed_type &&
          other.summary === proposal.summary &&
          other.proposed_scope === proposal.proposed_scope,
      ) === index,
  )
  return unique
    .filter((proposal) => proposal.confidence >= 0.62)
    .filter((proposal) => proposal.evidence.length > 0 && proposal.applies_when.length > 0 && proposal.do.length > 0)
    .slice(0, 8)
}

export function formatLessonProposalsForWriter(proposals: LessonProposal[]) {
  const lines = ["Lesson proposals from trajectory:"]
  if (proposals.length === 0) {
    lines.push("- none available.")
    return lines.join("\n")
  }
  for (const proposal of proposals) {
    lines.push(`- Type: ${proposal.proposed_type}`)
    lines.push(`  Scope: ${proposal.proposed_scope}`)
    lines.push(`  Summary: ${proposal.summary}`)
    lines.push(`  When: ${proposal.applies_when.length > 0 ? proposal.applies_when.join(" | ") : "n/a"}`)
    lines.push(`  Do: ${proposal.do.length > 0 ? proposal.do.join(" | ") : "n/a"}`)
    lines.push(`  Don't: ${proposal.dont.length > 0 ? proposal.dont.join(" | ") : "n/a"}`)
    lines.push(`  Evidence: ${proposal.evidence.length > 0 ? proposal.evidence.join(" | ") : "n/a"}`)
    lines.push(`  Confidence: ${proposal.confidence.toFixed(2)}`)
  }
  return lines.join("\n")
}
