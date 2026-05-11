import path from "path"
import YAML from "yaml"
import { Effect } from "effect"
import { AppFileSystem } from "@codemate-ai/core/filesystem"
import { Instance } from "@/project/instance"
import type * as Tool from "../tool"
import { slugify } from "./slug"

type ResearchItem = {
  name: string
  category?: string
  description?: string
}

export function resolvePath(input: string) {
  if (path.isAbsolute(input)) return input
  return path.join(Instance.worktree, input)
}

export function relativePath(input: string) {
  const rel = path.relative(Instance.worktree, input)
  if (!rel || rel.startsWith("..")) return input
  return rel
}

export function outputFilename(name: string) {
  const slug = slugify(name) || "item"
  return `${slug}.json`
}

export function markdownAnchor(input: string) {
  return slugify(input)
}

export function mergeItems(existing: ResearchItem[], incoming: ResearchItem[]) {
  const dedup = new Map(existing.map((item) => [item.name.trim().toLowerCase(), item]))
  incoming.forEach((item) => {
    dedup.set(item.name.trim().toLowerCase(), item)
  })
  return [...dedup.values()]
}

export const readOutline = Effect.fn("Research.readOutline")(function* (
  fs: AppFileSystem.Interface,
  outlinePath: string,
) {
  const raw = yield* fs.readFileString(outlinePath)
  const parsed = YAML.parse(raw) as Record<string, unknown> | null
  return {
    topic: "",
    items: [],
    execution: {
      batch_size: 3,
      items_per_agent: 1,
      output_dir: "./results",
    },
    ...(parsed ?? {}),
  } as {
    topic: string
    items: ResearchItem[]
    execution?: {
      batch_size?: number
      items_per_agent?: number
      output_dir?: string
    }
  }
})

export const readFields = Effect.fn("Research.readFields")(function* (
  fs: AppFileSystem.Interface,
  fieldsPath: string,
) {
  const raw = yield* fs.readFileString(fieldsPath)
  const parsed = YAML.parse(raw) as Record<string, unknown> | null
  return {
    field_categories: [],
    ...(parsed ?? {}),
  } as {
    field_categories?: Array<{
      category: string
      fields: Array<{
        name: string
        description: string
        detail_level?: string
        required?: boolean
      }>
    }>
  }
})

export const locateResearchFile = Effect.fn("Research.locateResearchFile")(function* (
  fs: AppFileSystem.Interface,
  ctx: Tool.Context,
  filename: "outline.yaml" | "fields.yaml",
  explicit?: string,
) {
  if (explicit) {
    const resolved = resolvePath(explicit)
    if (yield* fs.existsSafe(resolved)) return resolved
    throw new Error(`${filename} not found at ${resolved}`)
  }

  const direct = path.join(Instance.worktree, filename)
  if (yield* fs.existsSafe(direct)) return direct

  const nested = yield* fs.glob(`**/${filename}`, {
    cwd: Instance.worktree,
    include: "file",
    absolute: true,
  })
  if (nested.length === 1) return nested[0]!
  if (nested.length > 1) {
    throw new Error(`Multiple ${filename} files found. Please pass an explicit path.`)
  }

  throw new Error(`${filename} not found. Run research first or pass an explicit path.`)
})

