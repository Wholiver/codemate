import { Schema } from "effect"
import * as path from "path"
import { Effect, Option } from "effect"
import { createHash } from "node:crypto"
import * as Tool from "./tool"
import { LSP } from "@/lsp/lsp"
import { createTwoFilesPatch } from "diff"
import DESCRIPTION from "./write.txt"
import { Bus } from "../bus"
import { File } from "../file"
import { FileWatcher } from "../file/watcher"
import { Format } from "../format"
import { AppFileSystem } from "@codemate-ai/core/filesystem"
import { InstanceState } from "@/effect/instance-state"
import { trimDiff } from "./edit"
import { assertExternalDirectoryEffect } from "./external-directory"
import * as Bom from "@/util/bom"

const MAX_PROJECT_DIAGNOSTICS_FILES = 5

function deriveReadbackFragment(input: string) {
  const normalized = input.replaceAll("\r\n", "\n")
  const lines = normalized
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .toSorted((a, b) => b.length - a.length)
  const candidate = lines[0] ?? normalized.trim()
  if (!candidate) return ""
  return candidate.slice(0, Math.min(160, candidate.length))
}

function sha256Text(input: string) {
  return createHash("sha256").update(input).digest("hex")
}

export const Parameters = Schema.Struct({
  content: Schema.String.annotate({ description: "The content to write to the file" }),
  filePath: Schema.String.annotate({
    description: "The absolute path to the file to write (must be absolute, not relative)",
  }),
})

export const WriteTool = Tool.define(
  "write",
  Effect.gen(function* () {
    const lsp = yield* LSP.Service
    const fs = yield* AppFileSystem.Service
    const bus = yield* Bus.Service
    const format = yield* Format.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: { content: string; filePath: string }, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const filepath = path.isAbsolute(params.filePath)
            ? params.filePath
            : path.join(instance.directory, params.filePath)
          yield* assertExternalDirectoryEffect(ctx, filepath)

          const exists = yield* fs.existsSafe(filepath)
          const source = exists ? yield* Bom.readFile(fs, filepath) : { bom: false, text: "" }
          const next = Bom.split(params.content)
          const desiredBom = source.bom || next.bom
          const contentOld = source.text
          const contentNew = next.text

          const diff = trimDiff(createTwoFilesPatch(filepath, filepath, contentOld, contentNew))
          yield* ctx.ask({
            permission: "edit",
            patterns: [path.relative(instance.worktree, filepath)],
            always: ["*"],
            metadata: {
              filepath,
              diff,
            },
          })

          yield* fs.writeWithDirs(filepath, Bom.join(contentNew, desiredBom))
          if (yield* format.file(filepath)) {
            yield* Bom.syncFile(fs, filepath, desiredBom)
          }
          const readback = yield* Bom.readFile(fs, filepath)
          const expectedFragment = deriveReadbackFragment(contentNew)
          const readbackFragment = deriveReadbackFragment(readback.text)
          const readbackVerified =
            expectedFragment.length > 0 ? readback.text.includes(expectedFragment) : readback.text.length === 0
          if (!readbackVerified) {
            return yield* Effect.fail(
              new Error(
                `[file_write_verification_failed] ${JSON.stringify({
                  category: "file_write_verification_failed",
                  tool_name: "write",
                  file_path: filepath,
                  expected_fragment: expectedFragment,
                  readback_fragment: readbackFragment,
                  reason: "write succeeded but readback content does not include expected fragment",
                  repair_instruction: "retry write and verify file content with readback",
                })}`,
              ),
            )
          }
          const statInfo = yield* fs.stat(filepath).pipe(Effect.catch(() => Effect.succeed(undefined)))
          const mtimeMs =
            statInfo && statInfo.type !== "Directory"
              ? statInfo.mtime.pipe(
                  Option.map((time) => time.getTime()),
                  Option.getOrElse(() => 0),
                )
              : 0
          const readbackWithBom = Bom.join(readback.text, readback.bom)
          const verification = {
            file_path: filepath,
            mtime_ms: mtimeMs,
            sha256: sha256Text(readbackWithBom),
            readback_fragment: readbackFragment,
            expected_fragment: expectedFragment,
          }
          yield* bus.publish(File.Event.Edited, { file: filepath })
          yield* bus.publish(FileWatcher.Event.Updated, {
            file: filepath,
            event: exists ? "change" : "add",
          })

          let output = "Wrote file successfully."
          yield* lsp.touchFile(filepath, "document")
          const diagnostics = yield* lsp.diagnostics()
          const normalizedFilepath = AppFileSystem.normalizePath(filepath)
          let projectDiagnosticsCount = 0
          for (const [file, issues] of Object.entries(diagnostics)) {
            const current = file === normalizedFilepath
            if (!current && projectDiagnosticsCount >= MAX_PROJECT_DIAGNOSTICS_FILES) continue
            const block = LSP.Diagnostic.report(current ? filepath : file, issues)
            if (!block) continue
            if (current) {
              output += `\n\nLSP errors detected in this file, please fix:\n${block}`
              continue
            }
            projectDiagnosticsCount++
            output += `\n\nLSP errors detected in other files:\n${block}`
          }

          return {
            title: path.relative(instance.worktree, filepath),
            metadata: {
              diagnostics,
              filepath,
              exists: exists,
              verification,
            },
            output,
          }
        }).pipe(Effect.orDie),
    }
  }),
)
