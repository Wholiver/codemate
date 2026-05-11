import { Config } from "effect"
import { InstallationChannel } from "../installation/version"

function truthy(key: string) {
  const value = process.env[key]?.toLowerCase()
  return value === "true" || value === "1"
}

function falsy(key: string) {
  const value = process.env[key]?.toLowerCase()
  return value === "false" || value === "0"
}

// Channels where new experiments default to ON (unstable / internal users).
// Stable channels (`prod`, `latest`) stay opt-in.
const UNSTABLE_CHANNELS = new Set(["dev", "beta", "local"])
function unstableDefault(key: string) {
  return truthy(key) || (!falsy(key) && UNSTABLE_CHANNELS.has(InstallationChannel))
}

function number(key: string) {
  const value = process.env[key]
  if (!value) return undefined
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined
}

const codemate_EXPERIMENTAL = truthy("codemate_EXPERIMENTAL")
const codemate_DISABLE_CLAUDE_CODE = truthy("codemate_DISABLE_CLAUDE_CODE")
const codemate_DISABLE_CLAUDE_CODE_SKILLS =
  codemate_DISABLE_CLAUDE_CODE || truthy("codemate_DISABLE_CLAUDE_CODE_SKILLS")
const copy = process.env["codemate_EXPERIMENTAL_DISABLE_COPY_ON_SELECT"]

export const Flag = {
  OTEL_EXPORTER_OTLP_ENDPOINT: process.env["OTEL_EXPORTER_OTLP_ENDPOINT"],
  OTEL_EXPORTER_OTLP_HEADERS: process.env["OTEL_EXPORTER_OTLP_HEADERS"],

  codemate_AUTO_SHARE: truthy("codemate_AUTO_SHARE"),
  codemate_AUTO_HEAP_SNAPSHOT: truthy("codemate_AUTO_HEAP_SNAPSHOT"),
  codemate_GIT_BASH_PATH: process.env["codemate_GIT_BASH_PATH"],
  codemate_CONFIG: process.env["codemate_CONFIG"],
  codemate_CONFIG_CONTENT: process.env["codemate_CONFIG_CONTENT"],
  codemate_DISABLE_AUTOUPDATE: truthy("codemate_DISABLE_AUTOUPDATE"),
  codemate_ALWAYS_NOTIFY_UPDATE: truthy("codemate_ALWAYS_NOTIFY_UPDATE"),
  codemate_DISABLE_PRUNE: truthy("codemate_DISABLE_PRUNE"),
  codemate_DISABLE_TERMINAL_TITLE: truthy("codemate_DISABLE_TERMINAL_TITLE"),
  codemate_SHOW_TTFD: truthy("codemate_SHOW_TTFD"),
  codemate_PERMISSION: process.env["codemate_PERMISSION"],
  codemate_DISABLE_DEFAULT_PLUGINS: truthy("codemate_DISABLE_DEFAULT_PLUGINS"),
  codemate_DISABLE_LSP_DOWNLOAD: truthy("codemate_DISABLE_LSP_DOWNLOAD"),
  codemate_ENABLE_EXPERIMENTAL_MODELS: truthy("codemate_ENABLE_EXPERIMENTAL_MODELS"),
  codemate_DISABLE_AUTOCOMPACT: truthy("codemate_DISABLE_AUTOCOMPACT"),
  codemate_DISABLE_MODELS_FETCH: truthy("codemate_DISABLE_MODELS_FETCH"),
  codemate_DISABLE_MOUSE: truthy("codemate_DISABLE_MOUSE"),
  codemate_DISABLE_CLAUDE_CODE,
  codemate_DISABLE_CLAUDE_CODE_PROMPT: codemate_DISABLE_CLAUDE_CODE || truthy("codemate_DISABLE_CLAUDE_CODE_PROMPT"),
  codemate_DISABLE_CLAUDE_CODE_SKILLS,
  codemate_DISABLE_EXTERNAL_SKILLS: truthy("codemate_DISABLE_EXTERNAL_SKILLS"),
  // Default-on for dev/beta/local; opt-in for stable. Set
  // codemate_EXPERIMENTAL_CUSTOMIZE_SKILL=false to force off, =true to force on.
  codemate_EXPERIMENTAL_CUSTOMIZE_SKILL: unstableDefault("codemate_EXPERIMENTAL_CUSTOMIZE_SKILL"),
  codemate_FAKE_VCS: process.env["codemate_FAKE_VCS"],
  codemate_SERVER_PASSWORD: process.env["codemate_SERVER_PASSWORD"],
  codemate_SERVER_USERNAME: process.env["codemate_SERVER_USERNAME"],
  codemate_ENABLE_QUESTION_TOOL: truthy("codemate_ENABLE_QUESTION_TOOL"),

  // Experimental
  codemate_EXPERIMENTAL,
  codemate_EXPERIMENTAL_FILEWATCHER: Config.boolean("codemate_EXPERIMENTAL_FILEWATCHER").pipe(
    Config.withDefault(false),
  ),
  codemate_EXPERIMENTAL_DISABLE_FILEWATCHER: Config.boolean("codemate_EXPERIMENTAL_DISABLE_FILEWATCHER").pipe(
    Config.withDefault(false),
  ),
  codemate_EXPERIMENTAL_ICON_DISCOVERY: codemate_EXPERIMENTAL || truthy("codemate_EXPERIMENTAL_ICON_DISCOVERY"),
  codemate_EXPERIMENTAL_DISABLE_COPY_ON_SELECT:
    copy === undefined ? process.platform === "win32" : truthy("codemate_EXPERIMENTAL_DISABLE_COPY_ON_SELECT"),
  codemate_ENABLE_EXA: truthy("codemate_ENABLE_EXA") || codemate_EXPERIMENTAL || truthy("codemate_EXPERIMENTAL_EXA"),
  codemate_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS: number("codemate_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS"),
  codemate_EXPERIMENTAL_OUTPUT_TOKEN_MAX: number("codemate_EXPERIMENTAL_OUTPUT_TOKEN_MAX"),
  codemate_EXPERIMENTAL_OXFMT: codemate_EXPERIMENTAL || truthy("codemate_EXPERIMENTAL_OXFMT"),
  codemate_EXPERIMENTAL_LSP_TY: truthy("codemate_EXPERIMENTAL_LSP_TY"),
  codemate_EXPERIMENTAL_LSP_TOOL: codemate_EXPERIMENTAL || truthy("codemate_EXPERIMENTAL_LSP_TOOL"),
  codemate_EXPERIMENTAL_PLAN_MODE: codemate_EXPERIMENTAL || truthy("codemate_EXPERIMENTAL_PLAN_MODE"),
  codemate_EXPERIMENTAL_SCOUT: codemate_EXPERIMENTAL || truthy("codemate_EXPERIMENTAL_SCOUT"),
  codemate_EXPERIMENTAL_MARKDOWN: !falsy("codemate_EXPERIMENTAL_MARKDOWN"),
  codemate_ENABLE_PARALLEL: truthy("codemate_ENABLE_PARALLEL") || truthy("codemate_EXPERIMENTAL_PARALLEL"),
  codemate_MODELS_URL: process.env["codemate_MODELS_URL"],
  codemate_MODELS_PATH: process.env["codemate_MODELS_PATH"],
  codemate_DB: process.env["codemate_DB"],
  codemate_DISABLE_CHANNEL_DB: truthy("codemate_DISABLE_CHANNEL_DB"),
  codemate_SKIP_MIGRATIONS: truthy("codemate_SKIP_MIGRATIONS"),
  codemate_STRICT_CONFIG_DEPS: truthy("codemate_STRICT_CONFIG_DEPS"),

  codemate_WORKSPACE_ID: process.env["codemate_WORKSPACE_ID"],
  codemate_EXPERIMENTAL_WORKSPACES: codemate_EXPERIMENTAL || truthy("codemate_EXPERIMENTAL_WORKSPACES"),
  codemate_EXPERIMENTAL_EVENT_SYSTEM: codemate_EXPERIMENTAL || truthy("codemate_EXPERIMENTAL_EVENT_SYSTEM"),

  // Evaluated at access time (not module load) because tests, the CLI, and
  // external tooling set these env vars at runtime.
  get codemate_DISABLE_PROJECT_CONFIG() {
    return truthy("codemate_DISABLE_PROJECT_CONFIG")
  },
  get codemate_TUI_CONFIG() {
    return process.env["codemate_TUI_CONFIG"]
  },
  get codemate_CONFIG_DIR() {
    return process.env["codemate_CONFIG_DIR"]
  },
  get codemate_PURE() {
    return truthy("codemate_PURE")
  },
  get codemate_PLUGIN_META_FILE() {
    return process.env["codemate_PLUGIN_META_FILE"]
  },
  get codemate_CLIENT() {
    return process.env["codemate_CLIENT"] ?? "cli"
  },
}
