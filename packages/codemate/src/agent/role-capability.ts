export type AgentCapability =
  | "schedule"
  | "plan"
  | "research"
  | "implement"
  | "edit_files"
  | "run_local_sanity_check"
  | "run_tests"
  | "verify_requirements"
  | "review"
  | "selfcheck"
  | "drift_check"
  | "persist_changelog"
  | "persist_lesson"

export type AgentRole =
  | "orchestrator"
  | "planner"
  | "research"
  | "coder"
  | "tester"
  | "reviewer"
  | "writer"
  | "selfcheck"

export const AGENT_ROLE_CAPABILITY_MATRIX: Record<AgentRole, readonly AgentCapability[]> = {
  orchestrator: ["schedule", "drift_check"],
  planner: ["plan"],
  research: ["research"],
  coder: ["implement", "edit_files", "run_local_sanity_check"],
  tester: ["run_tests", "verify_requirements"],
  reviewer: ["review", "verify_requirements"],
  writer: ["persist_changelog", "persist_lesson"],
  selfcheck: ["selfcheck", "drift_check"],
}

export const AGENT_ROLE_TOOL_DENYLIST: Record<AgentRole, readonly string[]> = {
  orchestrator: ["edit", "write", "patch", "bash", "selfcheck", "changelog_append", "lesson_classify", "lesson_write"],
  planner: ["edit", "write", "patch", "bash", "task", "todowrite", "selfcheck", "changelog_append", "lesson_classify", "lesson_write"],
  research: ["edit", "write", "patch", "task", "todowrite", "selfcheck", "changelog_append", "lesson_classify", "lesson_write"],
  coder: ["selfcheck", "changelog_append", "lesson_classify", "lesson_write"],
  tester: ["lesson_classify", "lesson_write", "changelog_append", "selfcheck"],
  reviewer: ["edit", "write", "patch", "lesson_classify", "lesson_write", "changelog_append", "selfcheck"],
  writer: ["edit", "write", "patch", "bash", "task", "todowrite", "selfcheck"],
  selfcheck: ["edit", "write", "patch", "task", "todowrite", "changelog_append", "lesson_classify", "lesson_write"],
}

export type QualitySignalKey =
  | "tester_passed"
  | "reviewer_approved"
  | "selfcheck_passed"
  | "artifact_paths_verified"
  | "command_success"
  | "local_sanity_check"
  | "drift_detected"

export const AGENT_ROLE_QUALITY_SIGNAL_ALLOWLIST: Record<AgentRole, readonly QualitySignalKey[]> = {
  orchestrator: ["drift_detected"],
  planner: ["command_success"],
  research: ["command_success"],
  coder: ["command_success", "local_sanity_check"],
  tester: ["command_success", "tester_passed", "artifact_paths_verified"],
  reviewer: ["reviewer_approved", "command_success"],
  writer: ["command_success"],
  selfcheck: ["selfcheck_passed", "command_success", "drift_detected"],
}

export function agentRoleFromName(input: string | undefined): AgentRole | undefined {
  if (!input) return
  if (input === "orchestrator") return "orchestrator"
  if (input === "planner") return "planner"
  if (input === "research") return "research"
  if (input === "coder") return "coder"
  if (input === "tester") return "tester"
  if (input === "reviewer") return "reviewer"
  if (input === "writer") return "writer"
  if (input === "selfcheck") return "selfcheck"
}

export function roleHasCapability(role: AgentRole, capability: AgentCapability) {
  return AGENT_ROLE_CAPABILITY_MATRIX[role].includes(capability)
}
