import { Config } from "@/config/config"
import z from "zod"
import { Provider } from "@/provider/provider"
import { ModelID, ProviderID } from "../provider/schema"
import { generateObject, streamObject, type ModelMessage } from "ai"
import { Truncate } from "@/tool/truncate"
import { Auth } from "../auth"
import { ProviderTransform } from "@/provider/transform"

import PROMPT_GENERATE from "./generate.txt"
import PROMPT_COMPACTION from "./prompt/compaction.txt"
import PROMPT_CODER from "./prompt/coder.txt"
import PROMPT_PLANNER from "./prompt/planner.txt"
import PROMPT_RESEARCH from "./prompt/research.txt"
import PROMPT_REVIEWER from "./prompt/reviewer.txt"
import PROMPT_SUMMARY from "./prompt/summary.txt"
import PROMPT_TESTER from "./prompt/tester.txt"
import PROMPT_TITLE from "./prompt/title.txt"
import PROMPT_WRITER from "./prompt/writer.txt"
import { Permission } from "@/permission"
import { mergeDeep, pipe, sortBy, values } from "remeda"
import { Global } from "@codemate-ai/core/global"
import { Flag } from "@codemate-ai/core/flag/flag"
import path from "path"
import { Plugin } from "@/plugin"
import { Skill } from "../skill"
import { Effect, Context, Layer, Schema } from "effect"
import { InstanceState } from "@/effect/instance-state"
import * as Option from "effect/Option"
import * as OtelTracer from "@effect/opentelemetry/Tracer"
import { zod } from "@codemate-ai/core/effect-zod"
import { withStatics, type DeepMutable } from "@codemate-ai/core/schema"
import { Reference } from "@/reference/reference"
import { AGENT_ROLE_TOOL_DENYLIST, agentRoleFromName, type AgentRole } from "./role-capability"

const LEGACY_SUBAGENT_ALIAS: Record<string, string> = {
  general: "coder",
  explore: "planner",
  scout: "research",
}

export const Info = Schema.Struct({
  name: Schema.String,
  description: Schema.optional(Schema.String),
  mode: Schema.Literals(["subagent", "primary", "all"]),
  native: Schema.optional(Schema.Boolean),
  hidden: Schema.optional(Schema.Boolean),
  topP: Schema.optional(Schema.Finite),
  temperature: Schema.optional(Schema.Finite),
  color: Schema.optional(Schema.String),
  permission: Permission.Ruleset,
  model: Schema.optional(
    Schema.Struct({
      modelID: ModelID,
      providerID: ProviderID,
    }),
  ),
  variant: Schema.optional(Schema.String),
  prompt: Schema.optional(Schema.String),
  options: Schema.Record(Schema.String, Schema.Unknown),
  steps: Schema.optional(Schema.Finite),
})
  .annotate({ identifier: "Agent" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type Info = DeepMutable<Schema.Schema.Type<typeof Info>>

export interface Interface {
  readonly get: (agent: string) => Effect.Effect<Info>
  readonly list: () => Effect.Effect<Info[]>
  readonly defaultAgent: () => Effect.Effect<string>
  readonly generate: (input: {
    description: string
    model?: { providerID: ProviderID; modelID: ModelID }
  }) => Effect.Effect<{
    identifier: string
    whenToUse: string
    systemPrompt: string
  }>
}

type State = Omit<Interface, "generate">

export class Service extends Context.Service<Service, Interface>()("@codemate/Agent") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const auth = yield* Auth.Service
    const plugin = yield* Plugin.Service
    const skill = yield* Skill.Service
    const provider = yield* Provider.Service

    const state = yield* InstanceState.make<State>(
      Effect.fn("Agent.state")(function* (ctx) {
        const cfg = yield* config.get()
        const skillDirs = yield* skill.dirs()
        const whitelistedDirs = [
          Truncate.GLOB,
          path.join(Global.Path.tmp, "*"),
          ...skillDirs.map((dir) => path.join(dir, "*")),
        ]
        const readonlyExternalDirectory = {
          "*": "ask",
          ...Object.fromEntries(whitelistedDirs.map((dir) => [dir, "allow"])),
        } satisfies Record<string, "allow" | "ask" | "deny">

        const defaults = Permission.fromConfig({
          "*": "allow",
          doom_loop: "ask",
          external_directory: {
            "*": "ask",
            ...Object.fromEntries(whitelistedDirs.map((dir) => [dir, "allow"])),
          },
          question: "deny",
          plan_enter: "deny",
          plan_exit: "deny",
          repo_clone: "deny",
          repo_overview: "deny",
          // mirrors github.com/github/gitignore Node.gitignore pattern for .env files
          read: {
            "*": "allow",
            "*.env": "ask",
            "*.env.*": "ask",
            "*.env.example": "allow",
          },
        })

        const user = Permission.fromConfig(cfg.permission ?? {})
        const resolvedReferences = Reference.resolveAll({
          references: cfg.reference ?? {},
          directory: ctx.directory,
          worktree: ctx.worktree,
        })
        const referenceExternalAllow = Object.fromEntries(
          resolvedReferences.flatMap((resolved) => {
            if (resolved.kind === "invalid") return []
            return [
              [resolved.path, "allow" as const],
              [path.join(resolved.path, "*"), "allow" as const],
            ]
          }),
        )
        const referencePrompt = resolvedReferences
          .map((resolved) => {
            if (resolved.kind === "local") return `- @${resolved.name}: local reference at ${resolved.path}`
            if (resolved.kind === "git")
              return `- @${resolved.name}: repository ${resolved.repository} cached at ${resolved.path}${resolved.branch ? ` (branch ${resolved.branch})` : ""}`
            return `- @${resolved.name}: invalid reference ${resolved.repository} (${resolved.message})`
          })
          .join("\n")
        const researchPrompt = [
          PROMPT_RESEARCH,
          referencePrompt
            ? [
                "## Reference Extension",
                "Use the following configured references when relevant. These are inputs to research, not separate subagents.",
                referencePrompt,
              ].join("\n")
            : "",
        ]
          .filter((x) => x.trim().length > 0)
          .join("\n\n")
        const denylistRules = (role: AgentRole) =>
          Permission.fromConfig(
            Object.fromEntries(AGENT_ROLE_TOOL_DENYLIST[role].map((tool) => [tool, "deny"])) as Record<string, "deny">,
          )
        const enforceRoleDenylist = (role: AgentRole, ...rulesets: Permission.Ruleset[]) =>
          Permission.merge(...rulesets, denylistRules(role))

        const agents: Record<string, Info> = {
          orchestrator: {
            name: "orchestrator",
            description: "Orchestrator agent. Routes non-trivial work through TaskGraph and specialist subagents.",
            options: {},
            permission: enforceRoleDenylist(
              "orchestrator",
              Permission.fromConfig({
                "*": "deny",
                task: "allow",
                question: "allow",
                read: "allow",
                supermemory: "allow",
                external_directory: readonlyExternalDirectory,
              }),
              Permission.fromConfig({
                // Redundant explicit denies to keep behavior obvious in merged rulesets.
                edit: "deny",
                write: "deny",
                patch: "deny",
                bash: "deny",
              }),
              user,
            ),
            mode: "primary",
            native: true,
          },
          planner: {
            name: "planner",
            description: "Requirement planner. Builds TaskGraph and dependency order. Never writes code.",
            permission: enforceRoleDenylist(
              "planner",
              Permission.fromConfig({
                "*": "deny",
                read: "allow",
                question: "allow",
                supermemory: "deny",
                external_directory: readonlyExternalDirectory,
              }),
              user,
            ),
            prompt: PROMPT_PLANNER,
            options: {},
            mode: "subagent",
            native: true,
          },
          coder: {
            name: "coder",
            description: "Implementation specialist. Applies code changes for concrete task nodes.",
            permission: enforceRoleDenylist(
              "coder",
              defaults,
              Permission.fromConfig({
                supermemory: "allow",
              }),
              user,
            ),
            prompt: PROMPT_CODER,
            options: {},
            mode: "subagent",
            native: true,
          },
          research: {
            name: "research",
            description: "External and dependency research specialist. Produces structured summaries only.",
            permission: enforceRoleDenylist(
              "research",
              defaults,
              Permission.fromConfig({
                "*": "deny",
                grep: "allow",
                glob: "allow",
                list: "allow",
                bash: "allow",
                webfetch: "allow",
                websearch: "allow",
                read: "allow",
                supermemory: "deny",
                ...(Flag.codemate_EXPERIMENTAL_SCOUT
                  ? {
                      codesearch: "allow",
                      repo_clone: "allow",
                      repo_overview: "allow",
                    }
                  : {}),
                external_directory: {
                  ...readonlyExternalDirectory,
                  ...referenceExternalAllow,
                  ...(Flag.codemate_EXPERIMENTAL_SCOUT ? { [path.join(Global.Path.repos, "*")]: "allow" } : {}),
                },
              }),
              user,
            ),
            prompt: researchPrompt,
            options: { references: resolvedReferences },
            mode: "subagent",
            native: true,
          },
          reviewer: {
            name: "reviewer",
            description: "Review and verification specialist. Runs checks and returns pass/fail with TaskGraph fixes.",
            permission: enforceRoleDenylist(
              "reviewer",
              defaults,
              Permission.fromConfig({
                edit: "deny",
                write: "deny",
                patch: "deny",
                supermemory: "allow",
              }),
              user,
            ),
            prompt: PROMPT_REVIEWER,
            options: {},
            mode: "subagent",
            native: true,
          },
          tester: {
            name: "tester",
            description: "Test specialist. Writes and runs tests for implementation tasks without changing production code.",
            permission: enforceRoleDenylist(
              "tester",
              defaults,
              Permission.fromConfig({
                edit: {
                  "*": "deny",
                  "**/*.test.*": "allow",
                  "**/*.spec.*": "allow",
                  "**/__tests__/**": "allow",
                  "**/test/**": "allow",
                },
                bash: "allow",
                read: "allow",
                glob: "allow",
                grep: "allow",
              }),
              user,
            ),
            prompt: PROMPT_TESTER,
            options: {},
            mode: "subagent",
            native: true,
          },
          writer: {
            name: "writer",
            description: "Documentation and persistence specialist. Writes changelog and lessons.",
            permission: enforceRoleDenylist(
              "writer",
              defaults,
              Permission.fromConfig({
                lesson_classify: "allow",
                lesson_write: "allow",
                changelog_append: "allow",
                supermemory: "allow",
              }),
              user,
            ),
            prompt: PROMPT_WRITER,
            options: {},
            mode: "subagent",
            native: true,
          },
          compaction: {
            name: "compaction",
            mode: "primary",
            native: true,
            hidden: true,
            prompt: PROMPT_COMPACTION,
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                "*": "deny",
              }),
              user,
            ),
            options: {},
          },
          title: {
            name: "title",
            mode: "primary",
            options: {},
            native: true,
            hidden: true,
            temperature: 0.5,
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                "*": "deny",
              }),
              user,
            ),
            prompt: PROMPT_TITLE,
          },
          summary: {
            name: "summary",
            mode: "primary",
            options: {},
            native: true,
            hidden: true,
            permission: Permission.merge(
              defaults,
              Permission.fromConfig({
                "*": "deny",
              }),
              user,
            ),
            prompt: PROMPT_SUMMARY,
          },
        }

        for (const [key, value] of Object.entries(cfg.agent ?? {})) {
          const legacy = LEGACY_SUBAGENT_ALIAS[key]
          if (legacy) {
            throw new Error(
              `agent "${key}" has been removed. Use "${legacy}" instead (migration: general->coder, explore->planner, scout->research).`,
            )
          }
          if (value.disable) {
            delete agents[key]
            continue
          }
          let item = agents[key]
          if (!item)
            item = agents[key] = {
              name: key,
              mode: "all",
              permission: Permission.merge(defaults, user),
              options: {},
              native: false,
            }
          if (value.model) item.model = Provider.parseModel(value.model)
          item.variant = value.variant ?? item.variant
          item.prompt = value.prompt ?? item.prompt
          item.description = value.description ?? item.description
          item.temperature = value.temperature ?? item.temperature
          item.topP = value.top_p ?? item.topP
          item.mode = value.mode ?? item.mode
          item.color = value.color ?? item.color
          item.hidden = value.hidden ?? item.hidden
          item.name = value.name ?? item.name
          item.steps = value.steps ?? item.steps
          item.options = mergeDeep(item.options, value.options ?? {})
          item.permission = Permission.merge(item.permission, Permission.fromConfig(value.permission ?? {}))
          const role = agentRoleFromName(key)
          if (role) item.permission = enforceRoleDenylist(role, item.permission)
        }

        // Ensure Truncate.GLOB is allowed unless explicitly configured
        for (const name in agents) {
          const agent = agents[name]
          const explicit = agent.permission.some((r) => {
            if (r.permission !== "external_directory") return false
            if (r.action !== "deny") return false
            return r.pattern === Truncate.GLOB
          })
          if (explicit) continue

          agents[name].permission = Permission.merge(
            agents[name].permission,
            Permission.fromConfig({ external_directory: { [Truncate.GLOB]: "allow" } }),
          )
        }

        const get = Effect.fnUntraced(function* (agent: string) {
          return agents[agent]
        })

        const list = Effect.fnUntraced(function* () {
          const cfg = yield* config.get()
          return pipe(
            agents,
            values(),
            sortBy(
              [(x) => (cfg.default_agent ? x.name === cfg.default_agent : x.name === "orchestrator"), "desc"],
              [(x) => x.name, "asc"],
            ),
          )
        })

        const defaultAgent = Effect.fnUntraced(function* () {
          const c = yield* config.get()
          if (c.default_agent) {
            const agent = agents[c.default_agent]
            if (!agent) throw new Error(`default agent "${c.default_agent}" not found`)
            if (agent.mode === "subagent") throw new Error(`default agent "${c.default_agent}" is a subagent`)
            if (agent.hidden === true) throw new Error(`default agent "${c.default_agent}" is hidden`)
            return agent.name
          }
          const preferred = agents.orchestrator
          if (preferred && preferred.mode !== "subagent" && preferred.hidden !== true) return preferred.name
          const visible = Object.values(agents).find((a) => a.mode !== "subagent" && a.hidden !== true)
          if (!visible) throw new Error("no primary visible agent found")
          return visible.name
        })

        return {
          get,
          list,
          defaultAgent,
        } satisfies State
      }),
    )

    return Service.of({
      get: Effect.fn("Agent.get")(function* (agent: string) {
        return yield* InstanceState.useEffect(state, (s) => s.get(agent))
      }),
      list: Effect.fn("Agent.list")(function* () {
        return yield* InstanceState.useEffect(state, (s) => s.list())
      }),
      defaultAgent: Effect.fn("Agent.defaultAgent")(function* () {
        return yield* InstanceState.useEffect(state, (s) => s.defaultAgent())
      }),
      generate: Effect.fn("Agent.generate")(function* (input: {
        description: string
        model?: { providerID: ProviderID; modelID: ModelID }
      }) {
        const cfg = yield* config.get()
        const model = input.model ?? (yield* provider.defaultModel())
        const resolved = yield* provider.getModel(model.providerID, model.modelID)
        const language = yield* provider.getLanguage(resolved)
        const tracer = cfg.experimental?.openTelemetry
          ? Option.getOrUndefined(yield* Effect.serviceOption(OtelTracer.OtelTracer))
          : undefined

        const system = [PROMPT_GENERATE]
        yield* plugin.trigger("experimental.chat.system.transform", { model: resolved }, { system })
        const existing = yield* InstanceState.useEffect(state, (s) => s.list())

        // TODO: clean this up so provider specific logic doesnt bleed over
        const authInfo = yield* auth.get(model.providerID).pipe(Effect.orDie)
        const isOpenaiOauth = model.providerID === "openai" && authInfo?.type === "oauth"

        const params = {
          experimental_telemetry: {
            isEnabled: cfg.experimental?.openTelemetry,
            tracer,
            metadata: {
              userId: cfg.username ?? "unknown",
            },
          },
          temperature: 0.3,
          messages: [
            ...(isOpenaiOauth
              ? []
              : system.map(
                  (item): ModelMessage => ({
                    role: "system",
                    content: item,
                  }),
                )),
            {
              role: "user",
              content: `Create an agent configuration based on this request: "${input.description}".\n\nIMPORTANT: The following identifiers already exist and must NOT be used: ${existing.map((i) => i.name).join(", ")}\n  Return ONLY the JSON object, no other text, do not wrap in backticks`,
            },
          ],
          model: language,
          schema: z.object({
            identifier: z.string(),
            whenToUse: z.string(),
            systemPrompt: z.string(),
          }),
        } satisfies Parameters<typeof generateObject>[0]

        if (isOpenaiOauth) {
          return yield* Effect.promise(async () => {
            const result = streamObject({
              ...params,
              providerOptions: ProviderTransform.providerOptions(resolved, {
                instructions: system.join("\n"),
                store: false,
              }),
              onError: () => {},
            })
            for await (const part of result.fullStream) {
              if (part.type === "error") throw part.error
            }
            return result.object
          })
        }

        return yield* Effect.promise(() => generateObject(params).then((r) => r.object))
      }),
    })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(Plugin.defaultLayer),
  Layer.provide(Provider.defaultLayer),
  Layer.provide(Auth.defaultLayer),
  Layer.provide(Config.defaultLayer),
  Layer.provide(Skill.defaultLayer),
)

export * as Agent from "./agent"
