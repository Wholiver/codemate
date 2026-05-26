import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import path from "path"
import { tool, type ModelMessage } from "ai"
import { Cause, Effect, Exit, Stream } from "effect"
import z from "zod"
import { makeRuntime } from "../../src/effect/run-service"
import { LLM } from "../../src/session/llm"
import { Instance } from "../../src/project/instance"
import { WithInstance } from "../../src/project/with-instance"
import { Provider } from "@/provider/provider"
import { ProviderTransform } from "@/provider/transform"
import { ModelsDev } from "@/provider/models"
import { ProviderID, ModelID } from "../../src/provider/schema"
import type { ProviderRouteDecision } from "@/provider/provider-routing"
import type { ProviderRouteRecommendation } from "@/provider/provider-route-scoring"
import { buildProviderRouteDryRunReport } from "@/provider/provider-route-dry-run"
import { resetDefaultProviderHealthStore } from "@/provider/provider-health"
import {
  InMemoryProviderTelemetryStore,
  JsonlProviderTelemetryStore,
  getDefaultProviderTelemetryStore,
  pathProjectProviderTelemetry,
  resetDefaultProviderTelemetryStore,
} from "@/provider/provider-telemetry"
import { Filesystem } from "@/util/filesystem"
import { tmpdir } from "../fixture/fixture"
import type { Agent } from "../../src/agent/agent"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionID, MessageID } from "../../src/session/schema"
import { AppRuntime } from "../../src/effect/app-runtime"

async function getModel(providerID: ProviderID, modelID: ModelID) {
  return AppRuntime.runPromise(
    Effect.gen(function* () {
      const provider = yield* Provider.Service
      return yield* provider.getModel(providerID, modelID)
    }),
  )
}

const llm = makeRuntime(LLM.Service, LLM.defaultLayer)

async function drain(input: LLM.StreamInput) {
  return llm.runPromise((svc) => svc.stream(input).pipe(Stream.runDrain))
}

describe("session.llm.hasToolCalls", () => {
  test("returns false for empty messages array", () => {
    expect(LLM.hasToolCalls([])).toBe(false)
  })

  test("returns false for messages with only text content", () => {
    const messages: ModelMessage[] = [
      {
        role: "user",
        content: [{ type: "text", text: "Hello" }],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "Hi there" }],
      },
    ]
    expect(LLM.hasToolCalls(messages)).toBe(false)
  })

  test("returns true when messages contain tool-call", () => {
    const messages = [
      {
        role: "user",
        content: [{ type: "text", text: "Run a command" }],
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call-123",
            toolName: "bash",
          },
        ],
      },
    ] as ModelMessage[]
    expect(LLM.hasToolCalls(messages)).toBe(true)
  })

  test("returns true when messages contain tool-result", () => {
    const messages = [
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-123",
            toolName: "bash",
          },
        ],
      },
    ] as ModelMessage[]
    expect(LLM.hasToolCalls(messages)).toBe(true)
  })

  test("returns false for messages with string content", () => {
    const messages: ModelMessage[] = [
      {
        role: "user",
        content: "Hello world",
      },
      {
        role: "assistant",
        content: "Hi there",
      },
    ]
    expect(LLM.hasToolCalls(messages)).toBe(false)
  })

  test("returns true when tool-call is mixed with text content", () => {
    const messages = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "Let me run that command" },
          {
            type: "tool-call",
            toolCallId: "call-456",
            toolName: "read",
          },
        ],
      },
    ] as ModelMessage[]
    expect(LLM.hasToolCalls(messages)).toBe(true)
  })
})

type Capture = {
  url: URL
  headers: Headers
  body: Record<string, unknown>
}

const state = {
  server: null as ReturnType<typeof Bun.serve> | null,
  queue: [] as Array<{
    path: string
    response: Response | ((req: Request, capture: Capture) => Response)
    resolve: (value: Capture) => void
  }>,
}

function deferred<T>() {
  const result = {} as { promise: Promise<T>; resolve: (value: T) => void }
  result.promise = new Promise((resolve) => {
    result.resolve = resolve
  })
  return result
}

function waitRequest(pathname: string, response: Response) {
  const pending = deferred<Capture>()
  state.queue.push({ path: pathname, response, resolve: pending.resolve })
  return pending.promise
}

function timeout(ms: number) {
  return new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms)
  })
}

function waitStreamingRequest(pathname: string) {
  const request = deferred<Capture>()
  const requestAborted = deferred<void>()
  const responseCanceled = deferred<void>()
  const encoder = new TextEncoder()

  state.queue.push({
    path: pathname,
    resolve: request.resolve,
    response(req: Request) {
      req.signal.addEventListener("abort", () => requestAborted.resolve(), { once: true })

      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              encoder.encode(
                [
                  `data: ${JSON.stringify({
                    id: "chatcmpl-abort",
                    object: "chat.completion.chunk",
                    choices: [{ delta: { role: "assistant" } }],
                  })}`,
                ].join("\n\n") + "\n\n",
              ),
            )
          },
          cancel() {
            responseCanceled.resolve()
          },
        }),
        {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        },
      )
    },
  })

  return {
    request: request.promise,
    requestAborted: requestAborted.promise,
    responseCanceled: responseCanceled.promise,
  }
}

beforeAll(() => {
  state.server = Bun.serve({
    port: 0,
    async fetch(req) {
      const next = state.queue.shift()
      if (!next) {
        return new Response("unexpected request", { status: 500 })
      }

      const url = new URL(req.url)
      const body = (await req.json()) as Record<string, unknown>
      next.resolve({ url, headers: req.headers, body })

      if (!url.pathname.endsWith(next.path)) {
        return new Response("not found", { status: 404 })
      }

      return typeof next.response === "function"
        ? next.response(req, { url, headers: req.headers, body })
        : next.response
    },
  })
})

beforeEach(() => {
  state.queue.length = 0
  resetDefaultProviderHealthStore({
    config: {
      enabled: true,
      failureThreshold: 1,
      minAttempts: 1,
      openMs: 60_000,
      halfOpenMaxAttempts: 1,
    },
  })
  resetDefaultProviderTelemetryStore()
})

afterAll(() => {
  void state.server?.stop()
})

function createChatStream(text: string) {
  const payload =
    [
      `data: ${JSON.stringify({
        id: "chatcmpl-1",
        object: "chat.completion.chunk",
        choices: [{ delta: { role: "assistant" } }],
      })}`,
      `data: ${JSON.stringify({
        id: "chatcmpl-1",
        object: "chat.completion.chunk",
        choices: [{ delta: { content: text } }],
      })}`,
      `data: ${JSON.stringify({
        id: "chatcmpl-1",
        object: "chat.completion.chunk",
        choices: [{ delta: {}, finish_reason: "stop" }],
      })}`,
      "data: [DONE]",
    ].join("\n\n") + "\n\n"

  const encoder = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(payload))
      controller.close()
    },
  })
}

async function loadFixture(providerID: string, modelID: string) {
  const fixturePath = path.join(import.meta.dir, "../tool/fixtures/models-api.json")
  const data = await Filesystem.readJson<Record<string, ModelsDev.Provider>>(fixturePath)
  const provider = data[providerID]
  if (!provider) {
    throw new Error(`Missing provider in fixture: ${providerID}`)
  }
  const model = provider.models[modelID]
  if (!model) {
    throw new Error(`Missing model in fixture: ${modelID}`)
  }
  return { provider, model }
}

function createEventStream(chunks: unknown[], includeDone = false) {
  const lines = chunks.map((chunk) => `data: ${typeof chunk === "string" ? chunk : JSON.stringify(chunk)}`)
  if (includeDone) {
    lines.push("data: [DONE]")
  }
  const payload = lines.join("\n\n") + "\n\n"
  const encoder = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(payload))
      controller.close()
    },
  })
}

function createEventResponse(chunks: unknown[], includeDone = false) {
  return new Response(createEventStream(chunks, includeDone), {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  })
}

function routeDecision(input: {
  enabled: boolean
  selectedProvider: string
  selectedModel: string
  fallback?: Array<{ provider: string; model: string }>
  circuitEnabled?: boolean
  outcomeMode?: "off" | "dry_run" | "enabled"
  minConfidence?: number
  minSamples?: number
  recommendation?: ProviderRouteRecommendation
}): ProviderRouteDecision {
  return {
    enabled: input.enabled,
    agent: "coder",
    selected: {
      provider: input.selectedProvider,
      model: input.selectedModel,
    },
    fallback: input.fallback ?? [],
    maxRetries: 1,
    timeoutMs: undefined,
    reason: "test-route",
    warnings: [],
    source: input.enabled ? "agent-route" : "disabled",
    circuit_breaker: {
      enabled: input.circuitEnabled === true,
      failureThreshold: 3,
      openMs: 60_000,
      halfOpenMaxAttempts: 1,
      minAttempts: 3,
    },
    skipped_due_to_circuit: [],
    fallback_used_due_to_health: false,
    recommendation: input.recommendation,
    outcome_routing: {
      mode: input.outcomeMode ?? "off",
      effective_mode: input.outcomeMode === "off" || input.outcomeMode === undefined ? "off" : "dry_run",
      minConfidence: input.minConfidence ?? 0.65,
      minSamples: input.minSamples ?? 5,
    },
  }
}

describe("session.llm.stream", () => {
  test("sends temperature, tokens, and reasoning options for openai-compatible models", async () => {
    const server = state.server
    if (!server) {
      throw new Error("Server not initialized")
    }

    const providerID = "vivgrid"
    const modelID = "gemini-3.1-pro-preview"
    const fixture = await loadFixture(providerID, modelID)
    const model = fixture.model

    const request = waitRequest(
      "/chat/completions",
      new Response(createChatStream("Hello"), {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      }),
    )

    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(
          path.join(dir, "codemate.json"),
          JSON.stringify({
            $schema: "https://codemate.ai/config.json",
            enabled_providers: [providerID],
            provider: {
              [providerID]: {
                options: {
                  apiKey: "test-key",
                  baseURL: `${server.url.origin}/v1`,
                },
              },
            },
          }),
        )
      },
    })

    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const resolved = await getModel(ProviderID.make(providerID), ModelID.make(model.id))
        const sessionID = SessionID.make("session-test-1")
        const agent = {
          name: "test",
          mode: "primary",
          options: {},
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
          temperature: 0.4,
          topP: 0.8,
        } satisfies Agent.Info

        const user = {
          id: MessageID.make("msg_user-1"),
          sessionID,
          role: "user",
          time: { created: Date.now() },
          agent: agent.name,
          model: { providerID: ProviderID.make(providerID), modelID: resolved.id, variant: "high" },
        } satisfies MessageV2.User

        await drain({
          user,
          sessionID,
          model: resolved,
          agent,
          system: ["You are a helpful assistant."],
          messages: [{ role: "user", content: "Hello" }],
          tools: {},
        })

        const capture = await request
        const body = capture.body
        const headers = capture.headers
        const url = capture.url

        expect(url.pathname.startsWith("/v1/")).toBe(true)
        expect(url.pathname.endsWith("/chat/completions")).toBe(true)
        expect(headers.get("Authorization")).toBe("Bearer test-key")

        expect(body.model).toBe(resolved.api.id)
        expect(body.temperature).toBe(0.4)
        expect(body.top_p).toBe(0.8)
        expect(body.stream).toBe(true)

        const maxTokens = (body.max_tokens as number | undefined) ?? (body.max_output_tokens as number | undefined)
        const expectedMaxTokens = ProviderTransform.maxOutputTokens(resolved)
        expect(maxTokens).toBe(expectedMaxTokens)

        const reasoning = (body.reasoningEffort as string | undefined) ?? (body.reasoning_effort as string | undefined)
        expect(reasoning).toBe("high")
      },
    })
  })

  test("service stream cancellation cancels provider response body promptly", async () => {
    const server = state.server
    if (!server) throw new Error("Server not initialized")

    const providerID = "alibaba"
    const modelID = "qwen-plus"
    const fixture = await loadFixture(providerID, modelID)
    const model = fixture.model
    const pending = waitStreamingRequest("/chat/completions")

    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(
          path.join(dir, "codemate.json"),
          JSON.stringify({
            $schema: "https://codemate.ai/config.json",
            enabled_providers: [providerID],
            provider: {
              [providerID]: {
                options: {
                  apiKey: "test-key",
                  baseURL: `${server.url.origin}/v1`,
                },
              },
            },
          }),
        )
      },
    })

    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const resolved = await getModel(ProviderID.make(providerID), ModelID.make(model.id))
        const sessionID = SessionID.make("session-test-service-abort")
        const agent = {
          name: "test",
          mode: "primary",
          options: {},
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        } satisfies Agent.Info
        const user = {
          id: MessageID.make("msg_user-service-abort"),
          sessionID,
          role: "user",
          time: { created: Date.now() },
          agent: agent.name,
          model: { providerID: ProviderID.make(providerID), modelID: resolved.id },
        } satisfies MessageV2.User

        const ctrl = new AbortController()
        const run = llm.runPromiseExit(
          (svc) =>
            svc
              .stream({
                user,
                sessionID,
                model: resolved,
                agent,
                system: ["You are a helpful assistant."],
                messages: [{ role: "user", content: "Hello" }],
                tools: {},
              })
              .pipe(Stream.runDrain),
          { signal: ctrl.signal },
        )

        await pending.request
        ctrl.abort()

        await Promise.race([pending.responseCanceled, timeout(500)])
        const exit = await run
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          expect(Cause.hasInterrupts(exit.cause)).toBe(true)
        }
        await Promise.race([pending.requestAborted, timeout(500)]).catch(() => undefined)
      },
    })
  })

  test("keeps tools enabled by prompt permissions", async () => {
    const server = state.server
    if (!server) {
      throw new Error("Server not initialized")
    }

    const providerID = "alibaba"
    const modelID = "qwen-plus"
    const fixture = await loadFixture(providerID, modelID)
    const model = fixture.model

    const request = waitRequest(
      "/chat/completions",
      new Response(createChatStream("Hello"), {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      }),
    )

    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(
          path.join(dir, "codemate.json"),
          JSON.stringify({
            $schema: "https://codemate.ai/config.json",
            enabled_providers: [providerID],
            provider: {
              [providerID]: {
                options: {
                  apiKey: "test-key",
                  baseURL: `${server.url.origin}/v1`,
                },
              },
            },
          }),
        )
      },
    })

    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const resolved = await getModel(ProviderID.make(providerID), ModelID.make(model.id))
        const sessionID = SessionID.make("session-test-tools")
        const agent = {
          name: "test",
          mode: "primary",
          options: {},
          permission: [{ permission: "question", pattern: "*", action: "deny" }],
        } satisfies Agent.Info

        const user = {
          id: MessageID.make("msg_user-tools"),
          sessionID,
          role: "user",
          time: { created: Date.now() },
          agent: agent.name,
          model: { providerID: ProviderID.make(providerID), modelID: resolved.id },
          tools: { question: true },
        } satisfies MessageV2.User

        await drain({
          user,
          sessionID,
          model: resolved,
          agent,
          permission: [{ permission: "question", pattern: "*", action: "allow" }],
          system: ["You are a helpful assistant."],
          messages: [{ role: "user", content: "Hello" }],
          tools: {
            question: tool({
              description: "Ask a question",
              inputSchema: z.object({}),
              execute: async () => ({ output: "" }),
            }),
          },
        })

        const capture = await request
        const tools = capture.body.tools as Array<{ function?: { name?: string } }> | undefined
        expect(tools?.some((item) => item.function?.name === "question")).toBe(true)
      },
    })
  })

  test("sends responses API payload for OpenAI models", async () => {
    const server = state.server
    if (!server) {
      throw new Error("Server not initialized")
    }

    const source = await loadFixture("openai", "gpt-5.2")
    const model = source.model

    const responseChunks = [
      {
        type: "response.created",
        response: {
          id: "resp-1",
          created_at: Math.floor(Date.now() / 1000),
          model: model.id,
          service_tier: null,
        },
      },
      {
        type: "response.output_text.delta",
        item_id: "item-1",
        delta: "Hello",
        logprobs: null,
      },
      {
        type: "response.completed",
        response: {
          incomplete_details: null,
          usage: {
            input_tokens: 1,
            input_tokens_details: null,
            output_tokens: 1,
            output_tokens_details: null,
          },
          service_tier: null,
        },
      },
    ]
    const request = waitRequest("/responses", createEventResponse(responseChunks, true))

    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(
          path.join(dir, "codemate.json"),
          JSON.stringify({
            $schema: "https://codemate.ai/config.json",
            enabled_providers: ["openai"],
            provider: {
              openai: {
                name: "OpenAI",
                env: ["OPENAI_API_KEY"],
                npm: "@ai-sdk/openai",
                api: "https://api.openai.com/v1",
                models: {
                  [model.id]: model,
                },
                options: {
                  apiKey: "test-openai-key",
                  baseURL: `${server.url.origin}/v1`,
                },
              },
            },
          }),
        )
      },
    })

    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const resolved = await getModel(ProviderID.openai, ModelID.make(model.id))
        const sessionID = SessionID.make("session-test-2")
        const agent = {
          name: "test",
          mode: "primary",
          options: {},
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
          temperature: 0.2,
        } satisfies Agent.Info

        const user = {
          id: MessageID.make("msg_user-2"),
          sessionID,
          role: "user",
          time: { created: Date.now() },
          agent: agent.name,
          model: { providerID: ProviderID.make("openai"), modelID: resolved.id, variant: "high" },
        } satisfies MessageV2.User

        await drain({
          user,
          sessionID,
          model: resolved,
          agent,
          system: ["You are a helpful assistant."],
          messages: [{ role: "user", content: "Hello" }],
          tools: {},
        })

        const capture = await request
        const body = capture.body

        expect(capture.url.pathname.endsWith("/responses")).toBe(true)
        expect(body.model).toBe(resolved.api.id)
        expect(body.stream).toBe(true)
        expect((body.reasoning as { effort?: string } | undefined)?.effort).toBe("high")

        const maxTokens = body.max_output_tokens as number | undefined
        expect(maxTokens).toBe(ProviderTransform.maxOutputTokens(resolved))
      },
    })
  })

  test("accepts user image attachments as data URLs for OpenAI models", async () => {
    const server = state.server
    if (!server) {
      throw new Error("Server not initialized")
    }

    const source = await loadFixture("openai", "gpt-5.2")
    const model = source.model
    const chunks = [
      {
        type: "response.created",
        response: {
          id: "resp-data-url",
          created_at: Math.floor(Date.now() / 1000),
          model: model.id,
          service_tier: null,
        },
      },
      {
        type: "response.output_text.delta",
        item_id: "item-data-url",
        delta: "Looks good",
        logprobs: null,
      },
      {
        type: "response.completed",
        response: {
          incomplete_details: null,
          usage: {
            input_tokens: 1,
            input_tokens_details: null,
            output_tokens: 1,
            output_tokens_details: null,
          },
          service_tier: null,
        },
      },
    ]
    const request = waitRequest("/responses", createEventResponse(chunks, true))
    const image = `data:image/png;base64,${Buffer.from(
      await Bun.file(path.join(import.meta.dir, "../tool/fixtures/large-image.png")).arrayBuffer(),
    ).toString("base64")}`

    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(
          path.join(dir, "codemate.json"),
          JSON.stringify({
            $schema: "https://codemate.ai/config.json",
            enabled_providers: ["openai"],
            provider: {
              openai: {
                name: "OpenAI",
                env: ["OPENAI_API_KEY"],
                npm: "@ai-sdk/openai",
                api: "https://api.openai.com/v1",
                models: {
                  [model.id]: model,
                },
                options: {
                  apiKey: "test-openai-key",
                  baseURL: `${server.url.origin}/v1`,
                },
              },
            },
          }),
        )
      },
    })

    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const resolved = await getModel(ProviderID.openai, ModelID.make(model.id))
        const sessionID = SessionID.make("session-test-data-url")
        const agent = {
          name: "test",
          mode: "primary",
          options: {},
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        } satisfies Agent.Info

        const user = {
          id: MessageID.make("msg_user-data-url"),
          sessionID,
          role: "user",
          time: { created: Date.now() },
          agent: agent.name,
          model: { providerID: ProviderID.make("openai"), modelID: resolved.id },
        } satisfies MessageV2.User

        await drain({
          user,
          sessionID,
          model: resolved,
          agent,
          system: ["You are a helpful assistant."],
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: "Describe this image" },
                {
                  type: "file",
                  mediaType: "image/png",
                  filename: "large-image.png",
                  data: image,
                },
              ],
            },
          ] as ModelMessage[],
          tools: {},
        })

        const capture = await request
        expect(capture.url.pathname.endsWith("/responses")).toBe(true)
      },
    })
  })

  test("sends messages API payload for Anthropic Compatible models", async () => {
    const server = state.server
    if (!server) {
      throw new Error("Server not initialized")
    }

    const providerID = "minimax"
    const modelID = "MiniMax-M2.5"
    const fixture = await loadFixture(providerID, modelID)
    const model = fixture.model

    const chunks = [
      {
        type: "message_start",
        message: {
          id: "msg-1",
          model: model.id,
          usage: {
            input_tokens: 3,
            cache_creation_input_tokens: null,
            cache_read_input_tokens: null,
          },
        },
      },
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "Hello" },
      },
      { type: "content_block_stop", index: 0 },
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null, container: null },
        usage: {
          input_tokens: 3,
          output_tokens: 2,
          cache_creation_input_tokens: null,
          cache_read_input_tokens: null,
        },
      },
      { type: "message_stop" },
    ]
    const request = waitRequest("/messages", createEventResponse(chunks))

    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(
          path.join(dir, "codemate.json"),
          JSON.stringify({
            $schema: "https://codemate.ai/config.json",
            enabled_providers: [providerID],
            provider: {
              [providerID]: {
                options: {
                  apiKey: "test-anthropic-key",
                  baseURL: `${server.url.origin}/v1`,
                },
              },
            },
          }),
        )
      },
    })

    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const resolved = await getModel(ProviderID.make(providerID), ModelID.make(model.id))
        const sessionID = SessionID.make("session-test-3")
        const agent = {
          name: "test",
          mode: "primary",
          options: {},
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
          temperature: 0.4,
          topP: 0.9,
        } satisfies Agent.Info

        const user = {
          id: MessageID.make("msg_user-3"),
          sessionID,
          role: "user",
          time: { created: Date.now() },
          agent: agent.name,
          model: { providerID: ProviderID.make("minimax"), modelID: ModelID.make("MiniMax-M2.5") },
        } satisfies MessageV2.User

        await drain({
          user,
          sessionID,
          model: resolved,
          agent,
          system: ["You are a helpful assistant."],
          messages: [{ role: "user", content: "Hello" }],
          tools: {},
        })

        const capture = await request
        const body = capture.body

        expect(capture.url.pathname.endsWith("/messages")).toBe(true)
        expect(body.model).toBe(resolved.api.id)
        expect(body.max_tokens).toBe(ProviderTransform.maxOutputTokens(resolved))
        expect(body.temperature).toBe(0.4)
        expect(body.top_p).toBe(0.9)
      },
    })
  })

  test("sends anthropic tool_use blocks with tool_result immediately after them", async () => {
    const server = state.server
    if (!server) {
      throw new Error("Server not initialized")
    }

    const source = await loadFixture("anthropic", "claude-opus-4-6")
    const model = source.model
    const chunks = [
      {
        type: "message_start",
        message: {
          id: "msg-tool-order",
          model: model.id,
          usage: {
            input_tokens: 3,
            cache_creation_input_tokens: null,
            cache_read_input_tokens: null,
          },
        },
      },
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "ok" },
      },
      { type: "content_block_stop", index: 0 },
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null, container: null },
        usage: {
          input_tokens: 3,
          output_tokens: 2,
          cache_creation_input_tokens: null,
          cache_read_input_tokens: null,
        },
      },
      { type: "message_stop" },
    ]
    const request = waitRequest("/messages", createEventResponse(chunks))

    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(
          path.join(dir, "codemate.json"),
          JSON.stringify({
            $schema: "https://codemate.ai/config.json",
            enabled_providers: ["anthropic"],
            provider: {
              anthropic: {
                name: "Anthropic",
                env: ["ANTHROPIC_API_KEY"],
                npm: "@ai-sdk/anthropic",
                api: "https://api.anthropic.com/v1",
                models: {
                  [model.id]: model,
                },
                options: {
                  apiKey: "test-anthropic-key",
                  baseURL: `${server.url.origin}/v1`,
                },
              },
            },
          }),
        )
      },
    })

    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const resolved = await getModel(ProviderID.make("anthropic"), ModelID.make(model.id))
        const sessionID = SessionID.make("session-test-anthropic-tools")
        const agent = {
          name: "test",
          mode: "primary",
          options: {},
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        } satisfies Agent.Info
        const user = {
          id: MessageID.make("msg_user-anthropic-tools"),
          sessionID,
          role: "user",
          time: { created: Date.now() },
          agent: agent.name,
          model: { providerID: ProviderID.make("anthropic"), modelID: resolved.id, variant: "max" },
        } satisfies MessageV2.User

        const input = [
          {
            info: {
              id: "msg_user",
              sessionID,
              role: "user",
              time: { created: 1 },
              agent: "gentleman",
              model: { providerID: "anthropic", modelID: "claude-opus-4-6", variant: "max" },
            },
            parts: [
              {
                id: "p_user",
                sessionID,
                messageID: "msg_user",
                type: "text",
                text: "Can you check whether there are any PDF files in my home directory?",
              },
            ],
          },
          {
            info: {
              id: "msg_call",
              sessionID,
              parentID: "msg_user",
              role: "assistant",
              mode: "gentleman",
              agent: "gentleman",
              variant: "max",
              path: { cwd: "/root", root: "/" },
              cost: 0,
              tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
              modelID: "claude-opus-4-6",
              providerID: "anthropic",
              time: { created: 2, completed: 3 },
              finish: "tool-calls",
            },
            parts: [
              {
                id: "p_step",
                sessionID,
                messageID: "msg_call",
                type: "step-start",
              },
              {
                id: "p_read",
                sessionID,
                messageID: "msg_call",
                type: "tool",
                tool: "read",
                callID: "toolu_01N8mDEzG8DSTs7UPHFtmgCT",
                state: {
                  status: "completed",
                  input: { filePath: "/root" },
                  output: "<path>/root</path>",
                  metadata: {},
                  title: "root",
                  time: { start: 10, end: 11 },
                },
              },
              {
                id: "p_glob",
                sessionID,
                messageID: "msg_call",
                type: "tool",
                tool: "glob",
                callID: "toolu_01APxrADs7VozN8uWzw9WwHr",
                state: {
                  status: "completed",
                  input: { pattern: "**/*.pdf", path: "/root" },
                  output: "No files found",
                  metadata: {},
                  title: "root",
                  time: { start: 12, end: 13 },
                },
              },
              {
                id: "p_text",
                sessionID,
                messageID: "msg_call",
                type: "text",
                text: "I checked your home directory and looked for PDF files.",
                time: { start: 14, end: 15 },
              },
            ],
          },
        ] as any[]

        await drain({
          user,
          sessionID,
          model: resolved,
          agent,
          system: [],
          messages: await MessageV2.toModelMessages(input as any, resolved),
          tools: {
            read: tool({
              description: "Stub read tool",
              inputSchema: z.object({
                filePath: z.string(),
              }),
              execute: async () => ({ output: "stub" }),
            }),
            glob: tool({
              description: "Stub glob tool",
              inputSchema: z.object({
                pattern: z.string(),
                path: z.string().optional(),
              }),
              execute: async () => ({ output: "stub" }),
            }),
          },
        })

        const capture = await request
        const body = capture.body

        expect(capture.url.pathname.endsWith("/messages")).toBe(true)
        expect(body.messages).toStrictEqual([
          {
            role: "user",
            content: [{ type: "text", text: "Can you check whether there are any PDF files in my home directory?" }],
          },
          {
            role: "assistant",
            content: [
              {
                type: "text",
                text: "I checked your home directory and looked for PDF files.",
              },
              {
                type: "tool_use",
                id: "toolu_01N8mDEzG8DSTs7UPHFtmgCT",
                name: "read",
                input: { filePath: "/root" },
              },
              {
                type: "tool_use",
                id: "toolu_01APxrADs7VozN8uWzw9WwHr",
                name: "glob",
                input: { pattern: "**/*.pdf", path: "/root" },
                cache_control: {
                  type: "ephemeral",
                },
              },
            ],
          },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "toolu_01N8mDEzG8DSTs7UPHFtmgCT",
                content: "<path>/root</path>",
              },
              {
                type: "tool_result",
                tool_use_id: "toolu_01APxrADs7VozN8uWzw9WwHr",
                content: "No files found",
                cache_control: {
                  type: "ephemeral",
                },
              },
            ],
          },
        ])
      },
    })
  })

  test("sends Google API payload for Gemini models", async () => {
    const server = state.server
    if (!server) {
      throw new Error("Server not initialized")
    }

    const providerID = "google"
    const modelID = "gemini-2.5-flash"
    const fixture = await loadFixture(providerID, modelID)
    const model = fixture.model
    const pathSuffix = `/v1beta/models/${model.id}:streamGenerateContent`

    const chunks = [
      {
        candidates: [
          {
            content: {
              parts: [{ text: "Hello" }],
            },
            finishReason: "STOP",
          },
        ],
        usageMetadata: {
          promptTokenCount: 1,
          candidatesTokenCount: 1,
          totalTokenCount: 2,
        },
      },
    ]
    const request = waitRequest(pathSuffix, createEventResponse(chunks))

    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(
          path.join(dir, "codemate.json"),
          JSON.stringify({
            $schema: "https://codemate.ai/config.json",
            enabled_providers: [providerID],
            provider: {
              [providerID]: {
                options: {
                  apiKey: "test-google-key",
                  baseURL: `${server.url.origin}/v1beta`,
                },
              },
            },
          }),
        )
      },
    })

    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const resolved = await getModel(ProviderID.make(providerID), ModelID.make(model.id))
        const sessionID = SessionID.make("session-test-4")
        const agent = {
          name: "test",
          mode: "primary",
          options: {},
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
          temperature: 0.3,
          topP: 0.8,
        } satisfies Agent.Info

        const user = {
          id: MessageID.make("msg_user-4"),
          sessionID,
          role: "user",
          time: { created: Date.now() },
          agent: agent.name,
          model: { providerID: ProviderID.make(providerID), modelID: resolved.id },
        } satisfies MessageV2.User

        await drain({
          user,
          sessionID,
          model: resolved,
          agent,
          system: ["You are a helpful assistant."],
          messages: [{ role: "user", content: "Hello" }],
          tools: {},
        })

        const capture = await request
        const body = capture.body
        const config = body.generationConfig as
          | { temperature?: number; topP?: number; maxOutputTokens?: number }
          | undefined

        expect(capture.url.pathname).toBe(pathSuffix)
        expect(config?.temperature).toBe(0.3)
        expect(config?.topP).toBe(0.8)
        expect(config?.maxOutputTokens).toBe(ProviderTransform.maxOutputTokens(resolved))
      },
    })
  })

  test("provider routing disabled does not execute fallback attempts", async () => {
    const server = state.server
    if (!server) throw new Error("Server not initialized")
    const primaryProviderID = "alibaba"
    const primaryModelID = "qwen-plus"
    const fallbackProviderID = "vivgrid"
    const fallbackModelID = "gemini-3.1-pro-preview"
    const primaryFixture = await loadFixture(primaryProviderID, primaryModelID)
    const fallbackFixture = await loadFixture(fallbackProviderID, fallbackModelID)
    const first = waitRequest(
      "/chat/completions",
      new Response(createChatStream("primary success"), {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      }),
    )
    waitRequest(
      "/chat/completions",
      new Response(createChatStream("fallback should not run"), {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      }),
    )
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(
          path.join(dir, "codemate.json"),
          JSON.stringify({
            $schema: "https://codemate.ai/config.json",
            enabled_providers: [primaryProviderID, fallbackProviderID],
            provider: {
              [primaryProviderID]: {
                options: { apiKey: "primary-key", baseURL: `${server.url.origin}/v1` },
              },
              [fallbackProviderID]: {
                options: { apiKey: "fallback-key", baseURL: `${server.url.origin}/v1` },
              },
            },
          }),
        )
      },
    })
    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const resolvedPrimary = await getModel(ProviderID.make(primaryProviderID), ModelID.make(primaryFixture.model.id))
        const resolvedFallback = await getModel(ProviderID.make(fallbackProviderID), ModelID.make(fallbackFixture.model.id))
        const sessionID = SessionID.make("session-test-route-disabled")
        const agent = {
          name: "test",
          mode: "primary",
          options: {},
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        } satisfies Agent.Info
        const user = {
          id: MessageID.make("msg_user-route-disabled"),
          sessionID,
          role: "user",
          time: { created: Date.now() },
          agent: agent.name,
          model: { providerID: ProviderID.make(primaryProviderID), modelID: resolvedPrimary.id },
        } satisfies MessageV2.User
        await expect(
          drain({
            user,
            sessionID,
            model: resolvedPrimary,
            agent,
            system: ["You are a helpful assistant."],
            messages: [{ role: "user", content: "hello" }],
            tools: {},
            provider_route_decision: routeDecision({
              enabled: false,
              selectedProvider: primaryProviderID,
              selectedModel: resolvedPrimary.id,
              fallback: [{ provider: fallbackProviderID, model: resolvedFallback.id }],
            }),
          }),
        ).resolves.toBeUndefined()
        await first
        expect(state.queue.length).toBe(1)
      },
    })
  })

  test("provider routing enabled falls back after primary failure", async () => {
    const server = state.server
    if (!server) throw new Error("Server not initialized")
    const primaryProviderID = "alibaba"
    const primaryModelID = "qwen-plus"
    const fallbackProviderID = "vivgrid"
    const fallbackModelID = "gemini-3.1-pro-preview"
    const primaryFixture = await loadFixture(primaryProviderID, primaryModelID)
    const fallbackFixture = await loadFixture(fallbackProviderID, fallbackModelID)
    const fallbackRequest = waitRequest(
      "/chat/completions",
      new Response(createChatStream("fallback success"), {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      }),
    )
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(
          path.join(dir, "codemate.json"),
          JSON.stringify({
            $schema: "https://codemate.ai/config.json",
            enabled_providers: [primaryProviderID, fallbackProviderID],
            provider: {
              [primaryProviderID]: {
                options: { apiKey: "primary-key", baseURL: `${server.url.origin}/v1` },
              },
              [fallbackProviderID]: {
                options: { apiKey: "fallback-key", baseURL: `${server.url.origin}/v1` },
              },
            },
          }),
        )
      },
    })
    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const resolvedPrimary = await getModel(ProviderID.make(primaryProviderID), ModelID.make(primaryFixture.model.id))
        const resolvedFallback = await getModel(ProviderID.make(fallbackProviderID), ModelID.make(fallbackFixture.model.id))
        const sessionID = SessionID.make("session-test-route-fallback-success")
        const agent = {
          name: "test",
          mode: "primary",
          options: {},
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        } satisfies Agent.Info
        const user = {
          id: MessageID.make("msg_user-route-fallback-success"),
          sessionID,
          role: "user",
          time: { created: Date.now() },
          agent: agent.name,
          model: { providerID: ProviderID.make(primaryProviderID), modelID: resolvedPrimary.id },
        } satisfies MessageV2.User
        await expect(
          drain({
            user,
            sessionID,
            model: resolvedPrimary,
            agent,
            system: ["You are a helpful assistant."],
            messages: [{ role: "user", content: "hello" }],
            tools: {},
            provider_route_decision: routeDecision({
              enabled: true,
              selectedProvider: "unknown-provider-primary",
              selectedModel: "missing-model-primary",
              fallback: [{ provider: fallbackProviderID, model: resolvedFallback.id }],
              outcomeMode: "dry_run",
              recommendation: {
                read_only: true,
                recommended: { provider: fallbackProviderID, model: resolvedFallback.id },
                scores: [],
                reason: "test",
                confidence: 0.9,
                warnings: [],
              },
            }),
          }),
        ).resolves.toBeUndefined()
        const capture = await fallbackRequest
        expect(capture.headers.get("Authorization")).toBe("Bearer fallback-key")
        expect(JSON.stringify(capture.body.messages ?? capture.body.input ?? "")).not.toContain("provider_route_dry_run")
      },
    })
  })

  test("provider routing enabled returns readable error when all fallbacks fail", async () => {
    const server = state.server
    if (!server) throw new Error("Server not initialized")
    const primaryProviderID = "alibaba"
    const primaryModelID = "qwen-plus"
    const fallbackProviderID = "vivgrid"
    const fallbackModelID = "gemini-3.1-pro-preview"
    const primaryFixture = await loadFixture(primaryProviderID, primaryModelID)
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(
          path.join(dir, "codemate.json"),
          JSON.stringify({
            $schema: "https://codemate.ai/config.json",
            enabled_providers: [primaryProviderID, fallbackProviderID],
            provider: {
              [primaryProviderID]: {
                options: { apiKey: "primary-key", baseURL: `${server.url.origin}/v1` },
              },
              [fallbackProviderID]: {
                options: { apiKey: "fallback-key", baseURL: `${server.url.origin}/v1` },
              },
            },
          }),
        )
      },
    })
    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const resolvedPrimary = await getModel(ProviderID.make(primaryProviderID), ModelID.make(primaryFixture.model.id))
        const sessionID = SessionID.make("session-test-route-fallback-fail")
        const agent = {
          name: "test",
          mode: "primary",
          options: {},
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        } satisfies Agent.Info
        const user = {
          id: MessageID.make("msg_user-route-fallback-fail"),
          sessionID,
          role: "user",
          time: { created: Date.now() },
          agent: agent.name,
          model: { providerID: ProviderID.make(primaryProviderID), modelID: resolvedPrimary.id },
        } satisfies MessageV2.User
        try {
          await drain({
            user,
            sessionID,
            model: resolvedPrimary,
            agent,
            system: ["You are a helpful assistant."],
            messages: [{ role: "user", content: "hello" }],
            tools: {},
            provider_route_decision: routeDecision({
              enabled: true,
              selectedProvider: "unknown-provider-primary",
              selectedModel: "missing-model-primary",
              fallback: [{ provider: "unknown-provider-fallback", model: "missing-model-fallback" }],
              outcomeMode: "off",
            }),
          })
          throw new Error("expected failure")
        } catch (error) {
          const message = String(error)
          expect(message).toContain("provider_route_attempts=")
          expect(message).not.toContain("provider_route_dry_run=")
        }
      },
    })
  })

  test("provider routing dry_run mode attaches dry-run metadata on failure", async () => {
    const server = state.server
    if (!server) throw new Error("Server not initialized")
    const primaryProviderID = "alibaba"
    const primaryModelID = "qwen-plus"
    const fallbackProviderID = "vivgrid"
    const fallbackModelID = "gemini-3.1-pro-preview"
    const primaryFixture = await loadFixture(primaryProviderID, primaryModelID)
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(
          path.join(dir, "codemate.json"),
          JSON.stringify({
            $schema: "https://codemate.ai/config.json",
            enabled_providers: [primaryProviderID, fallbackProviderID],
            provider: {
              [primaryProviderID]: {
                options: { apiKey: "primary-key", baseURL: `${server.url.origin}/v1` },
              },
              [fallbackProviderID]: {
                options: { apiKey: "fallback-key", baseURL: `${server.url.origin}/v1` },
              },
            },
          }),
        )
      },
    })
    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const resolvedPrimary = await getModel(ProviderID.make(primaryProviderID), ModelID.make(primaryFixture.model.id))
        const sessionID = SessionID.make("session-test-route-fallback-fail-dryrun")
        const agent = {
          name: "test",
          mode: "primary",
          options: {},
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        } satisfies Agent.Info
        const user = {
          id: MessageID.make("msg_user-route-fallback-fail-dryrun"),
          sessionID,
          role: "user",
          time: { created: Date.now() },
          agent: agent.name,
          model: { providerID: ProviderID.make(primaryProviderID), modelID: resolvedPrimary.id },
        } satisfies MessageV2.User
        await expect(
          drain({
            user,
            sessionID,
            model: resolvedPrimary,
            agent,
            system: ["You are a helpful assistant."],
            messages: [{ role: "user", content: "hello" }],
            tools: {},
            provider_route_decision: routeDecision({
              enabled: true,
              selectedProvider: "unknown-provider-primary",
              selectedModel: "missing-model-primary",
              fallback: [{ provider: "unknown-provider-fallback", model: "missing-model-fallback" }],
              outcomeMode: "dry_run",
              recommendation: {
                read_only: true,
                recommended: { provider: fallbackProviderID, model: fallbackModelID },
                scores: [],
                reason: "test",
                confidence: 0.9,
                warnings: [],
              },
            }),
          }),
        ).rejects.toThrow(/provider_route_dry_run=/)
      },
    })
  })

  test("provider routing with circuit breaker skips open primary and uses healthy fallback", async () => {
    const server = state.server
    if (!server) throw new Error("Server not initialized")
    const fallbackProviderID = "vivgrid"
    const fallbackModelID = "gemini-3.1-pro-preview"
    const fallbackFixture = await loadFixture(fallbackProviderID, fallbackModelID)
    const fallbackRequest = waitRequest(
      "/chat/completions",
      new Response(createChatStream("fallback success"), {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      }),
    )
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(
          path.join(dir, "codemate.json"),
          JSON.stringify({
            $schema: "https://codemate.ai/config.json",
            enabled_providers: ["alibaba", fallbackProviderID],
            provider: {
              alibaba: {
                options: { apiKey: "primary-key", baseURL: `${server.url.origin}/v1` },
              },
              [fallbackProviderID]: {
                options: { apiKey: "fallback-key", baseURL: `${server.url.origin}/v1` },
              },
            },
          }),
        )
      },
    })
    const store = resetDefaultProviderHealthStore({
      config: { enabled: true, failureThreshold: 1, minAttempts: 1, openMs: 60_000, halfOpenMaxAttempts: 1 },
    })
    store.recordAttempt({
      provider: "unknown-provider-primary",
      model: "missing-model-primary",
      status: "failure",
      error_category: "provider_unavailable",
      retryable: true,
      fallback_index: 0,
      latency_ms: 1,
      created_at: new Date().toISOString(),
    })
    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const resolvedFallback = await getModel(ProviderID.make(fallbackProviderID), ModelID.make(fallbackFixture.model.id))
        const resolvedPrimary = await getModel(ProviderID.make("alibaba"), ModelID.make("qwen-plus"))
        const sessionID = SessionID.make("session-test-route-circuit-primary-open")
        const agent = {
          name: "test",
          mode: "primary",
          options: {},
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        } satisfies Agent.Info
        const user = {
          id: MessageID.make("msg_user-route-circuit-primary-open"),
          sessionID,
          role: "user",
          time: { created: Date.now() },
          agent: agent.name,
          model: { providerID: ProviderID.make("alibaba"), modelID: resolvedPrimary.id },
        } satisfies MessageV2.User
        await expect(
          drain({
            user,
            sessionID,
            model: resolvedPrimary,
            agent,
            system: ["You are a helpful assistant."],
            messages: [{ role: "user", content: "hello" }],
            tools: {},
            provider_route_decision: routeDecision({
              enabled: true,
              selectedProvider: "unknown-provider-primary",
              selectedModel: "missing-model-primary",
              fallback: [{ provider: fallbackProviderID, model: resolvedFallback.id }],
              circuitEnabled: true,
            }),
          }),
        ).resolves.toBeUndefined()
        const capture = await fallbackRequest
        expect(capture.headers.get("Authorization")).toBe("Bearer fallback-key")
      },
    })
  })

  test("provider routing with circuit breaker skips open fallback targets", async () => {
    const server = state.server
    if (!server) throw new Error("Server not initialized")
    const skippedFallbackProviderID = "vivgrid"
    const skippedFallbackModelID = "gemini-3.1-pro-preview"
    const finalFallbackProviderID = "alibaba"
    const finalFallbackModelID = "qwen-plus"
    const skippedFallbackFixture = await loadFixture(skippedFallbackProviderID, skippedFallbackModelID)
    const finalRequest = waitRequest(
      "/chat/completions",
      new Response(createChatStream("final fallback success"), {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      }),
    )
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(
          path.join(dir, "codemate.json"),
          JSON.stringify({
            $schema: "https://codemate.ai/config.json",
            enabled_providers: [skippedFallbackProviderID, finalFallbackProviderID],
            provider: {
              [skippedFallbackProviderID]: {
                options: { apiKey: "skip-key", baseURL: `${server.url.origin}/v1` },
              },
              [finalFallbackProviderID]: {
                options: { apiKey: "final-key", baseURL: `${server.url.origin}/v1` },
              },
            },
          }),
        )
      },
    })
    const store = resetDefaultProviderHealthStore({
      config: { enabled: true, failureThreshold: 1, minAttempts: 1, openMs: 60_000, halfOpenMaxAttempts: 1 },
    })
    store.recordAttempt({
      provider: skippedFallbackProviderID,
      model: skippedFallbackFixture.model.id,
      status: "failure",
      error_category: "timeout",
      retryable: true,
      fallback_index: 0,
      latency_ms: 1,
      created_at: new Date().toISOString(),
    })
    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const resolvedPrimary = await getModel(ProviderID.make(finalFallbackProviderID), ModelID.make(finalFallbackModelID))
        const resolvedSkippedFallback = await getModel(
          ProviderID.make(skippedFallbackProviderID),
          ModelID.make(skippedFallbackFixture.model.id),
        )
        const sessionID = SessionID.make("session-test-route-circuit-skip-fallback")
        const agent = {
          name: "test",
          mode: "primary",
          options: {},
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        } satisfies Agent.Info
        const user = {
          id: MessageID.make("msg_user-route-circuit-skip-fallback"),
          sessionID,
          role: "user",
          time: { created: Date.now() },
          agent: agent.name,
          model: { providerID: ProviderID.make(finalFallbackProviderID), modelID: resolvedPrimary.id },
        } satisfies MessageV2.User
        await expect(
          drain({
            user,
            sessionID,
            model: resolvedPrimary,
            agent,
            system: ["You are a helpful assistant."],
            messages: [{ role: "user", content: "hello" }],
            tools: {},
            provider_route_decision: routeDecision({
              enabled: true,
              selectedProvider: "unknown-provider-primary",
              selectedModel: "missing-model-primary",
              fallback: [
                { provider: skippedFallbackProviderID, model: resolvedSkippedFallback.id },
                { provider: finalFallbackProviderID, model: resolvedPrimary.id },
              ],
              circuitEnabled: true,
            }),
          }),
        ).resolves.toBeUndefined()
        const capture = await finalRequest
        expect(capture.headers.get("Authorization")).toBe("Bearer final-key")
      },
    })
  })

  test("provider routing with circuit breaker returns readable failure when all targets are open", async () => {
    const primaryProviderID = "alibaba"
    const primaryModelID = "qwen-plus"
    const fallbackProviderID = "vivgrid"
    const fallbackModelID = "gemini-3.1-pro-preview"
    const store = resetDefaultProviderHealthStore({
      config: { enabled: true, failureThreshold: 1, minAttempts: 1, openMs: 60_000, halfOpenMaxAttempts: 1 },
    })
    store.recordAttempt({
      provider: primaryProviderID,
      model: primaryModelID,
      status: "failure",
      error_category: "timeout",
      retryable: true,
      fallback_index: 0,
      latency_ms: 1,
      created_at: new Date().toISOString(),
    })
    store.recordAttempt({
      provider: fallbackProviderID,
      model: fallbackModelID,
      status: "failure",
      error_category: "timeout",
      retryable: true,
      fallback_index: 1,
      latency_ms: 1,
      created_at: new Date().toISOString(),
    })
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(
          path.join(dir, "codemate.json"),
          JSON.stringify({
            $schema: "https://codemate.ai/config.json",
            enabled_providers: [primaryProviderID, fallbackProviderID],
            provider: {
              [primaryProviderID]: {
                options: { apiKey: "primary-key", baseURL: "https://example.invalid/v1" },
              },
              [fallbackProviderID]: {
                options: { apiKey: "fallback-key", baseURL: "https://example.invalid/v1" },
              },
            },
          }),
        )
      },
    })
    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const resolvedPrimary = await getModel(ProviderID.make(primaryProviderID), ModelID.make(primaryModelID))
        const sessionID = SessionID.make("session-test-route-circuit-all-open")
        const agent = {
          name: "test",
          mode: "primary",
          options: {},
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        } satisfies Agent.Info
        const user = {
          id: MessageID.make("msg_user-route-circuit-all-open"),
          sessionID,
          role: "user",
          time: { created: Date.now() },
          agent: agent.name,
          model: { providerID: ProviderID.make(primaryProviderID), modelID: resolvedPrimary.id },
        } satisfies MessageV2.User
        await expect(
          drain({
            user,
            sessionID,
            model: resolvedPrimary,
            agent,
            system: ["You are a helpful assistant."],
            messages: [{ role: "user", content: "hello" }],
            tools: {},
            provider_route_decision: routeDecision({
              enabled: true,
              selectedProvider: primaryProviderID,
              selectedModel: primaryModelID,
              fallback: [{ provider: fallbackProviderID, model: fallbackModelID }],
              circuitEnabled: true,
            }),
          }),
        ).rejects.toThrow(/provider_route_attempts=.*skipped:provider_unavailable/)
      },
    })
  })

  test("provider routing enabled records aggregate telemetry attempts", async () => {
    const server = state.server
    if (!server) throw new Error("Server not initialized")
    const primaryProviderID = "alibaba"
    const primaryModelID = "qwen-plus"
    const fallbackProviderID = "vivgrid"
    const fallbackModelID = "gemini-3.1-pro-preview"
    const fallbackFixture = await loadFixture(fallbackProviderID, fallbackModelID)
    const fallbackRequest = waitRequest(
      "/chat/completions",
      new Response(createChatStream("fallback success"), {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      }),
    )
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(
          path.join(dir, "codemate.json"),
          JSON.stringify({
            $schema: "https://codemate.ai/config.json",
            enabled_providers: [primaryProviderID, fallbackProviderID],
            provider: {
              [primaryProviderID]: {
                options: { apiKey: "primary-key", baseURL: `${server.url.origin}/v1` },
              },
              [fallbackProviderID]: {
                options: { apiKey: "fallback-key", baseURL: `${server.url.origin}/v1` },
              },
            },
          }),
        )
      },
    })
    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const telemetry = getDefaultProviderTelemetryStore()
        expect(telemetry).toBeInstanceOf(InMemoryProviderTelemetryStore)
        const resolvedPrimary = await getModel(ProviderID.make(primaryProviderID), ModelID.make(primaryModelID))
        const resolvedFallback = await getModel(ProviderID.make(fallbackProviderID), ModelID.make(fallbackFixture.model.id))
        const sessionID = SessionID.make("session-test-route-telemetry-enabled")
        const agent = {
          name: "test",
          mode: "primary",
          options: {},
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        } satisfies Agent.Info
        const user = {
          id: MessageID.make("msg_user-route-telemetry-enabled"),
          sessionID,
          role: "user",
          time: { created: Date.now() },
          agent: agent.name,
          model: { providerID: ProviderID.make(primaryProviderID), modelID: resolvedPrimary.id },
        } satisfies MessageV2.User
        await expect(
          drain({
            user,
            sessionID,
            model: resolvedPrimary,
            agent,
            system: ["You are a helpful assistant."],
            messages: [{ role: "user", content: "hello" }],
            tools: {},
            provider_route_decision: routeDecision({
              enabled: true,
              selectedProvider: "unknown-provider-primary",
              selectedModel: "missing-model-primary",
              fallback: [{ provider: fallbackProviderID, model: resolvedFallback.id }],
            }),
          }),
        ).resolves.toBeUndefined()
        await fallbackRequest
        const stats = telemetry.queryStats({ group_by: ["agent"] })
        expect(stats.total_attempts).toBeGreaterThanOrEqual(2)
        const bucket = stats.buckets.find((item) => item.agent === "test")
        expect(bucket).toBeDefined()
        expect((bucket?.failures ?? 0) + (bucket?.successes ?? 0) + (bucket?.skipped ?? 0)).toBeGreaterThanOrEqual(2)
      },
    })
  })

  test("provider routing telemetry jsonl store persists attempts when configured", async () => {
    const server = state.server
    if (!server) throw new Error("Server not initialized")
    const primaryProviderID = "alibaba"
    const primaryModelID = "qwen-plus"
    const fallbackProviderID = "vivgrid"
    const fallbackModelID = "gemini-3.1-pro-preview"
    const fallbackFixture = await loadFixture(fallbackProviderID, fallbackModelID)
    const fallbackRequest = waitRequest(
      "/chat/completions",
      new Response(createChatStream("fallback success"), {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      }),
    )
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(
          path.join(dir, "codemate.json"),
          JSON.stringify({
            $schema: "https://codemate.ai/config.json",
            enabled_providers: [primaryProviderID, fallbackProviderID],
            provider: {
              [primaryProviderID]: {
                options: { apiKey: "primary-key", baseURL: `${server.url.origin}/v1` },
              },
              [fallbackProviderID]: {
                options: { apiKey: "fallback-key", baseURL: `${server.url.origin}/v1` },
              },
            },
            experimental: {
              provider_routing: {
                enabled: true,
                telemetry: {
                  store: "jsonl",
                },
              },
            },
          }),
        )
      },
    })
    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const resolvedPrimary = await getModel(ProviderID.make(primaryProviderID), ModelID.make(primaryModelID))
        const resolvedFallback = await getModel(ProviderID.make(fallbackProviderID), ModelID.make(fallbackFixture.model.id))
        const sessionID = SessionID.make("session-test-route-telemetry-jsonl")
        const agent = {
          name: "test",
          mode: "primary",
          options: {},
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        } satisfies Agent.Info
        const user = {
          id: MessageID.make("msg_user-route-telemetry-jsonl"),
          sessionID,
          role: "user",
          time: { created: Date.now() },
          agent: agent.name,
          model: { providerID: ProviderID.make(primaryProviderID), modelID: resolvedPrimary.id },
        } satisfies MessageV2.User
        await expect(
          drain({
            user,
            sessionID,
            model: resolvedPrimary,
            agent,
            system: ["You are a helpful assistant."],
            messages: [{ role: "user", content: "hello" }],
            tools: {},
            provider_route_decision: routeDecision({
              enabled: true,
              selectedProvider: "unknown-provider-primary",
              selectedModel: "missing-model-primary",
              fallback: [{ provider: fallbackProviderID, model: resolvedFallback.id }],
            }),
          }),
        ).resolves.toBeUndefined()
        await fallbackRequest

        const filePath = pathProjectProviderTelemetry(tmp.path)
        const file = Bun.file(filePath)
        expect(await file.exists()).toBe(true)

        const persisted = new JsonlProviderTelemetryStore({ filePath })
        expect(persisted.queryStats().total_attempts).toBeGreaterThanOrEqual(2)
        expect(getDefaultProviderTelemetryStore().queryStats().total_attempts).toBe(0)
      },
    })
  })

  test("dry-run report can use persisted telemetry after jsonl store re-instantiation", async () => {
    await using tmp = await tmpdir()
    const filePath = pathProjectProviderTelemetry(tmp.path)
    const writer = new JsonlProviderTelemetryStore({ filePath })
    writer.reset()
    writer.recordAttempt({
      provider: "openai",
      model: "gpt-5",
      agent: "coder",
      status: "success",
      latency_ms: 120,
      fallback_index: 0,
      created_at: "2026-01-01T00:00:00.000Z",
    })
    writer.recordAttempt({
      provider: "openai",
      model: "gpt-5",
      agent: "coder",
      status: "failure",
      error_category: "timeout",
      retryable: true,
      latency_ms: 220,
      fallback_index: 0,
      created_at: "2026-01-01T00:00:01.000Z",
    })
    writer.recordAttempt({
      provider: "anthropic",
      model: "claude-sonnet",
      agent: "coder",
      status: "success",
      latency_ms: 90,
      fallback_index: 1,
      created_at: "2026-01-01T00:00:02.000Z",
    })
    writer.recordAttempt({
      provider: "anthropic",
      model: "claude-sonnet",
      agent: "coder",
      status: "success",
      latency_ms: 95,
      fallback_index: 1,
      created_at: "2026-01-01T00:00:03.000Z",
    })

    const recommendation: ProviderRouteRecommendation = {
      read_only: true,
      recommended: { provider: "anthropic", model: "claude-sonnet" },
      scores: [
        {
          candidate: { provider: "anthropic", model: "claude-sonnet", source: "fallback" },
          score: 0.9,
          sample_size: 6,
          success_rate: 1,
          fallback_used_rate: 1,
          retryable_failure_rate: 0,
          p95_latency_ms: 95,
          confidence: 0.9,
          reasons: ["test"],
        },
      ],
      reason: "test recommendation",
      confidence: 0.9,
      warnings: [],
    }
    const decision = routeDecision({
      enabled: true,
      selectedProvider: "openai",
      selectedModel: "gpt-5",
      fallback: [{ provider: "anthropic", model: "claude-sonnet" }],
      outcomeMode: "dry_run",
      recommendation,
    })

    const reader = new JsonlProviderTelemetryStore({ filePath })
    const report = buildProviderRouteDryRunReport({
      decision,
      recommendation,
      telemetryStore: reader,
      minConfidence: 0.65,
      minSamples: 1,
    })
    expect(report.telemetry?.selected_success_rate).toBeCloseTo(0.5)
    expect(report.telemetry?.recommended_success_rate).toBeCloseTo(1)
  })

  test("routing disabled default does not record aggregate telemetry", async () => {
    const server = state.server
    if (!server) throw new Error("Server not initialized")
    const providerID = "alibaba"
    const modelID = "qwen-plus"
    const request = waitRequest(
      "/chat/completions",
      new Response(createChatStream("primary success"), {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      }),
    )
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(
          path.join(dir, "codemate.json"),
          JSON.stringify({
            $schema: "https://codemate.ai/config.json",
            enabled_providers: [providerID],
            provider: {
              [providerID]: {
                options: { apiKey: "primary-key", baseURL: `${server.url.origin}/v1` },
              },
            },
          }),
        )
      },
    })
    await WithInstance.provide({
      directory: tmp.path,
      fn: async () => {
        const telemetry = getDefaultProviderTelemetryStore()
        const resolved = await getModel(ProviderID.make(providerID), ModelID.make(modelID))
        const sessionID = SessionID.make("session-test-route-telemetry-disabled")
        const agent = {
          name: "test",
          mode: "primary",
          options: {},
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        } satisfies Agent.Info
        const user = {
          id: MessageID.make("msg_user-route-telemetry-disabled"),
          sessionID,
          role: "user",
          time: { created: Date.now() },
          agent: agent.name,
          model: { providerID: ProviderID.make(providerID), modelID: resolved.id },
        } satisfies MessageV2.User
        await expect(
          drain({
            user,
            sessionID,
            model: resolved,
            agent,
            system: ["You are a helpful assistant."],
            messages: [{ role: "user", content: "hello" }],
            tools: {},
          }),
        ).resolves.toBeUndefined()
        await request
        expect(telemetry.queryStats().total_attempts).toBe(0)
      },
    })
  })
})
