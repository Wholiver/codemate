import { sqliteTable, text, index } from "drizzle-orm/sqlite-core"
import { Timestamps } from "../storage/schema.sql"
import type { ChangelogID } from "./schema"

export const ChangelogTable = sqliteTable(
  "changelog",
  {
    id: text().$type<ChangelogID>().primaryKey(),
    project_id: text().notNull(),
    session_id: text().notNull(),
    message_id: text().notNull(),
    files: text({ mode: "json" }).$type<string[]>().notNull().default([]),
    summary: text().notNull(),
    ...Timestamps,
  },
  (table) => [index("changelog_project_idx").on(table.project_id), index("changelog_session_idx").on(table.session_id)],
)

export * as ChangelogSQL from "./changelog.sql"
