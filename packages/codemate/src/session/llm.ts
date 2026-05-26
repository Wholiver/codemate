import { Provider } from "@/provider/provider"
import * as Log from "@codemate-ai/core/util/log"
import { Context, Effect, Layer, Record } from "effect"
import * as Stream from "effect/Stream"
import { streamText, wrapLanguageModel, type ModelMessage, type Tool, tool, jsonSchema } from "ai"
import { mergeDeep } from "remeda"
import { GitLabWorkflowLanguageModel } from "gitlab-ai-provider"
import { ProviderTransform } from "@/provider/transform"
import { Config } from "@/config/config"
import { InstanceState } from "@/effect/instance-state"
import type { Agent } from "@/agent/agent"
import type { MessageV2 } from "./message-v2"
import { Plugin } from "@/plugin"
import { SystemPrompt } from "./system"
import * as LanguageRule from "./language-rule"
import { Flag } from "@codemate-ai/core/flag/flag"
import { Permission } from "@/permission"
import { PermissionID } from "@/permission/schema"
import { Bus } from "@/bus"
import { Wildcard } from "@/util/wildcard"
import { SessionID } from "@/session/schema"
import { Auth } from "@/auth"
import { Installation } from "@/installation"
import { InstallationVersion } from "@codemate-ai/core/installation/version"
import { EffectBridge } from "@/effect/bridge"
import * as Option from "effect/Option"
import * as OtelTracer from "@effect/opentelemetry/Tracer"
import type { ProviderRouteDecision, ProviderRouteTarget } from "@/provider/provider-routing"
import { ModelID, ProviderID } from "@/provider/schema"
import {
  getDefaultProviderHealthStore,
  summarizeProviderRouteAttempts,
  type ProviderRouteAttempt,
  type ProviderRouteErrorCategory,
} from "@/provider/provider-health"
import { resolveProviderTelemetryStore } from "@/provider/provider-telemetry"
import { buildProviderRouteDryRunReport } from "@/provider/provider-route-dry-run"

const log = Log.create({ service: "llm" })
export const OUTPUT_TOKEN_MAX = ProviderTransform.OUTPUT_TOKEN_MAX
type Result = Awaited<ReturnType<typeof streamText>>

// Avoid re-instantiating remeda's deep merge types in this hot LLM path; the runtime behavior is still mergeDeep.
const mergeOptions = (target: Record<string, any>, source: Record<string, any> | undefined): Record<string, any> =>
  mergeDeep(target, source ?? {}) as Record<string, any>

function asErrorMessage(error: unknown) {
  if (error instanceof Error) return error.message
  return String(error)
}

function looksLikeShellCommandToolName(toolName: string) {
  const normalized = toolName.trim()
  if (!normalized) return false
  if (/\s/.test(normalized)) return true
  if (/[|&;<>`$()]/.test(normalized)) return true
  const lower = normalized.toLowerCase()
  const shellPrefixes = [
    "ls",
    "cd",
    "pwd",
    "cat",
    "echo",
    "grep",
    "find",
    "chmod",
    "chown",
    "mkdir",
    "rm",
    "cp",
    "mv",
    "sed",
    "awk",
    "python",
    "node",
    "git",
    "openssl",
    "bash",
    "sh",
    "zsh",
  ]
  return shellPrefixes.some((prefix) => lower === prefix || lower.startsWith(`${prefix} `))
}

function isCancelledError(error: unknown) {
  if (error instanceof DOMException && error.name === "AbortError") return true
  if (error && typeof error === "object" && "name" in error && error.name === "AbortError") return true
  const message = asErrorMessage(error).toLowerCase()
  return (
    message.includes("abort") ||
    message.includes("cancelled") ||
    message.includes("canceled") ||
    message.includes("interrupted")
  )
}

function classifyProviderRouteError(error: unknown) {
  const message = asErrorMessage(error).toLowerCase()
  const status =
    error && typeof error === "object" && "statusCode" in error && typeof error.statusCode === "number"
      ? error.statusCode
      : error && typeof error === "object" && "status" in error && typeof error.status === "number"
        ? error.status
        : undefined
  if (isCancelledError(error)) {
    return { category: "cancelled" as const satisfies ProviderRouteErrorCategory, retryable: false }
  }
  if (
    message.includes("permissiondeniederror") ||
    message.includes("permissionrejectederror") ||
    message.includes("permissioncorrectederror") ||
    message.includes("questionrejectederror")
  ) {
    return { category: "permission_denied" as const satisfies ProviderRouteErrorCategory, retryable: false }
  }
  if (
    message.includes("zoderror") ||
    message.includes("schema") ||
    message.includes("validation") ||
    message.includes("invalid tool")
  ) {
    return { category: "validation_error" as const satisfies ProviderRouteErrorCategory, retryable: false }
  }
  if (status === 429) {
    return { category: "rate_limit" as const satisfies ProviderRouteErrorCategory, retryable: true }
  }
  if (status === 408 || status === 499 || status === 504) {
    return { category: "timeout" as const satisfies ProviderRouteErrorCategory, retryable: true }
  }
  if (typeof status === "number" && status >= 500) {
    return { category: "server_error" as const satisfies ProviderRouteErrorCategory, retryable: true }
  }
  if (
    message.includes("timeout") ||
    message.includes("timed out") ||
    message.includes("econnreset") ||
    message.includes("enotfound") ||
    message.includes("socket hang up") ||
    message.includes("network")
  ) {
    return { category: "network" as const satisfies ProviderRouteErrorCategory, retryable: true }
  }
  if (typeof status === "number" && status >= 400) {
    if (message.includes("model")) {
      return { category: "model_unavailable" as const satisfies ProviderRouteErrorCategory, retryable: true }
    }
    return { category: "provider_unavailable" as const satisfies ProviderRouteErrorCategory, retryable: true }
  }
  return { category: "unknown" as const satisfies ProviderRouteErrorCategory, retryable: true }
}

export type StreamInput = {
  user: MessageV2.User
  sessionID: string
  parentSessionID?: string
  model: Provider.Model
  agent: Agent.Info
  permission?: Permission.Ruleset
  system: string[]
  messages: ModelMessage[]
  small?: boolean
  tools: Record<string, Tool>
  retries?: number
  toolChoice?: "auto" | "required" | "none"
  provider_route_decision?: ProviderRouteDecision
}

export type StreamRequest = StreamInput & {
  abort: AbortSignal
}

export type Event = Result["fullStream"] extends AsyncIterable<infer T> ? T : never

export interface Interface {
  readonly stream: (input: StreamInput) => Stream.Stream<Event, unknown>
}

export class Service extends Context.Service<Service, Interface>()("@codemate/LLM") {}

const live: Layer.Layer<
  Service,
  never,
  Auth.Service | Config.Service | Provider.Service | Plugin.Service | Permission.Service
> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const auth = yield* Auth.Service
    const config = yield* Config.Service
    const provider = yield* Provider.Service
    const plugin = yield* Plugin.Service
    const perm = yield* Permission.Service

    const run = Effect.fn("LLM.run")(function* (input: StreamRequest) {
      const l = log
        .clone()
        .tag("providerID", input.model.providerID)
        .tag("modelID", input.model.id)
        .tag("session.id", input.sessionID)
        .tag("small", (input.small ?? false).toString())
        .tag("agent", input.agent.name)
        .tag("mode", input.agent.mode)
      const routeDecision = input.provider_route_decision
      l.info("stream", {
        modelID: input.model.id,
        providerID: input.model.providerID,
        providerRoute: routeDecision
          ? {
              selected_provider: routeDecision.selected.provider,
              selected_model: routeDecision.selected.model,
              source: routeDecision.source,
              fallback_count: routeDecision.fallback.length,
              warnings: routeDecision.warnings,
            }
          : undefined,
      })
      const routeEnabled = routeDecision?.enabled === true
      const routeEnabledWithFallback = routeEnabled && routeDecision.fallback.length > 0
      const circuitEnabled = routeEnabled && routeDecision.circuit_breaker.enabled
      const healthStore = getDefaultProviderHealthStore()
      const runtimeConfig = yield* config.get()
      const providerRoutingConfig = runtimeConfig.experimental?.provider_routing
      const instance = yield* InstanceState.context
      const projectRoot = instance.worktree && instance.worktree !== "/" ? instance.worktree : instance.directory
      const telemetryStoreResolved = resolveProviderTelemetryStore({
        routingEnabled: routeEnabled,
        telemetry: providerRoutingConfig?.telemetry,
        projectRoot,
      })
      if (telemetryStoreResolved.warnings.length > 0) {
        l.warn("provider telemetry warnings", {
          warnings: telemetryStoreResolved.warnings,
        })
      }
      const telemetryStore = telemetryStoreResolved.store
      const telemetryEnabled = routeEnabled && telemetryStoreResolved.config.enabled
      const outcomeMode = routeDecision?.outcome_routing?.effective_mode ?? "off"
      const outcomeMetadataEnabled = routeEnabled && outcomeMode === "dry_run"
      const routeRecommendation = outcomeMetadataEnabled ? routeDecision?.recommendation : undefined
      const dryRunReport =
        outcomeMetadataEnabled && routeDecision
          ? buildProviderRouteDryRunReport({
              decision: routeDecision,
              recommendation: routeRecommendation,
              healthStore,
              telemetryStore,
              minConfidence: routeDecision.outcome_routing.minConfidence,
              minSamples: routeDecision.outcome_routing.minSamples,
            })
          : undefined
      if (routeDecision) {
        l.info("provider route dry-run", {
          outcomeMode,
          providerRouteRecommendation: routeRecommendation,
          providerRouteDryRun: dryRunReport,
        })
      }
      const routeTargets = routeEnabled
        ? [routeDecision.selected, ...routeDecision.fallback]
        : [{ provider: input.model.providerID, model: input.model.id } satisfies ProviderRouteTarget]
      const dedupedTargets = [...new Map(routeTargets.map((item) => [`${item.provider ?? ""}::${item.model ?? ""}`, item])).values()]
      const attempts: ProviderRouteAttempt[] = []
      let lastError: unknown
      let lastRetryable = true
      const retriesPerTarget = routeEnabledWithFallback ? Math.max(1, routeDecision?.maxRetries ?? 1) : 1
      const recordAttempt = (attempt: ProviderRouteAttempt) => {
        attempts.push(attempt)
        if (circuitEnabled) healthStore.recordAttempt(attempt)
        if (telemetryEnabled) telemetryStore.recordAttempt(attempt)
      }
      for (const [targetIndex, target] of dedupedTargets.entries()) {
        const targetProvider = target.provider?.trim() || input.model.providerID
        const targetModel = target.model?.trim() || input.model.id
        if (circuitEnabled) {
          const skip = healthStore.shouldSkip(targetProvider, targetModel, new Date())
          if (skip.skip) {
            recordAttempt({
              provider: targetProvider,
              model: targetModel,
              agent: input.agent.name,
              status: "skipped",
              error_category: "provider_unavailable",
              retryable: true,
              latency_ms: 0,
              fallback_index: targetIndex,
              created_at: new Date().toISOString(),
              skipped_due_to_circuit: true,
              circuit_status: skip.status,
              skip_reason: skip.reason,
            })
            lastError = new Error(skip.reason ?? "provider skipped by circuit breaker")
            lastRetryable = true
            if (targetIndex >= dedupedTargets.length - 1) break
            continue
          }
        }
        const attemptModelResult: { ok: true; value: Provider.Model } | { ok: false; error: unknown } = yield* (
          targetProvider === input.model.providerID && targetModel === input.model.id
            ? Effect.succeed({ ok: true as const, value: input.model })
            : provider
                .getModel(ProviderID.make(targetProvider), ModelID.make(targetModel))
                .pipe(
                  Effect.map((model) => ({ ok: true as const, value: model })),
                  Effect.catchCause((error: unknown) => Effect.succeed({ ok: false as const, error })),
                )
        )
        if (!attemptModelResult.ok) {
          const error = attemptModelResult.error
          const start = Date.now()
          const classified = classifyProviderRouteError(error)
          recordAttempt({
            provider: targetProvider,
            model: targetModel,
            agent: input.agent.name,
            status: "failure",
            error_category: classified.category,
            retryable: classified.retryable,
            latency_ms: Date.now() - start,
            fallback_index: targetIndex,
            created_at: new Date().toISOString(),
          })
          lastError = error
          lastRetryable = classified.retryable
          if (!routeEnabledWithFallback || !classified.retryable || targetIndex >= dedupedTargets.length - 1) {
            break
          }
          continue
        }
        const attemptModel = attemptModelResult.value
        for (let retry = 0; retry < retriesPerTarget; retry += 1) {
          const start = Date.now()
          const attemptResult: { ok: true; result: Result } | { ok: false; error: unknown } = yield* Effect.gen(function* () {
            const [language, cfg, item, info] = yield* Effect.all(
              [
                provider.getLanguage(attemptModel),
                config.get(),
                provider.getProvider(attemptModel.providerID),
                auth.get(attemptModel.providerID),
              ],
              { concurrency: "unbounded" },
            )

            const isOpenaiOauth = item.id === "openai" && info?.type === "oauth"
            const system: string[] = []
            const activeLanguageRule =
              LanguageRule.extractLanguageRule(input.user.system) ??
              input.system.flatMap((line) => {
                const rule = LanguageRule.extractLanguageRule(line)
                if (!rule) return []
                return [rule]
              })[0]
            const userSystem = LanguageRule.stripLanguageRule(input.user.system)
            system.push(
              [
                ...(activeLanguageRule ? [activeLanguageRule] : []),
                ...(input.agent.prompt ? [input.agent.prompt] : SystemPrompt.provider(attemptModel)),
                ...input.system.flatMap((line) => {
                  const stripped = LanguageRule.stripLanguageRule(line)
                  if (!stripped) return []
                  return [stripped]
                }),
                ...(userSystem ? [userSystem] : []),
              ]
                .filter((line) => line)
                .join("\n"),
            )
            const header = system[0]
            yield* plugin.trigger(
              "experimental.chat.system.transform",
              { sessionID: input.sessionID, model: attemptModel },
              { system },
            )
            if (system.length > 2 && system[0] === header) {
              const rest = system.slice(1)
              system.length = 0
              system.push(header, rest.join("\n"))
            }

            const variant =
              !input.small && attemptModel.variants && input.user.model.variant
                ? attemptModel.variants[input.user.model.variant]
                : {}
            const base = input.small
              ? ProviderTransform.smallOptions(attemptModel)
              : ProviderTransform.options({
                  model: attemptModel,
                  sessionID: input.sessionID,
                  providerOptions: item.options,
                })
            const options = mergeOptions(mergeOptions(mergeOptions(base, attemptModel.options), input.agent.options), variant)
            if (isOpenaiOauth) options.instructions = system.join("\n")

            const messages = isOpenaiOauth
              ? input.messages
              : language instanceof GitLabWorkflowLanguageModel
                ? input.messages
                : [
                    ...system.map(
                      (line): ModelMessage => ({
                        role: "system",
                        content: line,
                      }),
                    ),
                    ...input.messages,
                  ]
            const params = yield* plugin.trigger(
              "chat.params",
              {
                sessionID: input.sessionID,
                agent: input.agent.name,
                model: attemptModel,
                provider: item,
                message: input.user,
                provider_route_decision: routeDecision,
                provider_route_attempts: attempts,
                provider_route_recommendation: routeRecommendation,
                provider_route_dry_run: dryRunReport,
              },
              {
                temperature: attemptModel.capabilities.temperature
                  ? (input.agent.temperature ?? ProviderTransform.temperature(attemptModel))
                  : undefined,
                topP: input.agent.topP ?? ProviderTransform.topP(attemptModel),
                topK: ProviderTransform.topK(attemptModel),
                maxOutputTokens: ProviderTransform.maxOutputTokens(attemptModel),
                options,
              },
            )
            const { headers } = yield* plugin.trigger(
              "chat.headers",
              {
                sessionID: input.sessionID,
                agent: input.agent.name,
                model: attemptModel,
                provider: item,
                message: input.user,
                provider_route_decision: routeDecision,
                provider_route_attempts: attempts,
                provider_route_recommendation: routeRecommendation,
                provider_route_dry_run: dryRunReport,
              },
              {
                headers: {},
              },
            )

            const tools = resolveTools(input)
            const isLiteLLMProxy =
              item.options?.["litellmProxy"] === true ||
              attemptModel.providerID.toLowerCase().includes("litellm") ||
              attemptModel.api.id.toLowerCase().includes("litellm")
            if (
              (isLiteLLMProxy || attemptModel.providerID.includes("github-copilot")) &&
              Object.keys(tools).length === 0 &&
              hasToolCalls(input.messages)
            ) {
              tools["_noop"] = tool({
                description: "Do not call this tool. It exists only for API compatibility and must never be invoked.",
                inputSchema: jsonSchema({
                  type: "object",
                  properties: {
                    reason: { type: "string", description: "Unused" },
                  },
                }),
                execute: async () => ({ output: "", title: "", metadata: {} }),
              })
            }
            const sortedTools = Object.fromEntries(Object.entries(tools).toSorted(([a], [b]) => a.localeCompare(b)))

            if (language instanceof GitLabWorkflowLanguageModel) {
              const workflowModel = language as GitLabWorkflowLanguageModel & {
                sessionID?: string
                sessionPreapprovedTools?: string[]
                approvalHandler?: (approvalTools: { name: string; args: string }[]) => Promise<{ approved: boolean }>
              }
              workflowModel.sessionID = input.sessionID
              workflowModel.systemPrompt = system.join("\n")
              workflowModel.toolExecutor = async (toolName, argsJson, _requestID) => {
                const t = sortedTools[toolName]
                if (!t || !t.execute) return { result: "", error: `Unknown tool: ${toolName}` }
                try {
                  const result = await t.execute!(JSON.parse(argsJson), {
                    toolCallId: _requestID,
                    messages: input.messages,
                    abortSignal: input.abort,
                  })
                  const output = typeof result === "string" ? result : (result?.output ?? JSON.stringify(result))
                  return {
                    result: output,
                    metadata: typeof result === "object" ? result?.metadata : undefined,
                    title: typeof result === "object" ? result?.title : undefined,
                  }
                } catch (error: any) {
                  return { result: "", error: error.message ?? String(error) }
                }
              }
              const ruleset = Permission.merge(input.agent.permission ?? [], input.permission ?? [])
              workflowModel.sessionPreapprovedTools = Object.keys(sortedTools).filter((name) => {
                const match = ruleset.findLast((rule) => Wildcard.match(name, rule.permission))
                return !match || match.action !== "ask"
              })
              const bridge = yield* EffectBridge.make()
              const approvedToolsForSession = new Set<string>()
              workflowModel.approvalHandler = InstanceState.bind(async (approvalTools) => {
                const uniqueNames = [...new Set(approvalTools.map((item: { name: string }) => item.name))]
                if (uniqueNames.every((name) => approvedToolsForSession.has(name))) return { approved: true }
                const id = PermissionID.ascending()
                let unsub: (() => void) | undefined
                try {
                  unsub = Bus.subscribe(Permission.Event.Replied, (evt) => {
                    if (evt.properties.requestID === id) void evt.properties.reply
                  })
                  const toolPatterns = approvalTools.map((item: { name: string; args: string }) => {
                    try {
                      const parsed = JSON.parse(item.args) as Record<string, unknown>
                      const title = (parsed?.title ?? parsed?.name ?? "") as string
                      return title ? `${item.name}: ${title}` : item.name
                    } catch {
                      return item.name
                    }
                  })
                  const uniquePatterns = [...new Set(toolPatterns)]
                  await bridge.promise(
                    perm.ask({
                      id,
                      sessionID: SessionID.make(input.sessionID),
                      permission: "workflow_tool_approval",
                      patterns: uniquePatterns,
                      metadata: { tools: approvalTools },
                      always: uniquePatterns,
                      ruleset: [],
                    }),
                  )
                  for (const name of uniqueNames) approvedToolsForSession.add(name)
                  workflowModel.sessionPreapprovedTools = [...(workflowModel.sessionPreapprovedTools ?? []), ...uniqueNames]
                  return { approved: true }
                } catch {
                  return { approved: false }
                } finally {
                  unsub?.()
                }
              })
            }

            const tracer = cfg.experimental?.openTelemetry
              ? Option.getOrUndefined(yield* Effect.serviceOption(OtelTracer.OtelTracer))
              : undefined
            const telemetryTracer = tracer
              ? new Proxy(tracer, {
                  get(target, prop, receiver) {
                    if (prop !== "startSpan") return Reflect.get(target, prop, receiver)
                    return (...args: Parameters<typeof target.startSpan>) => {
                      const span = target.startSpan(...args)
                      span.setAttribute("session.id", input.sessionID)
                      return span
                    }
                  },
                })
              : undefined
            const codemateProjectID = attemptModel.providerID.startsWith("codemate")
              ? (yield* InstanceState.context).project.id
              : undefined
            const result = streamText({
              // Keep existing system-message prompt semantics and silence AI SDK runtime warning spam.
              allowSystemInMessages: true,
              onError(error) {
                l.error("stream error", { error })
              },
              async experimental_repairToolCall(failed) {
                const lower = failed.toolCall.toolName.toLowerCase()
                if (lower !== failed.toolCall.toolName && sortedTools[lower]) {
                  l.info("repairing tool call", {
                    tool: failed.toolCall.toolName,
                    repaired: lower,
                  })
                  return {
                    ...failed.toolCall,
                    toolName: lower,
                  }
                }
                const unresolvedTool = failed.toolCall.toolName.trim()
                if (unresolvedTool.length > 0 && !sortedTools[unresolvedTool]) {
                  const shellLike = looksLikeShellCommandToolName(unresolvedTool)
                  return {
                    ...failed.toolCall,
                    input: JSON.stringify({
                      category: "tool_call_invalid",
                      tool: unresolvedTool,
                      error: failed.error.message,
                      error_category: "unknown_tool",
                      repair_instruction: shellLike
                        ? "use bash tool for shell commands"
                        : "use only registered tools",
                    }),
                    toolName: "invalid",
                  }
                }
                return {
                  ...failed.toolCall,
                  input: JSON.stringify({
                    category: "tool_call_invalid",
                    tool: failed.toolCall.toolName,
                    error: failed.error.message,
                    error_category: "invalid_tool_call",
                    repair_instruction: "use only registered tools",
                  }),
                  toolName: "invalid",
                }
              },
              temperature: params.temperature,
              topP: params.topP,
              topK: params.topK,
              providerOptions: ProviderTransform.providerOptions(attemptModel, params.options),
              activeTools: Object.keys(sortedTools).filter((name) => name !== "invalid"),
              tools: sortedTools,
              toolChoice: input.toolChoice,
              maxOutputTokens: params.maxOutputTokens,
              abortSignal: input.abort,
              headers: {
                ...(attemptModel.providerID.startsWith("codemate")
                  ? {
                      "x-codemate-project": codemateProjectID,
                      "x-codemate-session": input.sessionID,
                      "x-codemate-request": input.user.id,
                      "x-codemate-client": Flag.codemate_CLIENT,
                      "User-Agent": `codemate/${InstallationVersion}`,
                    }
                  : {
                      "x-session-affinity": input.sessionID,
                      ...(input.parentSessionID ? { "x-parent-session-id": input.parentSessionID } : {}),
                      "User-Agent": `codemate/${InstallationVersion}`,
                    }),
                ...attemptModel.headers,
                ...headers,
              },
              maxRetries: input.retries ?? 0,
              messages,
              model: wrapLanguageModel({
                model: language,
                middleware: [
                  {
                    specificationVersion: "v3" as const,
                    async transformParams(args) {
                      if (args.type === "stream") {
                        // @ts-expect-error
                        args.params.prompt = ProviderTransform.message(args.params.prompt, attemptModel, options)
                      }
                      return args.params
                    },
                  },
                ],
              }),
              experimental_telemetry: {
                isEnabled: cfg.experimental?.openTelemetry,
                functionId: "session.llm",
                tracer: telemetryTracer,
                metadata: {
                  userId: cfg.username ?? "unknown",
                  sessionId: input.sessionID,
                },
              },
            })
            recordAttempt({
              provider: attemptModel.providerID,
              model: attemptModel.id,
              agent: input.agent.name,
              status: "success",
              retryable: true,
              latency_ms: Date.now() - start,
              fallback_index: targetIndex,
              created_at: new Date().toISOString(),
            })
            if (attempts.length > 1 || routeEnabledWithFallback) {
              l.info("provider route attempts", {
                attempts,
                selected_provider: attemptModel.providerID,
                selected_model: attemptModel.id,
              })
            }
            return { ok: true as const, result }
          }).pipe(Effect.catchCause((error: unknown) => Effect.succeed({ ok: false as const, error })))
          if (attemptResult.ok) return attemptResult.result
          const error = attemptResult.error
          const classified = classifyProviderRouteError(error)
          recordAttempt({
            provider: attemptModel.providerID,
            model: attemptModel.id,
            agent: input.agent.name,
            status: "failure",
            error_category: classified.category,
            retryable: classified.retryable,
            latency_ms: Date.now() - start,
            fallback_index: targetIndex,
            created_at: new Date().toISOString(),
          })
          lastError = error
          lastRetryable = classified.retryable
          const hasMoreRetries = retry + 1 < retriesPerTarget
          if (hasMoreRetries && routeEnabledWithFallback && classified.retryable) continue
          break
        }
        if (!routeEnabledWithFallback || !lastRetryable || targetIndex >= dedupedTargets.length - 1) break
      }
      const summary = attempts.map((item) => {
        const status =
          item.status === "success"
            ? "success"
            : item.status === "skipped"
              ? `skipped:${item.error_category ?? "provider_unavailable"}`
              : `failure:${item.error_category ?? "unknown"}`
        return `[${item.fallback_index}] ${item.provider ?? "unknown"}/${item.model ?? "unknown"} ${status} ${item.latency_ms}ms`
      })
      const attemptSummary = summarizeProviderRouteAttempts(attempts)
      l.error("provider route attempts failed", {
        attempts,
        attemptSummary,
        providerRouteDryRun: dryRunReport,
      })
      const suffix = summary.length > 0 ? ` provider_route_attempts=${summary.join("; ")}` : ""
      const dryRunSuffix = dryRunReport
        ? ` provider_route_dry_run=${JSON.stringify({
            read_only: true,
            would_switch: dryRunReport.would_switch,
            switch_blocked_by: dryRunReport.switch_blocked_by,
            selected: dryRunReport.selected,
            recommended: dryRunReport.recommended
              ? {
                  provider: dryRunReport.recommended.provider,
                  model: dryRunReport.recommended.model,
                  confidence: dryRunReport.recommended.confidence,
                }
              : undefined,
          })}`
        : ""
      if (lastError instanceof Error) {
        const enriched = new Error(`${lastError.name}: ${lastError.message}${suffix}${dryRunSuffix}`)
        ;(enriched as { cause?: unknown }).cause = lastError
        throw enriched
      }
      throw new Error(`LLM stream failed.${suffix}${dryRunSuffix} ${asErrorMessage(lastError)}`)
    })

    const stream: Interface["stream"] = (input) =>
      Stream.scoped(
        Stream.unwrap(
          Effect.gen(function* () {
            const ctrl = yield* Effect.acquireRelease(
              Effect.sync(() => new AbortController()),
              (ctrl) => Effect.sync(() => ctrl.abort()),
            )

            const result = yield* run({ ...input, abort: ctrl.signal })

            return Stream.fromAsyncIterable(result.fullStream, (e) => (e instanceof Error ? e : new Error(String(e)))) as Stream.Stream<
              Event,
              unknown
            >
          }),
        ),
      )

    return Service.of({ stream })
  }),
)

export const layer = live.pipe(Layer.provide(Permission.defaultLayer))

export const defaultLayer = Layer.suspend(() =>
  layer.pipe(
    Layer.provide(Auth.defaultLayer),
    Layer.provide(Config.defaultLayer),
    Layer.provide(Provider.defaultLayer),
    Layer.provide(Plugin.defaultLayer),
  ),
)

function resolveTools(input: Pick<StreamInput, "tools" | "agent" | "permission" | "user">) {
  const disabled = Permission.disabled(
    Object.keys(input.tools),
    Permission.merge(input.agent.permission, input.permission ?? []),
  )
  return Record.filter(input.tools, (_, k) => input.user.tools?.[k] !== false && !disabled.has(k))
}

// Check if messages contain any tool-call content
// Used to determine if a dummy tool should be added for LiteLLM proxy compatibility
export function hasToolCalls(messages: ModelMessage[]): boolean {
  for (const msg of messages) {
    if (!Array.isArray(msg.content)) continue
    for (const part of msg.content) {
      if (part.type === "tool-call" || part.type === "tool-result") return true
    }
  }
  return false
}

export * as LLM from "./llm"
