import { Database } from "bun:sqlite"

const db = new Database(":memory:")
db.run("PRAGMA foreign_keys = ON")

// Try running the statements in order from the migration file
const stmts = [
  `CREATE TABLE \`memory\` (
	\`id\` text PRIMARY KEY,
	\`project_id\` text NOT NULL,
	\`domain\` text NOT NULL,
	\`path\` text NOT NULL,
	\`content\` text NOT NULL,
	\`summary\` text,
	\`version\` integer DEFAULT 1 NOT NULL,
	\`migrated_to\` text,
	\`deprecated\` integer DEFAULT false NOT NULL,
	\`vitality\` real DEFAULT 1 NOT NULL,
	\`access_count\` integer DEFAULT 0 NOT NULL,
	\`last_accessed\` integer,
	\`tags\` text DEFAULT '[]' NOT NULL,
	\`source_session_id\` text,
	\`time_created\` integer NOT NULL,
	\`time_updated\` integer NOT NULL
);`,
  `CREATE TABLE \`memory_chunk\` (
	\`id\` text PRIMARY KEY,
	\`memory_id\` text NOT NULL,
	\`content\` text NOT NULL,
	\`chunk_index\` integer NOT NULL,
	\`time_created\` integer NOT NULL,
	\`time_updated\` integer NOT NULL,
	CONSTRAINT \`fk_memory_chunk_memory_id_memory_id_fk\` FOREIGN KEY (\`memory_id\`) REFERENCES \`memory\`(\`id\`) ON DELETE CASCADE
);`,
  `CREATE TABLE \`memory_chunk_vec\` (
	\`memory_id\` text PRIMARY KEY,
	\`embedding\` text NOT NULL,
	\`time_created\` integer NOT NULL,
	\`time_updated\` integer NOT NULL,
	CONSTRAINT \`fk_memory_chunk_vec_memory_id_memory_id_fk\` FOREIGN KEY (\`memory_id\`) REFERENCES \`memory\`(\`id\`) ON DELETE CASCADE
);`,
  `CREATE TABLE \`memory_alias\` (
	\`alias\` text PRIMARY KEY,
	\`target_domain\` text NOT NULL,
	\`target_path\` text NOT NULL,
	\`time_created\` integer NOT NULL,
	\`time_updated\` integer NOT NULL
);`,
]

for (let i = 0; i < stmts.length; i++) {
  try {
    db.run(stmts[i])
    console.log(`Statement ${i + 1}: OK`)
  } catch (e: any) {
    console.error(`Statement ${i + 1} FAILED: ${e.message}`)
  }
}

db.close()
