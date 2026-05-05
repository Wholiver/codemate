import { Context, Effect, Layer } from "effect"

import { Instance } from "../project/instance"

import PROMPT_ANTHROPIC from "./prompt/anthropic.txt"
import PROMPT_DEFAULT from "./prompt/default.txt"
import PROMPT_BEAST from "./prompt/beast.txt"
import PROMPT_GEMINI from "./prompt/gemini.txt"
import PROMPT_GPT from "./prompt/gpt.txt"
import PROMPT_KIMI from "./prompt/kimi.txt"

import PROMPT_CODEX from "./prompt/codex.txt"
import PROMPT_TRINITY from "./prompt/trinity.txt"
import type { Provider } from "@/provider/provider"
import type { Agent } from "@/agent/agent"
import { Permission } from "@/permission"
import { Skill } from "@/skill"

export function provider(model: Provider.Model) {
  if (model.api.id.includes("gpt-4") || model.api.id.includes("o1") || model.api.id.includes("o3"))
    return [PROMPT_BEAST]
  if (model.api.id.includes("gpt")) {
    if (model.api.id.includes("codex")) {
      return [PROMPT_CODEX]
    }
    return [PROMPT_GPT]
  }
  if (model.api.id.includes("gemini-")) return [PROMPT_GEMINI]
  if (model.api.id.includes("claude")) return [PROMPT_ANTHROPIC]
  if (model.api.id.toLowerCase().includes("trinity")) return [PROMPT_TRINITY]
  if (model.api.id.toLowerCase().includes("kimi")) return [PROMPT_KIMI]
  return [PROMPT_DEFAULT]
}

export interface Interface {
  readonly environment: (model: Provider.Model) => string[]
  readonly skills: (agent: Agent.Info) => Effect.Effect<string | undefined>
}

export class Service extends Context.Service<Service, Interface>()("@codemate/SystemPrompt") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const skill = yield* Skill.Service

    return Service.of({
      environment(model) {
        const project = Instance.project
        return [
          [
            `You are powered by the model named ${model.api.id}. The exact model ID is ${model.providerID}/${model.api.id}`,
            `Here is some useful information about the environment you are running in:`,
            `<env>`,
            `  Working directory: ${Instance.directory}`,
            `  Workspace root folder: ${Instance.worktree}`,
            `  Is directory a git repo: ${project.vcs === "git" ? "yes" : "no"}`,
            `  Platform: ${process.platform}`,
            `  Today's date: ${new Date().toDateString()}`,
            `</env>`,
            [
              "Some specialized tools are hidden until discovered.",
              "If the currently available tools are not enough for the task, call tool_search with a concise description of the capability you need.",
              "Tools returned by tool_search become available in the next step.",
              "If the task depends on current or external facts and the websearch tool is available, you MUST use websearch instead of relying on memory.",
              "Use websearch for latest versions, current releases, prices, APIs, docs, news, vendor behavior, or any fact that may have changed after training.",
              "If you are unsure whether a fact might be stale, prefer websearch.",
              "At the start of every non-trivial task, proactively call the planner tool once to assess difficulty, estimate completion time, decide whether search is needed for accuracy, and list planned steps before execution.",
              "Mark needs_search_for_accuracy=true when facts may be stale, external behavior is unclear, or exact/latest correctness depends on current sources.",
              "Use realistic estimated_minutes and include at least one verification step in the plan for non-trivial tasks.",
              "After planner assessment, branch your execution path: if difficulty=easy and needs_search_for_accuracy=false, proceed directly with local execution.",
              "If difficulty=medium or hard, or needs_search_for_accuracy=true, run research first and include internet/web search before major implementation.",
              "For complex tasks, gather references first, then implement, then verify; do not skip the research phase.",
              "For trivial single-step tasks (simple questions, reading files, running one command), you may skip planning.",
              "After two failed attempts on the same subproblem, you MUST run websearch (or another available research tool) before trying a third fix.",
              "If install/build/configuration fails, run websearch before the next substantial change unless the error is trivially local and obvious.",
              "Review the <project-lessons> tags in your system context at the start of every task.",
              "When <project-lessons> content is present, answer lessons-related questions directly from that context and do not call read for .codemate/lessons.md unless the user explicitly asks for raw file contents or the tag is missing.",
              "Before ending a substantive turn that should persist across sessions, call memory_create explicitly instead of relying only on background extraction.",
              "Before ending a task where files were changed or delegated work was performed, call changelog_append to record what changed.",
              "If you completed a task in this turn, before ending it call lesson_write with the fully merged contents of .codemate/lessons.md.",
              "Each lesson entry must include: (1) errors encountered and how to avoid them, (2) wrong paths or detours taken and how to avoid them, (3) key discoveries and decisions made during the task.",
              "After completing any task, call selfcheck before your final response. For JS/TS tasks, use the default checks (typecheck, lint, test). For non-JS/TS tasks, use task-appropriate verification (e.g., run the command you just executed, verify output, confirm file contents).",
              "Always run selfcheck regardless of task type. The selfcheck tool handles JS/TS checks automatically; for other task types, pass relevant checks or verify manually.",
              "Use selfcheck for final verification, then fix or clearly report any failures it finds.",
              "If selfcheck reports any failure, you MUST run this reflection flow before your next major fix attempt:",
              "1) call memory_create to store durable failure memory (error signature, root cause hypothesis, what failed).",
              "2) call changelog_append to record what was attempted and why it failed.",
              "3) call lesson_write to update .codemate/lessons.md with a concise failure summary, self-reflection, and the next corrective strategy.",
              "4) run a fresh deep research pass before the next major fix attempt: call websearch (Exa) or webfetch, and call at least one research tool.",
              "5) after applying the next fix, run selfcheck again before final response.",
              "Do not skip this reflection flow after selfcheck failures unless those tools are unavailable.",
            ].join("\n"),
          ].join("\n"),
        ]
      },

      skills: Effect.fn("SystemPrompt.skills")(function* (agent: Agent.Info) {
        if (Permission.disabled(["skill"], agent.permission).has("skill")) return

        const list = yield* skill.available(agent)

        return [
          "Skills provide specialized instructions and workflows for specific tasks.",
          "Use the skill tool to load a skill when a task matches its description.",
          // the agents seem to ingest the information about skills a bit better if we present a more verbose
          // version of them here and a less verbose version in tool description, rather than vice versa.
          Skill.fmt(list, { verbose: true }),
        ].join("\n")
      }),
    })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Skill.defaultLayer))

export * as SystemPrompt from "./system"
