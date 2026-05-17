#!/usr/bin/env bun

import { $ } from "bun"
import fs from "fs"
import path from "path"
import { fileURLToPath } from "url"
import { createSolidTransformPlugin } from "@opentui/solid/bun-plugin"
import { Script } from "@codemate-ai/script"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const dir = path.resolve(__dirname, "..")

process.chdir(dir)

await import("./generate.ts")

const migrationDirs = (
  await fs.promises.readdir(path.join(dir, "migration"), {
    withFileTypes: true,
  })
)
  .filter((entry) => entry.isDirectory() && /^\d{4}\d{2}\d{2}\d{2}\d{2}\d{2}/.test(entry.name))
  .map((entry) => entry.name)
  .sort()

const migrations = await Promise.all(
  migrationDirs.map(async (name) => {
    const file = path.join(dir, "migration", name, "migration.sql")
    const sql = await Bun.file(file).text()
    const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/.exec(name)
    const timestamp = match
      ? Date.UTC(
          Number(match[1]),
          Number(match[2]) - 1,
          Number(match[3]),
          Number(match[4]),
          Number(match[5]),
          Number(match[6]),
        )
      : 0
    return { sql, timestamp, name }
  }),
)
console.log(`Loaded ${migrations.length} migrations`)

const sourcemapsFlag = process.argv.includes("--sourcemaps")
const plugin = createSolidTransformPlugin()

await $`rm -rf dist`
await $`mkdir -p dist/cli/cli/cmd/tui`
await $`cp ../../LICENSE ./dist/LICENSE`

const localPath = path.resolve(dir, "node_modules/@opentui/core/parser.worker.js")
const rootPath = path.resolve(dir, "../../node_modules/@opentui/core/parser.worker.js")
const parserWorkerPath = fs.realpathSync(fs.existsSync(localPath) ? localPath : rootPath)

const commonBuildConfig = {
  conditions: ["browser"],
  tsconfig: "./tsconfig.json",
  plugins: [plugin],
  external: ["node-gyp"],
  target: "bun" as const,
  format: "esm" as const,
  minify: true,
  sourcemap: sourcemapsFlag ? ("linked" as const) : ("none" as const),
  splitting: false,
  define: {
    codemate_VERSION: `'${Script.version}'`,
    codemate_MIGRATIONS: JSON.stringify(migrations),
    codemate_CHANNEL: `'${Script.channel}'`,
    codemate_LIBC: "",
  },
}

async function writeOutputs(outputs: Bun.BuildArtifact[], destination: string) {
  for (const artifact of outputs) {
    const relative = artifact.path.replace(/^\.\//, "")
    const output = path.join(destination, relative)
    await fs.promises.mkdir(path.dirname(output), { recursive: true })
    await Bun.write(output, artifact)
  }
}

const mainBuild = await Bun.build({
  ...commonBuildConfig,
  entrypoints: ["./src/index.ts"],
})
if (!mainBuild.success) {
  for (const log of mainBuild.logs) console.error(log)
  process.exit(1)
}
await writeOutputs(mainBuild.outputs, path.join(dir, "dist/cli"))

const workerBuild = await Bun.build({
  ...commonBuildConfig,
  entrypoints: ["./src/cli/cmd/tui/worker.ts"],
})
if (!workerBuild.success) {
  for (const log of workerBuild.logs) console.error(log)
  process.exit(1)
}
await writeOutputs(workerBuild.outputs, path.join(dir, "dist/cli/cli/cmd/tui"))

await $`cp ${parserWorkerPath} ./dist/cli/parser.worker.js`

const entryPath = path.resolve(dir, "dist/cli/index.js")
const entryText = await Bun.file(entryPath).text()
if (!entryText.startsWith("#!")) {
  await Bun.write(entryPath, "#!/usr/bin/env bun\n" + entryText)
}
if (process.platform !== "win32") await $`chmod 755 ./dist/cli/index.js`

console.log("Built pure JS CLI at dist/cli/index.js")
console.log("Running smoke test: bun dist/cli/index.js --version")
const versionOutput = await $`bun ./dist/cli/index.js --version`.text()
console.log(`Smoke test passed: ${versionOutput.trim()}`)
