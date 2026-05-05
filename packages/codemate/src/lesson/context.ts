import path from "path"
import { mkdirSync } from "fs"
import { Context, Effect, Layer } from "effect"
import { InstanceState } from "@/effect/instance-state"

const DEFAULT_LESSONS = "# Lessons\n"

export interface Interface {
  readonly hasLessons: () => Effect.Effect<boolean>
  readonly loadContext: () => Effect.Effect<string[]>
}

export class Service extends Context.Service<Service, Interface>()("@codemate/LessonContext") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const filepath = Effect.fn("LessonContext.filepath")(function* () {
      const ctx = yield* InstanceState.context
      const baseDir = ctx.worktree === "/" ? ctx.directory : ctx.worktree
      return path.join(baseDir, ".codemate", "lessons.md")
    })

    const ensureLessons: Effect.Effect<string> = Effect.fn("LessonContext.ensureLessons")(function* () {
      const target = yield* filepath()
      const file = Bun.file(target)
      if (yield* Effect.promise(() => file.exists())) {
        const content = yield* Effect.promise(() => file.text())
        if (content.trim()) return target
      }

      yield* Effect.sync(() => mkdirSync(path.dirname(target), { recursive: true }))
      yield* Effect.promise(() => Bun.write(target, DEFAULT_LESSONS))
      return target
    })()

    const hasLessons: Interface["hasLessons"] = Effect.fn("LessonContext.hasLessons")(function* () {
      yield* ensureLessons
      return true
    })

    const loadContext: Interface["loadContext"] = Effect.fn("LessonContext.loadContext")(function* () {
      const target = yield* ensureLessons
      const file = Bun.file(target)
      const content = (yield* Effect.promise(() => file.text())).trim()

      return [
        [
          "<project-lessons>",
          "Project lessons learned loaded from .codemate/lessons.md. Review them at the start of every task and keep them updated with lesson_write after file changes before you finish.",
          "",
          content,
          "</project-lessons>",
        ].join("\n"),
      ]
    })

    return Service.of({ hasLessons, loadContext })
  }),
)

export const defaultLayer = layer

export * as LessonContext from "./context"
