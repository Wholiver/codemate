import { describe, expect, test } from "bun:test"
import { extractThinkingContent } from "../../../src/cli/cmd/tui/util/thinking"

describe("tui thinking text detection", () => {
  test("detects plain markdown thinking marker", () => {
    expect(extractThinkingContent("_Thinking:_ planning next steps")).toBe("planning next steps")
  })

  test("detects thinking marker line with multiline content", () => {
    expect(extractThinkingContent("_Thinking:_\n\nStep 1\nStep 2")).toBe("Step 1\nStep 2")
  })

  test("does not treat normal assistant text as thinking", () => {
    expect(extractThinkingContent("Final answer: use rg --files")).toBeUndefined()
    expect(extractThinkingContent("Thinking about options, here is the answer.")).toBeUndefined()
  })
})
