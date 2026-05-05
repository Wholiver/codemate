import { PlanExitTool } from "./plan"
import { Session } from "@/session/session"
import { QuestionTool } from "./question"
import { BashTool } from "./bash"
import { EditTool } from "./edit"
import { GlobTool } from "./glob"
import { GrepTool } from "./grep"
import { ReadTool } from "./read"
import { TaskTool } from "./task"
import { TodoWriteTool } from "./todo"
import { PlannerTool } from "./planner"
import { WebFetchTool } from "./webfetch"
import { WriteTool } from "./write"
import { InvalidTool } from "./invalid"
import { CompressTool } from "./compress"
import { SkillTool } from "./skill"
import { MemoryCreateTool } from "./memory-create"
import { MemorySearchTool } from "./memory-search"
import { MemoryReadTool } from "./memory-read"
import { MemoryListTool } from "./memory-list"
import { ChangelogCreateTool } from "./changelog-create"
import { LessonWriteTool } from "./lesson-write"
import { SelfCheckTool } from "./selfcheck"
import { createToolSearchTool } from "./tool-search"
import { createToolSearchRegexTool } from "./tool-search-regex"
import { ResearchTool } from "./research"
import { ResearchAddItemsTool } from "./research-add-items"
import { ResearchAddFieldsTool } from "./research-add-fields"
import { ResearchDeepTool } from "./research-deep"
import { ResearchReportTool } from "./research-report"
import * as Tool from "./tool"
import { Config } from "@/config/config"
import { type Tool as AITool } from "ai"
import { type ToolContext as PluginToolContext, type ToolDefinition } from "@codemate-ai/plugin"
import { Schema, SchemaAST } from "effect"
import z from "zod"
import { ZodOverride } from "@/util/effect-zod"
import { Plugin } from "../plugin"
import { Provider } from "@/provider/provider"
import { ProviderID, type ModelID } from "../provider/schema"
import { WebSearchTool } from "./websearch"
import { Flag } from "@codemate-ai/core/flag/flag"
import * as Log from "@codemate-ai/core/util/log"
import { LspTool } from "./lsp"
import * as Truncate from "./truncate"
import { ApplyPatchTool } from "./apply_patch"
import { Glob } from "@codemate-ai/core/util/glob"
import path from "path"
import { pathToFileURL } from "url"
import { Effect, Layer, Context, Stream } from "effect"
import { FetchHttpClient, HttpClient } from "effect/unstable/http"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { CrossSpawnSpawner } from "@codemate-ai/core/cross-spawn-spawner"
import { Ripgrep } from "../file/ripgrep"
import { Format } from "../format"
import { InstanceState } from "@/effect/instance-state"
import { Question } from "../question"
import { Todo } from "../session/todo"
import { LSP } from "@/lsp/lsp"
import { Instruction } from "../session/instruction"
import { AppFileSystem } from "@codemate-ai/core/filesystem"
import { Bus } from "../bus"
import { MCP } from "../mcp"
import { Agent } from "../agent/agent"
import { Skill } from "../skill"
import { Permission } from "@/permission"
import { Memory } from "@/memory/memory"
import { Changelog } from "@/changelog/changelog"
import { BM25 } from "../search/bm25"

const log = Log.create({ service: "tool.registry" })

type TaskDef = Tool.InferDef<typeof TaskTool>
type ReadDef = Tool.InferDef<typeof ReadTool>

type State = {
  custom: Tool.Def[]
  builtin: Tool.Def[]
  task: TaskDef
  read: ReadDef
}

export interface CatalogEntry {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly parameters: readonly string[]
  readonly source: "builtin" | "mcp" | "plugin"
}

export interface Interface {
  readonly ids: () => Effect.Effect<string[]>
  readonly all: () => Effect.Effect<Tool.Def[]>
  readonly named: () => Effect.Effect<{ task: TaskDef; read: ReadDef }>
  readonly tools: (model: {
    providerID: ProviderID
    modelID: ModelID
    agent: Agent.Info
    sessionID?: string
  }) => Effect.Effect<Tool.Def[]>
  readonly search: (query: string, opts?: { limit?: number; source?: string }) => Effect.Effect<CatalogEntry[]>
  readonly searchRegex: (pattern: string, opts?: { limit?: number; source?: string }) => Effect.Effect<CatalogEntry[]>
  readonly reveal: (sessionID: string, ids: readonly string[]) => Effect.Effect<void>
  readonly revealed: (sessionID: string) => Effect.Effect<ReadonlySet<string>>
}

export class Service extends Context.Service<Service, Interface>()("@codemate/ToolRegistry") {}

export const layer: Layer.Layer<
  Service,
  never,
  | Config.Service
  | Plugin.Service
  | Question.Service
  | Todo.Service
  | Agent.Service
  | Skill.Service
  | Session.Service
  | Provider.Service
  | LSP.Service
  | Instruction.Service
  | AppFileSystem.Service
  | Bus.Service
  | HttpClient.HttpClient
  | ChildProcessSpawner
  | Ripgrep.Service
  | Format.Service
  | Truncate.Service
  | Memory.Service
  | Changelog.Service
  | MCP.Service
> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const plugin = yield* Plugin.Service
    const agents = yield* Agent.Service
    const skill = yield* Skill.Service
    const truncate = yield* Truncate.Service
    const bus = yield* Bus.Service
    const mcp = yield* MCP.Service

    const invalid = yield* InvalidTool
    const compress = yield* CompressTool
    const task = yield* TaskTool
    const read = yield* ReadTool
    const question = yield* QuestionTool
    const todo = yield* TodoWriteTool
    const planner = yield* PlannerTool
    const lsptool = yield* LspTool
    const plan = yield* PlanExitTool
    const webfetch = yield* WebFetchTool
    const websearch = yield* WebSearchTool
    const bash = yield* BashTool
    const globtool = yield* GlobTool
    const writetool = yield* WriteTool
    const edit = yield* EditTool
    const greptool = yield* GrepTool
    const patchtool = yield* ApplyPatchTool
    const skilltool = yield* SkillTool
    const memorycreate = yield* MemoryCreateTool
    const memorysearch = yield* MemorySearchTool
    const memoryread = yield* MemoryReadTool
    const memorylist = yield* MemoryListTool
    const changelogcreate = yield* ChangelogCreateTool
    const lessonwrite = yield* LessonWriteTool
    const selfcheck = yield* SelfCheckTool
    const research = yield* ResearchTool
    const researchAddItems = yield* ResearchAddItemsTool
    const researchAddFields = yield* ResearchAddFieldsTool
    const researchDeep = yield* ResearchDeepTool
    const researchReport = yield* ResearchReportTool
    const agent = yield* Agent.Service

    const revealedTools = new Map<string, Set<string>>()
    let catalogCache: CatalogEntry[] | undefined
    let bm25Index: BM25.BM25Index | undefined
    let state: InstanceState.InstanceState<State>

    function extractParamNames(schema: SchemaAST.AST): string[] {
      if (schema._tag === "Objects") {
        return schema.propertySignatures.map((p) => p.name as string)
      }
      const override = (schema.annotations as Record<symbol, unknown>)?.[ZodOverride]
      if (override && typeof override === "object" && "shape" in override) {
        return Object.keys((override as { shape: Record<string, unknown> }).shape)
      }
      return []
    }

    function buildToolCatalogEntries(tools: Tool.Def[], source: CatalogEntry["source"]): CatalogEntry[] {
      return tools.map((t) => ({
        id: t.id,
        name: t.id,
        description: t.description,
        parameters: extractParamNames(t.parameters.ast),
        source,
      }))
    }

    function buildMcpCatalogEntries(tools: Record<string, AITool>): CatalogEntry[] {
      return Object.entries(tools).map(([id, tool]) => ({
        id,
        name: id,
        description: tool.description ?? "",
        parameters: [],
        source: "mcp",
      }))
    }

    function invalidateCatalog() {
      catalogCache = undefined
      bm25Index = undefined
    }

    function ensureCatalog(input: { custom: Tool.Def[]; mcp: Record<string, AITool> }): {
      entries: CatalogEntry[]
      index: BM25.BM25Index
    } {
      if (!catalogCache) {
        catalogCache = [...buildToolCatalogEntries(input.custom, "plugin"), ...buildMcpCatalogEntries(input.mcp)]
        bm25Index = BM25.createBM25Index(
          catalogCache.map((e) => ({
            id: e.id,
            text: `${e.name} ${e.description} ${e.parameters.join(" ")}`,
          })),
        )
      }
      return { entries: catalogCache, index: bm25Index! }
    }

    const reveal: Interface["reveal"] = Effect.fn("ToolRegistry.reveal")(function* (sessionID, ids) {
      if (ids.length === 0) return
      const set = revealedTools.get(sessionID) ?? new Set<string>()
      for (const id of ids) set.add(id)
      revealedTools.set(sessionID, set)
    })

    const revealed: Interface["revealed"] = Effect.fn("ToolRegistry.revealed")(function* (sessionID) {
      return new Set(revealedTools.get(sessionID) ?? [])
    })

    function searchCatalog(query: string, opts?: { limit?: number; source?: string }): Effect.Effect<CatalogEntry[]> {
      return Effect.gen(function* () {
        const s = yield* InstanceState.get(state)
        const { entries, index } = ensureCatalog({ custom: s.custom, mcp: yield* mcp.tools() })
        const limit = opts?.limit ?? 10
        const results = index.search(query, limit + 20)
        return results
          .map((r) => entries.find((e) => e.id === r.id))
          .filter((e): e is CatalogEntry => e !== undefined)
          .filter((e) => !opts?.source || e.source === opts.source)
          .slice(0, limit)
      })
    }

    function searchCatalogRegex(
      pattern: string,
      opts?: { limit?: number; source?: string },
    ): Effect.Effect<CatalogEntry[]> {
      return Effect.gen(function* () {
        const s = yield* InstanceState.get(state)
        const { entries } = ensureCatalog({ custom: s.custom, mcp: yield* mcp.tools() })
        const limit = opts?.limit ?? 10
        const regex = new RegExp(pattern, "i")
        return entries
          .filter((e) => !opts?.source || e.source === opts.source)
          .filter((e) => regex.test(e.name) || regex.test(e.description))
          .slice(0, limit)
      })
    }

    const toolsearch = yield* createToolSearchTool(searchCatalog, reveal)
    const toolsearchregex = yield* createToolSearchRegexTool(searchCatalogRegex, reveal)

    state = yield* InstanceState.make<State>(
      Effect.fn("ToolRegistry.state")(function* (ctx) {
        const custom: Tool.Def[] = []
        const cfg = yield* config.get()
        const pureMode = Flag.CODEMATE_PURE || cfg.pure === true

        function fromPlugin(id: string, def: ToolDefinition): Tool.Def {
          // Plugin tools define their args as a raw Zod shape. Wrap the
          // derived Zod object in a `Schema.declare` so it slots into the
          // Schema-typed framework, and annotate with `ZodOverride` so the
          // walker emits the original Zod object for LLM JSON Schema.
          const zodParams = z.object(def.args)
          const parameters = Schema.declare<unknown>((u): u is unknown => zodParams.safeParse(u).success).annotate({
            [ZodOverride]: zodParams,
          })
          return {
            id,
            parameters,
            description: def.description,
            execute: (args, toolCtx) =>
              Effect.gen(function* () {
                const pluginCtx: PluginToolContext = {
                  ...toolCtx,
                  ask: (req) => toolCtx.ask(req),
                  directory: ctx.directory,
                  worktree: ctx.worktree,
                }
                const result = yield* Effect.promise(() => def.execute(args as any, pluginCtx))
                const output = typeof result === "string" ? result : result.output
                const metadata = typeof result === "string" ? {} : (result.metadata ?? {})
                const info = yield* agent.get(toolCtx.agent)
                const out = yield* truncate.output(output, {}, info)
                return {
                  title: "",
                  output: out.truncated ? out.content : output,
                  metadata: {
                    ...metadata,
                    truncated: out.truncated,
                    ...(out.truncated && { outputPath: out.outputPath }),
                  },
                }
              }),
          }
        }

        if (!pureMode) {
          const dirs = yield* config.directories()
          const matches = dirs.flatMap((dir) =>
            Glob.scanSync("{tool,tools}/*.{js,ts}", { cwd: dir, absolute: true, dot: true, symlink: true }),
          )
          if (matches.length) yield* config.waitForDependencies()
          for (const match of matches) {
            const namespace = path.basename(match, path.extname(match))
            // `match` is an absolute filesystem path from `Glob.scanSync(..., { absolute: true })`.
            // Import it as `file://` so Node on Windows accepts the dynamic import.
            const mod = yield* Effect.promise(() => import(pathToFileURL(match).href))
            for (const [id, def] of Object.entries<ToolDefinition>(mod)) {
              custom.push(fromPlugin(id === "default" ? namespace : `${namespace}_${id}`, def))
            }
          }

          const plugins = yield* plugin.list()
          for (const p of plugins) {
            for (const [id, def] of Object.entries(p.tool ?? {})) {
              custom.push(fromPlugin(id, def))
            }
          }
        } else {
          log.info("pure mode active: skipping custom/local/plugin tool registration")
        }
        const questionEnabled =
          ["app", "cli", "desktop"].includes(Flag.CODEMATE_CLIENT) || Flag.CODEMATE_ENABLE_QUESTION_TOOL

        const tool = yield* Effect.all({
          invalid: Tool.init(invalid),
          compress: Tool.init(compress),
          bash: Tool.init(bash),
          read: Tool.init(read),
          glob: Tool.init(globtool),
          grep: Tool.init(greptool),
          edit: Tool.init(edit),
          write: Tool.init(writetool),
          task: Tool.init(task),
          fetch: Tool.init(webfetch),
          todo: Tool.init(todo),
          planner: Tool.init(planner),
          search: Tool.init(websearch),
          skill: Tool.init(skilltool),
          patch: Tool.init(patchtool),
          question: Tool.init(question),
          lsp: Tool.init(lsptool),
          plan: Tool.init(plan),
          memorycreate: Tool.init(memorycreate),
          memorysearch: Tool.init(memorysearch),
          memoryread: Tool.init(memoryread),
          memorylist: Tool.init(memorylist),
          changelogcreate: Tool.init(changelogcreate),
          lessonwrite: Tool.init(lessonwrite),
          selfcheck: Tool.init(selfcheck),
          research: Tool.init(research),
          researchAddItems: Tool.init(researchAddItems),
          researchAddFields: Tool.init(researchAddFields),
          researchDeep: Tool.init(researchDeep),
          researchReport: Tool.init(researchReport),
          toolSearch: Tool.init(toolsearch as any),
          toolSearchRegex: Tool.init(toolsearchregex as any),
        })

        return {
          custom,
          builtin: [
            tool.invalid,
            tool.compress,
            ...(questionEnabled ? [tool.question] : []),
            tool.bash,
            tool.read,
            tool.glob,
            tool.grep,
            tool.edit,
            tool.write,
            tool.task,
            tool.fetch,
            tool.todo,
            tool.planner,
            tool.search,
            tool.skill,
            tool.patch,
            tool.toolSearch,
            tool.toolSearchRegex,
            tool.memorycreate,
            tool.memorysearch,
            tool.memoryread,
            tool.memorylist,
            tool.changelogcreate,
            tool.lessonwrite,
            tool.research,
            tool.researchAddItems,
            tool.researchAddFields,
            tool.researchDeep,
            tool.researchReport,
            tool.selfcheck,
            ...(Flag.CODEMATE_EXPERIMENTAL_LSP_TOOL ? [tool.lsp] : []),
            ...(Flag.CODEMATE_EXPERIMENTAL_PLAN_MODE && Flag.CODEMATE_CLIENT === "cli" ? [tool.plan] : []),
          ],
          task: tool.task,
          read: tool.read,
        }
      }),
    )

    yield* Effect.forkScoped(
      bus.subscribe(MCP.ToolsChanged).pipe(Stream.runForEach(() => Effect.sync(() => invalidateCatalog()))),
    )

    const all: Interface["all"] = Effect.fn("ToolRegistry.all")(function* () {
      const s = yield* InstanceState.get(state)
      return [...s.builtin, ...s.custom] as Tool.Def[]
    })

    const ids: Interface["ids"] = Effect.fn("ToolRegistry.ids")(function* () {
      return (yield* all()).map((tool) => tool.id)
    })

    const describeSkill = Effect.fn("ToolRegistry.describeSkill")(function* (agent: Agent.Info) {
      const list = yield* skill.available(agent)
      if (list.length === 0) return "No skills are currently available."
      return [
        "Load a specialized skill that provides domain-specific instructions and workflows.",
        "",
        "When you recognize that a task matches one of the available skills listed below, use this tool to load the full skill instructions.",
        "",
        "The skill will inject detailed instructions, workflows, and access to bundled resources (scripts, references, templates) into the conversation context.",
        "",
        'Tool output includes a `<skill_content name="...">` block with the loaded content.',
        "",
        "The following skills provide specialized sets of instructions for particular tasks",
        "Invoke this tool to load a skill when a task matches one of the available skills listed below:",
        "",
        Skill.fmt(list, { verbose: false }),
      ].join("\n")
    })

    const describeTask = Effect.fn("ToolRegistry.describeTask")(function* (agent: Agent.Info) {
      const items = (yield* agents.list()).filter((item) => item.mode !== "primary")
      const filtered = items.filter(
        (item) => Permission.evaluate("task", item.name, agent.permission).action !== "deny",
      )
      const list = filtered.toSorted((a, b) => a.name.localeCompare(b.name))
      const description = list
        .map(
          (item) =>
            `- ${item.name}: ${item.description ?? "This subagent should only be called manually by the user."}`,
        )
        .join("\n")
      return ["Available agent types and the tools they have access to:", description].join("\n")
    })

    const tools: Interface["tools"] = Effect.fn("ToolRegistry.tools")(function* (input) {
      const s = yield* InstanceState.get(state)
      const visibleCustom = input.sessionID
        ? s.custom.filter((tool) => revealedTools.get(input.sessionID!)?.has(tool.id))
        : s.custom
      const filtered = ([...s.builtin, ...visibleCustom] as Tool.Def[]).filter((tool) => {
        if (tool.id === WebSearchTool.id) {
          return input.providerID === ProviderID.codemate || Flag.CODEMATE_ENABLE_EXA
        }

        const usePatch =
          input.modelID.includes("gpt-") && !input.modelID.includes("oss") && !input.modelID.includes("gpt-4")
        if (tool.id === ApplyPatchTool.id) return usePatch
        if (tool.id === EditTool.id || tool.id === WriteTool.id) return !usePatch

        return true
      })

      return yield* Effect.forEach(
        filtered,
        Effect.fnUntraced(function* (tool: Tool.Def) {
          using _ = log.time(tool.id)
          const output = {
            description: tool.description,
            parameters: tool.parameters,
          }
          yield* plugin.trigger("tool.definition", { toolID: tool.id }, output)
          return {
            id: tool.id,
            description: [
              output.description,
              tool.id === TaskTool.id ? yield* describeTask(input.agent) : undefined,
              tool.id === SkillTool.id ? yield* describeSkill(input.agent) : undefined,
            ]
              .filter(Boolean)
              .join("\n"),
            parameters: output.parameters,
            execute: tool.execute,
            formatValidationError: tool.formatValidationError,
          }
        }),
        { concurrency: "unbounded" },
      )
    })

    const named: Interface["named"] = Effect.fn("ToolRegistry.named")(function* () {
      const s = yield* InstanceState.get(state)
      return { task: s.task, read: s.read }
    })

    const search: Interface["search"] = Effect.fn("ToolRegistry.search")(function* (
      query: string,
      opts?: { limit?: number; source?: string },
    ) {
      return yield* searchCatalog(query, opts)
    })

    const searchRegex: Interface["searchRegex"] = Effect.fn("ToolRegistry.searchRegex")(function* (
      pattern: string,
      opts?: { limit?: number; source?: string },
    ) {
      return yield* searchCatalogRegex(pattern, opts)
    })

    return Service.of({ ids, all, named, tools, search, searchRegex, reveal, revealed })
  }),
)

export const defaultLayer = Layer.suspend(() =>
  layer.pipe(
    Layer.provide(Config.defaultLayer),
    Layer.provide(Plugin.defaultLayer),
    Layer.provide(Question.defaultLayer),
    Layer.provide(Todo.defaultLayer),
    Layer.provide(Skill.defaultLayer),
    Layer.provide(Agent.defaultLayer),
    Layer.provide(Session.defaultLayer),
    Layer.provide(Provider.defaultLayer),
    Layer.provide(LSP.defaultLayer),
    Layer.provide(Instruction.defaultLayer),
    Layer.provide(AppFileSystem.defaultLayer),
    Layer.provide(Bus.layer),
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(Format.defaultLayer),
    Layer.provide(CrossSpawnSpawner.defaultLayer),
    Layer.provide(Ripgrep.defaultLayer),
    Layer.provide(Truncate.defaultLayer),
    Layer.provide(Memory.defaultLayer),
    Layer.provide(Changelog.defaultLayer),
    Layer.provide(MCP.defaultLayer),
  ),
)

export * as ToolRegistry from "./registry"
