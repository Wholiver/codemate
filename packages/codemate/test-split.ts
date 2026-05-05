import { readFileSync } from "fs"
import path from "path"

const migrationDir = path.join(import.meta.dir, "./migration")

// Read the memory migration SQL
const sql = readFileSync(path.join(migrationDir, "20260501114846_add-memory", "migration.sql"), "utf-8")

const stmts = sql.split("--> statement-breakpoint")
console.log(`Total statements: ${stmts.length}`)
for (let i = 0; i < stmts.length; i++) {
  const trimmed = stmts[i].trim()
  console.log(`\nStatement ${i + 1} (${trimmed.length} chars):`)
  console.log(trimmed.substring(0, 100) + (trimmed.length > 100 ? "..." : ""))
}
