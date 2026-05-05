import { Context, Effect, Layer } from "effect"
import { Changelog } from "./changelog"
import type { ChangelogEntry } from "./changelog"

const DEFAULT_LIMIT = 100
const MAX_SUMMARY_LENGTH = 240
const MAX_FILES = 8

export interface Interface {
  readonly loadContext: (input?: { limit?: number }) => Effect.Effect<string[]>
}

export class Service extends Context.Service<Service, Interface>()("@codemate/ChangelogContext") {}

function truncate(value: string, max: number) {
  if (value.length <= max) return value
  return value.slice(0, max - 3) + "..."
}

function escapeCell(value: string) {
  return value.replaceAll("|", "\\|").replaceAll("\n", " ")
}

function formatFiles(files: string[]) {
  if (files.length === 0) return "(none)"
  const visible = files.slice(0, MAX_FILES)
  const suffix = files.length > visible.length ? `, +${files.length - visible.length} more` : ""
  return visible.join(", ") + suffix
}

function formatEntry(entry: ChangelogEntry) {
  return [
    new Date(entry.timeCreated).toISOString(),
    escapeCell(formatFiles(entry.files)),
    escapeCell(truncate(entry.summary, MAX_SUMMARY_LENGTH)),
  ].join(" | ")
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const changelog = yield* Changelog.Service

    const loadContext: Interface["loadContext"] = Effect.fn("ChangelogContext.loadContext")(function* (input) {
      const entries = yield* changelog
        .list({ limit: input?.limit ?? DEFAULT_LIMIT })
        .pipe(Effect.catch(() => Effect.succeed([])))
      if (entries.length === 0) return []

      return [
        [
          "<project-changelog>",
          "Recent project changelog entries, newest first. Use these as background context for code changes.",
          "",
          "time | changed files | summary",
          ...entries.map(formatEntry),
          "</project-changelog>",
        ].join("\n"),
      ]
    })

    return Service.of({ loadContext })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Changelog.defaultLayer))

export * as ChangelogContext from "./context"
