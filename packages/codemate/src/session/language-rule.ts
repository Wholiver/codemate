const LANGUAGE_RULE_BLOCK = /<language-rule>[\s\S]*?<\/language-rule>/i
const LANGUAGE_RULE_BLOCK_GLOBAL = /<language-rule>[\s\S]*?<\/language-rule>/gi
const LETTER = /\p{L}/u

const latinHints = [
  {
    code: "es",
    name: "Spanish",
    pattern: /\b(hola|gracias|por favor|necesito|puedes|ayuda|quiero)\b/i,
  },
  {
    code: "fr",
    name: "French",
    pattern: /\b(bonjour|merci|s'il|besoin|aider|pouvez|voulez)\b/i,
  },
  {
    code: "de",
    name: "German",
    pattern: /\b(hallo|danke|bitte|hilfe|kannst|moechte|brauch)\b/i,
  },
  {
    code: "pt",
    name: "Portuguese",
    pattern: /\b(ola|obrigad[oa]|por favor|preciso|pode|ajuda|quero)\b/i,
  },
]

export type DetectedLanguage = {
  code: string
  name: string
}

const DEFAULT_LANGUAGE: DetectedLanguage = {
  code: "en",
  name: "English",
}

const hasRange = (point: number, ranges: readonly [number, number][]) =>
  ranges.some(([start, end]) => point >= start && point <= end)

const scripts = {
  han: [
    [0x3400, 0x4dbf],
    [0x4e00, 0x9fff],
    [0xf900, 0xfaff],
  ],
  hiragana: [[0x3040, 0x309f]],
  katakana: [[0x30a0, 0x30ff]],
  hangul: [
    [0x1100, 0x11ff],
    [0xac00, 0xd7af],
  ],
  cyrillic: [
    [0x0400, 0x04ff],
    [0x0500, 0x052f],
  ],
  arabic: [
    [0x0600, 0x06ff],
    [0x0750, 0x077f],
    [0x08a0, 0x08ff],
  ],
  devanagari: [[0x0900, 0x097f]],
  thai: [[0x0e00, 0x0e7f]],
  greek: [[0x0370, 0x03ff]],
  hebrew: [[0x0590, 0x05ff]],
  latin: [
    [0x0041, 0x005a],
    [0x0061, 0x007a],
    [0x00c0, 0x00ff],
    [0x0100, 0x017f],
    [0x0180, 0x024f],
  ],
} as const satisfies Record<string, readonly [number, number][]>

const ratioOver = (count: number, total: number, threshold: number) => total > 0 && count / total > threshold

const detectLatinLanguage = (text: string) => {
  const normalized = text.toLowerCase()
  const match = latinHints.find((item) => item.pattern.test(normalized))
  if (match) return { code: match.code, name: match.name } satisfies DetectedLanguage
  return DEFAULT_LANGUAGE
}

export const detectLanguage = (text: string): DetectedLanguage => {
  const counts = {
    total: 0,
    han: 0,
    hiragana: 0,
    katakana: 0,
    hangul: 0,
    cyrillic: 0,
    arabic: 0,
    devanagari: 0,
    thai: 0,
    greek: 0,
    hebrew: 0,
    latin: 0,
  }

  for (const char of text) {
    if (!LETTER.test(char)) continue
    const point = char.codePointAt(0)
    if (!point) continue
    counts.total += 1
    if (hasRange(point, scripts.hiragana)) counts.hiragana += 1
    if (hasRange(point, scripts.katakana)) counts.katakana += 1
    if (hasRange(point, scripts.han)) counts.han += 1
    if (hasRange(point, scripts.hangul)) counts.hangul += 1
    if (hasRange(point, scripts.cyrillic)) counts.cyrillic += 1
    if (hasRange(point, scripts.arabic)) counts.arabic += 1
    if (hasRange(point, scripts.devanagari)) counts.devanagari += 1
    if (hasRange(point, scripts.thai)) counts.thai += 1
    if (hasRange(point, scripts.greek)) counts.greek += 1
    if (hasRange(point, scripts.hebrew)) counts.hebrew += 1
    if (hasRange(point, scripts.latin)) counts.latin += 1
  }

  if (counts.total === 0) return DEFAULT_LANGUAGE

  const japaneseCount = counts.hiragana + counts.katakana
  if (ratioOver(japaneseCount, counts.total, 0.2)) {
    return { code: "ja", name: "Japanese" }
  }
  if (ratioOver(counts.han, counts.total, 0.3)) {
    return { code: "zh", name: "Chinese" }
  }
  if (ratioOver(counts.hangul, counts.total, 0.3)) {
    return { code: "ko", name: "Korean" }
  }
  if (ratioOver(counts.cyrillic, counts.total, 0.3)) {
    return { code: "ru", name: "Russian" }
  }
  if (ratioOver(counts.arabic, counts.total, 0.3)) {
    return { code: "ar", name: "Arabic" }
  }
  if (ratioOver(counts.devanagari, counts.total, 0.3)) {
    return { code: "hi", name: "Hindi" }
  }
  if (ratioOver(counts.thai, counts.total, 0.3)) {
    return { code: "th", name: "Thai" }
  }
  if (ratioOver(counts.greek, counts.total, 0.3)) {
    return { code: "el", name: "Greek" }
  }
  if (ratioOver(counts.hebrew, counts.total, 0.3)) {
    return { code: "he", name: "Hebrew" }
  }
  if (ratioOver(counts.latin, counts.total, 0.3)) return detectLatinLanguage(text)
  return DEFAULT_LANGUAGE
}

export const createLanguageRule = (languageName: string) =>
  [
    "<language-rule>",
    `LANGUAGE RULE: The user is communicating in ${languageName}.`,
    `You MUST respond in ${languageName} at all times.`,
    "This applies to all explanations, summaries, and messages to the user.",
    "Do not apply this rule to code, variable names, file paths, shell commands, or other machine-readable output.",
    "</language-rule>",
  ].join("\n")

export const detectLanguageRuleFromText = (text: string) => {
  const trimmed = text.trim()
  if (!trimmed) return
  return createLanguageRule(detectLanguage(trimmed).name)
}

export const extractLanguageRule = (system?: string) => {
  if (!system) return
  const match = system.match(LANGUAGE_RULE_BLOCK)
  if (!match?.[0]) return
  return match[0].trim()
}

export const stripLanguageRule = (system?: string) => {
  if (!system) return
  const stripped = system.replace(LANGUAGE_RULE_BLOCK_GLOBAL, "").trim()
  if (!stripped) return
  return stripped
}

export const mergeSystemWithLanguageRule = (input: { languageRule?: string; system?: string }) => {
  const chunks = [input.languageRule, input.system].filter((item): item is string => !!item && item.trim().length > 0)
  if (chunks.length === 0) return
  return chunks.join("\n\n")
}
