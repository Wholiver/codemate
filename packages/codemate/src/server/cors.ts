const codemateOrigin = /^https:\/\/([a-z0-9-]+\.)*codemate\.ai$/

export function isAllowedCorsOrigin(input: string | undefined, opts?: { cors?: string[] }) {
  if (!input) return true
  if (input.startsWith("http://localhost:")) return true
  if (input.startsWith("http://127.0.0.1:")) return true
  if (input.startsWith("oc://renderer")) return true
  if (input === "tauri://localhost" || input === "http://tauri.localhost" || input === "https://tauri.localhost")
    return true
  if (codemateOrigin.test(input)) return true
  return opts?.cors?.includes(input) ?? false
}
