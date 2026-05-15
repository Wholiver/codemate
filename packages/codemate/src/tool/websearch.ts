import { Effect, Exit, Schema } from "effect"
import { HttpClient } from "effect/unstable/http"
import * as Tool from "./tool"
import * as McpWebSearch from "./mcp-websearch"
import DESCRIPTION from "./websearch.txt"
import { Flag } from "@codemate-ai/core/flag/flag"
import { InstallationVersion } from "@codemate-ai/core/installation/version"

export const Parameters = Schema.Struct({
  query: Schema.String.annotate({ description: "Websearch query" }),
  numResults: Schema.optional(Schema.Number).annotate({
    description: "Number of search results to return (default: 8)",
  }),
  livecrawl: Schema.optional(Schema.Literals(["fallback", "preferred"])).annotate({
    description:
      "Live crawl mode - 'fallback': use live crawling as backup if cached content unavailable, 'preferred': prioritize live crawling (default: 'fallback')",
  }),
  type: Schema.optional(Schema.Literals(["auto", "fast", "deep"])).annotate({
    description: "Search type - 'auto': balanced search (default), 'fast': quick results, 'deep': comprehensive search",
  }),
  contextMaxCharacters: Schema.optional(Schema.Number).annotate({
    description: "Maximum characters for context string optimized for LLMs (default: 10000)",
  }),
})

const WebSearchProviderSchema = Schema.Literals(["exa", "parallel"])
export type WebSearchProvider = Schema.Schema.Type<typeof WebSearchProviderSchema>

export function selectWebSearchProvider(
  _sessionID: string,
  flags = { exa: Flag.codemate_ENABLE_EXA, parallel: Flag.codemate_ENABLE_PARALLEL },
): WebSearchProvider {
  const override = process.env.codemate_WEBSEARCH_PROVIDER
  if (override === "exa" || override === "parallel") return override
  if (flags.parallel) return "parallel"
  if (flags.exa) return "exa"
  return "exa"
}

export function webSearchProviderLabel(provider: unknown) {
  if (provider === "parallel") return "Parallel Web Search"
  if (provider === "exa") return "Exa Web Search"
  return "Web Search"
}

export function webSearchModelName(extra: Tool.Context["extra"]) {
  const model = extra?.model
  if (!model || typeof model !== "object") return undefined
  const api = "api" in model && model.api && typeof model.api === "object" ? model.api : undefined
  const apiID = api && "id" in api && typeof api.id === "string" ? api.id : undefined
  const id = "id" in model && typeof model.id === "string" ? model.id : undefined
  return (apiID ?? id)?.slice(0, 100)
}

function parallelAuthHeaders() {
  const headers = { "User-Agent": `codemate/${InstallationVersion}` }
  if (!process.env.PARALLEL_API_KEY) return headers
  return { ...headers, Authorization: `Bearer ${process.env.PARALLEL_API_KEY}` }
}

function callProvider(
  http: HttpClient.HttpClient,
  provider: WebSearchProvider,
  params: Schema.Schema.Type<typeof Parameters>,
  ctx: Tool.Context,
) {
  if (provider === "parallel") {
    return McpWebSearch.call(
      http,
      McpWebSearch.PARALLEL_URL,
      "web_search",
      McpWebSearch.ParallelSearchArgs,
      {
        objective: params.query,
        search_queries: [params.query],
        session_id: ctx.sessionID,
        model_name: webSearchModelName(ctx.extra),
      },
      "25 seconds",
      parallelAuthHeaders(),
    )
  }

  return McpWebSearch.call(
    http,
    McpWebSearch.EXA_URL,
    "web_search_exa",
    McpWebSearch.SearchArgs,
    {
      query: params.query,
      type: params.type || "auto",
      numResults: params.numResults || 8,
      livecrawl: params.livecrawl || "fallback",
      contextMaxCharacters: params.contextMaxCharacters,
    },
    "25 seconds",
  )
}

export const WebSearchTool = Tool.define(
  "websearch",
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient

    return {
      get description() {
        return DESCRIPTION.replace("{{year}}", new Date().getFullYear().toString())
      },
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const primaryProvider = selectWebSearchProvider(ctx.sessionID)
          const primaryTitle = webSearchProviderLabel(primaryProvider)
          yield* ctx.metadata({ title: `${primaryTitle} "${params.query}"`, metadata: { provider: primaryProvider } })

          yield* ctx.ask({
            permission: "websearch",
            patterns: [params.query],
            always: ["*"],
            metadata: {
              query: params.query,
              numResults: params.numResults,
              livecrawl: params.livecrawl,
              type: params.type,
              contextMaxCharacters: params.contextMaxCharacters,
              provider: primaryProvider,
            },
          })

          const resolved = yield* Effect.gen(function* () {
            const primaryAttempt = yield* Effect.exit(callProvider(http, primaryProvider, params, ctx))
            if (Exit.isSuccess(primaryAttempt)) {
              return {
                provider: primaryProvider,
                title: primaryTitle,
                output: primaryAttempt.value,
              }
            }

            if (primaryProvider !== "exa") yield* Effect.failCause(primaryAttempt.cause)

            const fallbackProvider: WebSearchProvider = "parallel"
            const fallbackTitle = webSearchProviderLabel(fallbackProvider)
            yield* ctx.metadata({
              title: `${primaryTitle} unavailable, retrying ${fallbackTitle} "${params.query}"`,
              metadata: { provider: fallbackProvider, fallback_from: primaryProvider },
            })
            const fallbackAttempt = yield* Effect.exit(callProvider(http, fallbackProvider, params, ctx))
            if (Exit.isSuccess(fallbackAttempt)) {
              return {
                provider: fallbackProvider,
                fallback_from: "exa" as const,
                title: fallbackTitle,
                output: fallbackAttempt.value,
              }
            }

            yield* Effect.failCause(primaryAttempt.cause)
            return yield* Effect.die("unreachable")
          })

          return {
            output: resolved.output ?? "No search results found. Please try a different query.",
            title: `${resolved.title}: ${params.query}`,
            metadata: {
              provider: resolved.provider,
              ...(resolved.fallback_from ? { fallback_from: resolved.fallback_from } : {}),
            },
          }

        }).pipe(Effect.orDie),
    }
  }),
)
