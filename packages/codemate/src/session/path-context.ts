import os from "os"
import path from "path"

export type PathContext = {
  required_paths: string[]
  target_paths: string[]
  sandbox_paths: string[]
  fallback_paths: string[]
  actual_output_paths: string[]
  allowed_search_roots: string[]
  forbidden_search_roots: string[]
}

const PATH_TOKEN_PATTERN = /(?:~\/|\/|\.\.\/|\.\/)[^\s"'`<>()]+/g
const NON_PATH_TOKENS = new Set(["/task_result"])

const HOME_DIR = (() => {
  const raw = (process.env.HOME?.trim() || os.homedir()).trim()
  if (!raw) return undefined
  return normalizeAbsolute(raw)
})()

function uniq(values: string[]) {
  return [...new Set(values)]
}

export function homeDirectory() {
  return HOME_DIR
}

export function normalizeSlashes(input: string) {
  return input.replaceAll("\\", "/").replace(/\/+/g, "/")
}

export function normalizeAbsolute(input: string) {
  const normalized = normalizeSlashes(input).replace(/\/$/, "")
  if (!normalized) return "/"
  return normalized
}

function cleanPathToken(input: string) {
  return input.trim().replace(/^["'`]+|["'`]+$/g, "").replace(/[),.;:!?]+$/g, "")
}

function isAbsoluteLike(input: string) {
  return input.startsWith("/") || input.startsWith("~/") || input === "~"
}

export function toAbsolutePath(input: string, options?: { cwd?: string; homeDir?: string }) {
  const cleaned = cleanPathToken(input)
  if (!cleaned) return ""
  const homeDir = options?.homeDir ?? HOME_DIR
  if (cleaned === "~") return homeDir ?? cleaned
  if (cleaned.startsWith("~/")) {
    if (!homeDir) return cleaned
    return normalizeAbsolute(path.join(homeDir, cleaned.slice(2)))
  }
  if (path.isAbsolute(cleaned)) return normalizeAbsolute(cleaned)
  const cwd = options?.cwd ? normalizeAbsolute(options.cwd) : process.cwd()
  return normalizeAbsolute(path.resolve(cwd, cleaned))
}

export function toHomeLabel(input: string, homeDir?: string) {
  const home = homeDir ?? HOME_DIR
  const normalized = normalizeAbsolute(input)
  if (!home) return normalized
  if (normalized === home) return "~"
  if (normalized.startsWith(`${home}/`)) return `~${normalized.slice(home.length)}`
  return normalized
}

export function extractPathTokens(text: string) {
  const matches = [...text.matchAll(PATH_TOKEN_PATTERN)]
  const values = matches
    .flatMap((match) => {
      const token = match[0]
      const index = match.index ?? -1
      if (index < 0) return []
      const before = index > 0 ? text[index - 1] : ""
      // Ignore XML/HTML closing tags (e.g. </task>) and embedded path-like substrings (e.g. src/tool/task.ts).
      if (before === "<" || /[A-Za-z0-9_.-]/.test(before)) return []
      const cleaned = cleanPathToken(token)
      if (!cleaned) return []
      const lowered = normalizeSlashes(cleaned).replace(/\/$/, "").toLowerCase()
      if (NON_PATH_TOKENS.has(lowered)) return []
      return [cleaned]
    })
    .filter(Boolean)
  return uniq(values)
}

export function extractRequiredPaths(text: string) {
  return uniq(extractPathTokens(text).map((item) => normalizeSlashes(item).replace(/\/$/, "")))
}

export function resolveFallbackPaths(requiredPaths: string[], options?: { homeDir?: string; cwd?: string }) {
  const homeDir = options?.homeDir ?? HOME_DIR
  const cwd = options?.cwd
  const fallback: string[] = []
  for (const required of requiredPaths) {
    if (required === "/app" || required.startsWith("/app/")) {
      if (!homeDir) continue
      const suffix = required === "/app" ? "" : required.slice("/app".length)
      fallback.push(normalizeAbsolute(path.join(homeDir, "app", suffix)))
      continue
    }
    if (required.startsWith("~/")) {
      const absolute = toAbsolutePath(required, { homeDir, cwd })
      if (absolute) fallback.push(absolute)
      continue
    }
    if (!required.startsWith("/")) {
      const absolute = toAbsolutePath(required, { homeDir, cwd })
      if (absolute) fallback.push(absolute)
    }
  }
  return uniq(fallback)
}

export function resolveAbsoluteCandidates(paths: string[], options?: { homeDir?: string; cwd?: string }) {
  return uniq(
    paths
      .map((item) => toAbsolutePath(item, options))
      .filter((item) => item.length > 0 && item.startsWith("/")),
  )
}

export function resolveActualOutputPathsFromText(
  text: string,
  options?: { allowedPaths?: string[]; cwd?: string; homeDir?: string },
) {
  const tokens = extractPathTokens(text)
  const absolute = resolveAbsoluteCandidates(tokens, { cwd: options?.cwd, homeDir: options?.homeDir })
  const allowed = new Set((options?.allowedPaths ?? []).map((item) => normalizeAbsolute(item)))
  if (allowed.size === 0) return absolute
  return absolute.filter((item) => allowed.has(normalizeAbsolute(item)))
}

function parentDirectoryForSearch(pathname: string) {
  const normalized = normalizeAbsolute(pathname)
  if (normalized === "/") return normalized
  return normalizeAbsolute(path.dirname(normalized))
}

export function createPathContext(input: {
  requiredPaths: string[]
  targetPaths?: string[]
  sandboxPaths?: string[]
  fallbackPaths?: string[]
  actualOutputPaths?: string[]
  projectRoot?: string
  forbiddenRoots?: string[]
}) {
  const required_paths = uniq(input.requiredPaths.map((item) => normalizeSlashes(item).replace(/\/$/, "")).filter(Boolean))
  const target_paths = uniq(
    (input.targetPaths ?? input.requiredPaths).map((item) => normalizeSlashes(item).replace(/\/$/, "")).filter(Boolean),
  )
  const sandbox_paths = uniq((input.sandboxPaths ?? []).map((item) => normalizeAbsolute(item)).filter(Boolean))
  const fallback_paths = uniq((input.fallbackPaths ?? []).map((item) => normalizeAbsolute(item)).filter(Boolean))
  const actual_output_paths = uniq((input.actualOutputPaths ?? []).map((item) => normalizeAbsolute(item)).filter(Boolean))

  const allowedSearchRoots = new Set<string>()
  const projectRoot = input.projectRoot ? normalizeAbsolute(input.projectRoot) : undefined
  if (projectRoot) allowedSearchRoots.add(projectRoot)
  for (const candidate of [...sandbox_paths, ...fallback_paths, ...actual_output_paths]) {
    allowedSearchRoots.add(parentDirectoryForSearch(candidate))
  }

  const forbiddenRoots = new Set<string>(["/"])
  for (const item of input.forbiddenRoots ?? []) {
    const normalized = item.trim() ? normalizeAbsolute(item) : ""
    if (normalized) forbiddenRoots.add(normalized)
  }

  return {
    required_paths,
    target_paths,
    sandbox_paths,
    fallback_paths,
    actual_output_paths,
    allowed_search_roots: [...allowedSearchRoots],
    forbidden_search_roots: [...forbiddenRoots],
  } satisfies PathContext
}

export function renderPathContextBlock(pathContext: PathContext) {
  return `<path_context>\n${JSON.stringify(pathContext, null, 2)}\n</path_context>`
}

export function parsePathContextBlock(text: string): PathContext | undefined {
  const match = text.match(/<path_context>\s*([\s\S]*?)\s*<\/path_context>/i)
  if (!match?.[1]) return undefined
  try {
    const parsed = JSON.parse(match[1]) as Partial<PathContext>
    const normalizeAbsoluteList = (input: unknown) =>
      Array.isArray(input)
        ? uniq(
            input
              .filter((item): item is string => typeof item === "string")
              .map((item) => normalizeAbsolute(item))
              .filter(Boolean),
          )
        : []
    const normalizeRawList = (input: unknown) =>
      Array.isArray(input)
        ? uniq(
            input
              .filter((item): item is string => typeof item === "string")
              .map((item) => normalizeSlashes(item).replace(/\/$/, ""))
              .filter(Boolean),
          )
        : []
    const required_paths = normalizeRawList(parsed.required_paths)
    const target_paths = (() => {
      const parsedTargets = normalizeRawList(parsed.target_paths)
      return parsedTargets.length > 0 ? parsedTargets : required_paths
    })()
    return {
      required_paths,
      target_paths,
      sandbox_paths: normalizeAbsoluteList(parsed.sandbox_paths),
      fallback_paths: normalizeAbsoluteList(parsed.fallback_paths),
      actual_output_paths: normalizeAbsoluteList(parsed.actual_output_paths),
      allowed_search_roots: normalizeAbsoluteList(parsed.allowed_search_roots),
      forbidden_search_roots: normalizeAbsoluteList(parsed.forbidden_search_roots),
    } satisfies PathContext
  } catch {
    return undefined
  }
}

export function isPathInsideRoot(target: string, root: string) {
  const normalizedTarget = normalizeAbsolute(target)
  const normalizedRoot = normalizeAbsolute(root)
  if (normalizedRoot === "/") return true
  return normalizedTarget === normalizedRoot || normalizedTarget.startsWith(`${normalizedRoot}/`)
}

export function hasForbiddenPath(paths: string[], forbiddenRoots: string[]) {
  const normalizedForbidden = forbiddenRoots.map((item) => normalizeAbsolute(item))
  return uniq(
    paths.filter((candidate) => normalizedForbidden.some((root) => root !== "/" && isPathInsideRoot(candidate, root))),
  )
}

export function derivePathContextFromPrompt(input: {
  text: string
  cwd?: string
  projectRoot?: string
  forbiddenRoots?: string[]
}) {
  const requiredPaths = extractRequiredPaths(input.text)
  const fallbackPaths = resolveFallbackPaths(requiredPaths, { cwd: input.cwd })
  return createPathContext({
    requiredPaths,
    fallbackPaths,
    actualOutputPaths: [],
    projectRoot: input.projectRoot,
    forbiddenRoots: input.forbiddenRoots,
  })
}

export function ensureAbsolutePathList(paths: string[], options?: { cwd?: string; homeDir?: string }) {
  return resolveAbsoluteCandidates(paths, options)
}

export function absoluteSearchRootsFromOutputs(paths: string[]) {
  return uniq(paths.map((item) => parentDirectoryForSearch(item)).filter(Boolean))
}

export function pathContextFromTrajectory(input: {
  requiredPaths: string[]
  trajectoryArtifactPaths: string[]
  projectRoot?: string
  forbiddenRoots?: string[]
}) {
  const fallbackPaths = resolveFallbackPaths(input.requiredPaths)
  const allowedAbsolute = ensureAbsolutePathList([...input.requiredPaths, ...fallbackPaths])
  const allowedSet = new Set(allowedAbsolute.map((item) => normalizeAbsolute(item)))
  const actualOutputPaths = ensureAbsolutePathList(input.trajectoryArtifactPaths).filter(
    (item) => allowedSet.size === 0 || allowedSet.has(normalizeAbsolute(item)),
  )
  return createPathContext({
    requiredPaths: input.requiredPaths,
    fallbackPaths,
    actualOutputPaths,
    projectRoot: input.projectRoot,
    forbiddenRoots: input.forbiddenRoots,
  })
}
