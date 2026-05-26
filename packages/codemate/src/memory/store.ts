import { Global } from "@codemate-ai/core/global"
import { appendFile, mkdir } from "fs/promises"
import path from "path"
import type { MemoryRecord } from "@/memory/types"

export type MemoryForgetInput = {
  id?: string
  query?: string
}

export interface MemoryStore {
  list(): Promise<MemoryRecord[]>
  write(record: MemoryRecord): Promise<void>
  forget(input: MemoryForgetInput): Promise<number>
}

export function projectMemoryRecordsPath(projectRoot: string) {
  return path.join(projectRoot, ".codemate", "memory", "records.jsonl")
}

export function globalMemoryRecordsPath(dataDir = Global.Path.data) {
  return path.join(dataDir, "memory", "records.jsonl")
}

function parseJsonl<T = unknown>(text: string) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as T]
      } catch {
        return []
      }
    })
}

async function readJsonlFile<T = unknown>(filePath: string) {
  const file = Bun.file(filePath)
  if (!(await file.exists())) return [] as T[]
  return parseJsonl<T>(await file.text())
}

async function writeJsonlFile(filePath: string, records: unknown[]) {
  const text = records.map((item) => JSON.stringify(item)).join("\n")
  await mkdir(path.dirname(filePath), { recursive: true })
  await Bun.write(filePath, text ? `${text}\n` : "")
}

function memoryText(record: MemoryRecord) {
  return `${record.content.summary} ${record.content.details ?? ""} ${record.tags.join(" ")}`.toLowerCase()
}

export class JsonlMemoryStore implements MemoryStore {
  private readonly projectRoot?: string
  private readonly dataDir: string

  constructor(input?: { projectRoot?: string; dataDir?: string }) {
    this.projectRoot = input?.projectRoot
    this.dataDir = input?.dataDir ?? Global.Path.data
  }

  async list() {
    const projectFile = this.projectRoot ? projectMemoryRecordsPath(this.projectRoot) : undefined
    const [globalRecords, projectRecords] = await Promise.all([
      readJsonlFile<MemoryRecord>(globalMemoryRecordsPath(this.dataDir)),
      projectFile ? readJsonlFile<MemoryRecord>(projectFile) : Promise.resolve([] as MemoryRecord[]),
    ])
    return [...globalRecords, ...projectRecords].toSorted(
      (left, right) => right.lifecycle.updated_at - left.lifecycle.updated_at,
    )
  }

  async write(record: MemoryRecord) {
    const target = this.resolvePath(record)
    await mkdir(path.dirname(target), { recursive: true })
    await appendFile(target, `${JSON.stringify(record)}\n`, "utf8")
  }

  async forget(input: MemoryForgetInput) {
    const id = input.id?.trim()
    const query = input.query?.trim().toLowerCase()
    if (!id && !query) return 0
    const projectFile = this.projectRoot ? projectMemoryRecordsPath(this.projectRoot) : undefined
    const targets = [globalMemoryRecordsPath(this.dataDir), ...(projectFile ? [projectFile] : [])]
    const removed = await Promise.all(targets.map((filePath) => this.forgetInFile(filePath, { id, query })))
    return removed.reduce((sum, count) => sum + count, 0)
  }

  private resolvePath(record: MemoryRecord) {
    if (record.scope === "project" || record.scope === "session") {
      const projectRoot = record.attribution.project_root ?? this.projectRoot
      if (!projectRoot) throw new Error("project_root is required for project/session memory records")
      return projectMemoryRecordsPath(projectRoot)
    }
    return globalMemoryRecordsPath(this.dataDir)
  }

  private async forgetInFile(filePath: string, input: { id?: string; query?: string }) {
    const file = Bun.file(filePath)
    if (!(await file.exists())) return 0
    const records = await readJsonlFile<MemoryRecord>(filePath)
    const next = records.filter((record) => {
      if (input.id && record.id === input.id) return false
      if (input.query && memoryText(record).includes(input.query)) return false
      return true
    })
    if (next.length === records.length) return 0
    await writeJsonlFile(filePath, next)
    return records.length - next.length
  }
}

export class CompositeMemoryStore implements MemoryStore {
  private readonly primary: MemoryStore
  private readonly legacy: Pick<MemoryStore, "list">

  constructor(input: { primary: MemoryStore; legacy: Pick<MemoryStore, "list"> }) {
    this.primary = input.primary
    this.legacy = input.legacy
  }

  async list() {
    const [current, legacy] = await Promise.all([this.primary.list(), this.legacy.list()])
    return [...current, ...legacy].toSorted((left, right) => right.lifecycle.updated_at - left.lifecycle.updated_at)
  }

  async write(record: MemoryRecord) {
    await this.primary.write(record)
  }

  async forget(input: MemoryForgetInput) {
    return this.primary.forget(input)
  }
}

