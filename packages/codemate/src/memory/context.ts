import { Context, Effect, Layer, Schedule, Duration, Cause } from "effect"
import { Memory } from "./memory"
import { MemoryLifecycle } from "./lifecycle"
import { MessageV2 } from "@/session/message-v2"
import type { MemoryInfo } from "./memory"
import * as Log from "@codemate-ai/core/util/log"

const log = Log.create({ service: "memory.context" })

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

export interface Interface {
  readonly loadContext: (input: {
    sessionID: string
    messages: MessageV2.WithParts[]
  }) => Effect.Effect<string[]>
  readonly extractMemories: (input: {
    sessionID: string
    messages: MessageV2.WithParts[]
  }) => Effect.Effect<void>
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class Service extends Context.Service<Service, Interface>()("@codemate/MemoryContext") {}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const STOP_WORDS = new Set([
  "a",
  "an",
  "the",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "have",
  "has",
  "had",
  "do",
  "does",
  "did",
  "will",
  "would",
  "could",
  "should",
  "may",
  "might",
  "shall",
  "can",
  "need",
  "must",
  "it",
  "its",
  "this",
  "that",
  "these",
  "those",
  "i",
  "me",
  "my",
  "we",
  "our",
  "you",
  "your",
  "he",
  "him",
  "his",
  "she",
  "her",
  "they",
  "them",
  "their",
  "what",
  "which",
  "who",
  "whom",
  "when",
  "where",
  "why",
  "how",
  "not",
  "no",
  "nor",
  "but",
  "or",
  "and",
  "if",
  "then",
  "else",
  "so",
  "for",
  "of",
  "in",
  "on",
  "at",
  "to",
  "from",
  "by",
  "with",
  "as",
  "into",
  "about",
  "like",
  "through",
  "after",
  "over",
  "between",
  "out",
  "against",
  "during",
  "without",
  "before",
  "under",
  "around",
  "among",
  "up",
  "down",
  "off",
  "above",
  "below",
  "each",
  "every",
  "both",
  "few",
  "more",
  "most",
  "other",
  "some",
  "such",
  "only",
  "same",
  "than",
  "too",
  "very",
  "just",
  "also",
  "now",
  "here",
  "there",
  "all",
  "any",
  "much",
  "well",
  "back",
  "even",
  "still",
  "new",
  "want",
  "use",
  "using",
  "used",
  "make",
  "made",
  "get",
  "got",
  "go",
  "went",
  "gone",
  "come",
  "came",
  "take",
  "took",
  "taken",
  "give",
  "gave",
  "given",
  "find",
  "found",
  "know",
  "knew",
  "known",
  "think",
  "thought",
  "say",
  "said",
  "tell",
  "told",
  "see",
  "saw",
  "seen",
  "look",
  "looked",
  "work",
  "worked",
  "try",
  "tried",
  "ask",
  "asked",
  "put",
  "set",
  "let",
  "keep",
  "kept",
  "help",
  "show",
  "shown",
  "turn",
  "start",
  "run",
  "sure",
  "right",
  "good",
  "first",
  "last",
  "long",
  "great",
  "little",
  "own",
  "old",
  "big",
  "high",
  "different",
  "small",
  "large",
  "next",
  "early",
  "young",
  "important",
  "bad",
  "able",
  "really",
  "need",
  "please",
  "thanks",
  "thank",
  "file",
  "files",
  "code",
  "function",
  "want",
  "create",
  "add",
  "update",
  "fix",
  "change",
  "remove",
  "delete",
  "read",
  "write",
  "implement",
  "check",
  "run",
  "test",
  "build",
  "install",
  "package",
  "use",
  "make",
  "should",
  "would",
  "could",
  "like",
])

const MAX_KEYWORDS = 8

function textParts(parts: MessageV2.Part[]) {
  return parts.filter((part): part is MessageV2.TextPart => part.type === "text" && !part.synthetic)
}

function extractKeywords(messages: MessageV2.WithParts[]): string[] {
  const recentUserText = messages
    .filter((m) => m.info.role === "user")
    .slice(-5)
    .flatMap((m) => textParts(m.parts).map((p) => p.text))
    .join(" ")
    .toLowerCase()

  if (!recentUserText.trim()) return []

  const words = recentUserText
    .replace(/[^a-z0-9\s_-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w))

  const freq = new Map<string, number>()
  for (const word of words) {
    freq.set(word, (freq.get(word) ?? 0) + 1)
  }

  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_KEYWORDS)
    .map(([word]) => word)
}

function formatMemory(memory: { domain: string; path: string; vitality: number; content: string }): string {
  return `<memory domain="${memory.domain}" path="${memory.path}" vitality="${memory.vitality.toFixed(2)}">\n${memory.content}\n</memory>`
}

function isSubstantiveConversation(messages: MessageV2.WithParts[]): boolean {
  const totalTextLength = messages
    .flatMap((m) => textParts(m.parts).map((p) => p.text))
    .join("")
    .trim().length

  return totalTextLength > 500
}

function inferDomain(messages: MessageV2.WithParts[]): string {
  const text = messages
    .flatMap((m) => textParts(m.parts).map((p) => p.text))
    .join(" ")
    .toLowerCase()

  if (text.includes("prefer") || text.includes("always use") || text.includes("don't like") || text.includes("style"))
    return "preference"
  if (text.includes("architecture") || text.includes("design pattern") || text.includes("system design"))
    return "architecture"
  if (text.includes("bug") || text.includes("error") || text.includes("fix") || text.includes("issue"))
    return "debugging"
  return "knowledge"
}

function extractSummary(messages: MessageV2.WithParts[]): string {
  const userTexts = messages
    .filter((m) => m.info.role === "user")
    .flatMap((m) => textParts(m.parts).map((p) => p.text))

  const assistantTexts = messages
    .filter((m) => m.info.role === "assistant")
    .flatMap((m) => textParts(m.parts).map((p) => p.text))

  const firstUser = userTexts[0]?.slice(0, 200) ?? ""
  const lastAssistant = assistantTexts[assistantTexts.length - 1]?.slice(0, 200) ?? ""

  return `Topic: ${firstUser}\nResolution: ${lastAssistant}`
}

// ---------------------------------------------------------------------------
// Layer
// ---------------------------------------------------------------------------

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const memory = yield* Memory.Service
    const lifecycle = yield* MemoryLifecycle.Service

    const loadContext: Interface["loadContext"] = Effect.fn("MemoryContext.loadContext")(function* (input) {
      const keywords = extractKeywords(input.messages)
      if (keywords.length === 0) return []

      const results = yield* Effect.forEach(
        keywords,
        (keyword) =>
          memory.search({ query: keyword, limit: 3 }).pipe(Effect.catch(() => Effect.succeed([] as MemoryInfo[]))),
        { concurrency: "unbounded" },
      )

      const seen = new Set<string>()
      const memories: MemoryInfo[] = []
      for (const batch of results) {
        for (const mem of batch) {
          if (seen.has(mem.id)) continue
          seen.add(mem.id)
          memories.push(mem)
        }
      }

      return memories
        .sort((a, b) => b.vitality - a.vitality)
        .slice(0, 10)
        .map(formatMemory)
    })

    const extractMemories: Interface["extractMemories"] = Effect.fn("MemoryContext.extractMemories")(
      function* (input) {
        if (!isSubstantiveConversation(input.messages)) return
        const lastUser = input.messages.findLast((message) => message.info.role === "user")
        if (
          lastUser &&
          input.messages.some(
            (message) =>
              message.info.role === "assistant" &&
              message.info.id > lastUser.info.id &&
              message.parts.some(
                (part) => part.type === "tool" && part.tool === "memory_create" && part.state.status === "completed",
              ),
          )
        )
          return

        const domain = inferDomain(input.messages)
        const keywords = extractKeywords(input.messages)
        if (keywords.length === 0) return

        const summary = extractSummary(input.messages)
        const path = `session/${input.sessionID}`

        yield* memory
          .create({
            domain,
            path,
            content: summary,
            summary: summary.slice(0, 200),
            tags: keywords,
            sourceSessionID: input.sessionID,
          })
          .pipe(
            Effect.catch((err: { message: string }) => {
              log.warn("failed to extract memory", { error: err.message })
              return Effect.void
            }),
          )

        log.info("extracted memory", { domain, path, tags: keywords })
      },
    )

    // Background lifecycle: decay + consolidation + cleanup every 6 hours
    yield* lifecycle.runAll().pipe(
      Effect.catchCause((cause) => {
        log.error("memory lifecycle failed", { cause: Cause.pretty(cause) })
        return Effect.void
      }),
      Effect.repeat(Schedule.spaced(Duration.hours(6))),
      Effect.delay(Duration.minutes(5)),
      Effect.forkScoped,
    )

    return Service.of({ loadContext, extractMemories })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(Memory.defaultLayer),
  Layer.provide(MemoryLifecycle.defaultLayer),
)

export * as MemoryContext from "./context"
