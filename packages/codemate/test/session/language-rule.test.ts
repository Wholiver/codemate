import { describe, expect, test } from "bun:test"
import * as LanguageRule from "../../src/session/language-rule"

describe("session.language-rule", () => {
  test("detects Chinese when Han characters dominate the prompt", () => {
    const rule = LanguageRule.detectLanguageRuleFromText("请帮我实现这个功能，并解释每一步。")
    expect(rule).toContain("LANGUAGE RULE: The user is communicating in Chinese.")
    expect(rule).toContain("You MUST respond in Chinese at all times.")
  })

  test("detects English for standard Latin prompts", () => {
    const rule = LanguageRule.detectLanguageRuleFromText("Please implement this feature and explain each step.")
    expect(rule).toContain("LANGUAGE RULE: The user is communicating in English.")
    expect(rule).toContain("You MUST respond in English at all times.")
  })

  test("extracts and strips embedded language rule blocks", () => {
    const source = [
      LanguageRule.createLanguageRule("Chinese"),
      "Custom system note.",
    ].join("\n\n")
    expect(LanguageRule.extractLanguageRule(source)).toContain("The user is communicating in Chinese.")
    expect(LanguageRule.stripLanguageRule(source)).toBe("Custom system note.")
  })
})
