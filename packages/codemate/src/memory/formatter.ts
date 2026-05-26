import type { MemoryRecord } from "@/memory/types"

export function formatMemoryReminder(records: MemoryRecord[]) {
  if (records.length === 0) return ""
  return [
    "<system-reminder>",
    "Relevant memory:",
    ...records.map((record) => `- [${record.kind}][${record.scope}] ${record.content.summary}`),
    "</system-reminder>",
  ].join("\n")
}

