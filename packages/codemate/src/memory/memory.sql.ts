import { sqliteTable, text, integer, index, real } from "drizzle-orm/sqlite-core"
import { Timestamps } from "../storage/schema.sql"
import type { MemoryID } from "./schema"

export const MemoryTable = sqliteTable(
  "memory",
  {
    id: text().$type<MemoryID>().primaryKey(),
    project_id: text().notNull(),
    domain: text().notNull(),
    path: text().notNull(),
    content: text().notNull(),
    summary: text(),
    version: integer().notNull().default(1),
    migrated_to: text().$type<MemoryID>(),
    deprecated: integer({ mode: "boolean" }).notNull().default(false),
    vitality: real().notNull().default(1.0),
    access_count: integer().notNull().default(0),
    last_accessed: integer(),
    tags: text({ mode: "json" }).$type<string[]>().notNull().default([]),
    source_session_id: text(),
    ...Timestamps,
  },
  (table) => [
    index("memory_project_idx").on(table.project_id),
    index("memory_domain_idx").on(table.domain),
    index("memory_domain_path_idx").on(table.domain, table.path),
    index("memory_vitality_idx").on(table.vitality),
    index("memory_migrated_to_idx").on(table.migrated_to),
  ],
)

export const MemoryChunkTable = sqliteTable(
  "memory_chunk",
  {
    id: text().primaryKey(),
    memory_id: text()
      .$type<MemoryID>()
      .notNull()
      .references(() => MemoryTable.id, { onDelete: "cascade" }),
    content: text().notNull(),
    chunk_index: integer().notNull(),
    ...Timestamps,
  },
  (table) => [index("memory_chunk_memory_idx").on(table.memory_id)],
)

export const MemoryAliasTable = sqliteTable(
  "memory_alias",
  {
    alias: text().primaryKey(),
    project_id: text().notNull(),
    target_domain: text().notNull(),
    target_path: text().notNull(),
    ...Timestamps,
  },
  (table) => [
    index("memory_alias_project_idx").on(table.project_id),
    index("memory_alias_target_idx").on(table.target_domain, table.target_path),
  ],
)

export const MemoryChunkVecTable = sqliteTable(
  "memory_chunk_vec",
  {
    memory_id: text()
      .$type<MemoryID>()
      .primaryKey()
      .references(() => MemoryTable.id, { onDelete: "cascade" }),
    embedding: text().notNull(),
    ...Timestamps,
  },
  (table) => [index("memory_chunk_vec_memory_idx").on(table.memory_id)],
)

export * as MemorySQL from "./memory.sql"
