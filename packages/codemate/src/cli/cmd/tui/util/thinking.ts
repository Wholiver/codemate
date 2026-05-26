const THINKING_PREFIX = /^_Thinking:_\s*/i

function normalizeNewlines(input: string) {
  return input.replace(/\r\n/g, "\n").replace(/\r/g, "\n")
}

export function extractThinkingContent(input: string): string | undefined {
  const normalized = normalizeNewlines(input)
  const trimmed = normalized.trimStart()
  if (!THINKING_PREFIX.test(trimmed)) return

  const content = trimmed
    .replace(THINKING_PREFIX, "")
    .replace(/^\n+/, "")
    .replace(/\[REDACTED\]/g, "")
    .trim()

  return content
}
