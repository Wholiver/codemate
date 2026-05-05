import path from "path"
import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import DESCRIPTION from "./research-report.txt"
import { AppFileSystem } from "@codemate-ai/core/filesystem"
import { Instance } from "@/project/instance"
import { generateYaml } from "./research/yaml-utils"
import {
  locateResearchFile,
  markdownAnchor,
  readFields,
  readOutline,
  relativePath,
  resolvePath,
} from "./research/common"
import { CATEGORY_MAPPING, NESTED_CATEGORY_KEYS, parseFieldsYaml, validateJsonContent } from "./research/validate"

export const Parameters = Schema.Struct({
  results_dir: Schema.optional(Schema.String).annotate({
    description: "Optional explicit results directory",
  }),
  toc_fields: Schema.optional(Schema.Array(Schema.String)).annotate({
    description: "Optional list of fields to show in the table of contents for each item",
  }),
})

function deepFind(value: unknown, field: string): unknown {
  if (!value || typeof value !== "object") return undefined
  if (Array.isArray(value)) {
    for (const item of value) {
      const hit = deepFind(item, field)
      if (hit !== undefined) return hit
    }
    return undefined
  }

  if (field in value) {
    return (value as Record<string, unknown>)[field]
  }

  for (const nested of Object.values(value)) {
    const hit = deepFind(nested, field)
    if (hit !== undefined) return hit
  }

  return undefined
}

function lookupField(data: Record<string, unknown>, field: string) {
  if (field in data) return data[field]

  for (const aliases of Object.values(CATEGORY_MAPPING)) {
    for (const alias of aliases) {
      const nested = data[alias]
      if (!nested || typeof nested !== "object" || Array.isArray(nested)) continue
      if (field in nested) return (nested as Record<string, unknown>)[field]
    }
  }

  return deepFind(data, field)
}

function isUncertain(field: string, value: unknown, uncertain: string[]) {
  if (uncertain.includes(field)) return true
  if (typeof value === "string" && value.includes("[uncertain]")) return true
  if (value === null || value === undefined) return true
  if (typeof value === "string" && value.trim().length === 0) return true
  return false
}

function formatInline(value: unknown): string {
  if (Array.isArray(value)) {
    if (value.every((item) => item && typeof item === "object" && !Array.isArray(item))) {
      return value
        .map((item) =>
          Object.entries(item as Record<string, unknown>)
            .map(([key, nested]) => `${key}: ${formatInline(nested)}`)
            .join(" | "),
        )
        .join(" ; ")
    }
    return value.map((item) => formatInline(item)).join(", ")
  }

  if (value && typeof value === "object") {
    return Object.entries(value)
      .map(([key, nested]) => `${key}: ${formatInline(nested)}`)
      .join("; ")
  }

  return String(value)
}

function formatBlock(value: unknown): string {
  if (Array.isArray(value)) {
    if (value.length === 0) return ""
    return value.map((item) => `- ${formatInline(item)}`).join("\n")
  }

  if (value && typeof value === "object") {
    return Object.entries(value)
      .map(([key, nested]) => `- ${key}: ${formatInline(nested)}`)
      .join("\n")
  }

  const text = String(value)
  if (text.length > 100) return `> ${text}`
  return text
}

export const ResearchReportTool = Tool.define(
  "research-report",
  Effect.gen(function* () {
    const fs = yield* AppFileSystem.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const outlinePath = yield* locateResearchFile(fs, ctx, "outline.yaml")
          const fieldsPath = path.join(path.dirname(outlinePath), "fields.yaml")
          const outline = yield* readOutline(fs, outlinePath)
          const fields = yield* readFields(fs, fieldsPath)
          const loaded = parseFieldsYaml(generateYaml(fields))
          const resultsDir = resolvePath(params.results_dir ?? path.join(path.dirname(outlinePath), outline.execution?.output_dir ?? "./results"))
          const reportPath = path.join(path.dirname(outlinePath), "report.md")

          yield* ctx.ask({
            permission: "read",
            patterns: [relativePath(resultsDir), relativePath(fieldsPath), relativePath(outlinePath)],
            always: ["*"],
            metadata: {
              resultsDir,
              fieldsPath,
              outlinePath,
            },
          })

          const jsonFiles = (yield* fs.glob("*.json", {
            cwd: resultsDir,
            absolute: true,
            include: "file",
            dot: true,
          })).sort()

          if (jsonFiles.length === 0) {
            throw new Error(`No JSON results found in ${resultsDir}`)
          }

          const entries = yield* Effect.forEach(jsonFiles, (jsonPath) =>
            Effect.gen(function* () {
              const raw = JSON.parse(yield* fs.readFileString(jsonPath)) as Record<string, unknown>
              const validation = validateJsonContent(raw, loaded, path.basename(jsonPath))
              return {
                file: jsonPath,
                data: raw,
                validation,
                uncertain: Array.isArray(raw.uncertain)
                  ? raw.uncertain.filter((value): value is string => typeof value === "string")
                  : [],
              }
            }),
          )

          const tocFields = params.toc_fields ?? []
          const report = [
            `# ${outline.topic}`,
            "",
            `Generated from ${entries.length} JSON result file${entries.length === 1 ? "" : "s"}.`,
            "",
            "## Summary",
            "",
            ...entries.map((entry) => {
              const bits = tocFields.flatMap((field) => {
                const value = lookupField(entry.data, field)
                if (isUncertain(field, value, entry.uncertain)) return []
                if (value === undefined) return []
                return [`${field}: ${formatInline(value)}`]
              })
              const name =
                (lookupField(entry.data, "name") as string | undefined) ??
                path.basename(entry.file, ".json").replaceAll("_", " ")
              return `${entries.indexOf(entry) + 1}. [${name}](#${markdownAnchor(name)})${bits.length > 0 ? ` - ${bits.join(" | ")}` : ""}`
            }),
            "",
            "## Validation",
            "",
            ...entries.map(
              (entry) =>
                `- ${entry.validation.file}: ${entry.validation.coverage_rate.toFixed(1)}% coverage (${entry.validation.covered}/${entry.validation.total_defined})`,
            ),
          ]

          for (const entry of entries) {
            const name =
              (lookupField(entry.data, "name") as string | undefined) ??
              path.basename(entry.file, ".json").replaceAll("_", " ")
            report.push("", `## ${name}`, "")

            for (const category of fields.field_categories ?? []) {
              const lines = category.fields.flatMap((field) => {
                const value = lookupField(entry.data, field.name)
                if (isUncertain(field.name, value, entry.uncertain)) return []
                if (value === undefined) return []
                return [`- **${field.name}**: ${formatBlock(value)}`]
              })
              if (lines.length === 0) continue
              report.push(`### ${category.category}`, "", ...lines, "")
            }

            const extraFields = entry.validation.extra_fields.filter((field) => !NESTED_CATEGORY_KEYS.has(field))
            const other = extraFields.flatMap((field) => {
              const value = lookupField(entry.data, field)
              if (isUncertain(field, value, entry.uncertain)) return []
              if (value === undefined) return []
              return [`- **${field}**: ${formatBlock(value)}`]
            })
            if (other.length > 0) {
              report.push("### Other Info", "", ...other, "")
            }
          }

          yield* ctx.ask({
            permission: "edit",
            patterns: [relativePath(reportPath)],
            always: ["*"],
            metadata: {
              reportPath,
            },
          })

          yield* fs.writeFileString(reportPath, report.join("\n").trim() + "\n")

          return {
            title: path.relative(Instance.worktree, reportPath),
            metadata: {
              reportPath,
              resultsDir,
              count: entries.length,
            },
            output: JSON.stringify(
              {
                report_path: reportPath,
                results_dir: resultsDir,
                files: entries.length,
                invalid_files: entries.filter((entry) => !entry.validation.valid).map((entry) => entry.validation.file),
              },
              null,
              2,
            ),
          }
        }).pipe(Effect.orDie),
    } satisfies Tool.DefWithoutID<typeof Parameters>
  }),
)
