import YAML from "yaml"

export const CATEGORY_MAPPING: Record<string, string[]> = {}
export const NESTED_CATEGORY_KEYS = new Set<string>()

export function parseFieldsYaml(raw: string) {
  const parsed = YAML.parse(raw) as
    | {
        field_categories?: Array<{
          category?: string
          fields?: Array<{ name?: string }>
        }>
      }
    | null
  const categories = parsed?.field_categories ?? []
  const fields = categories.flatMap((category) =>
    (category.fields ?? []).flatMap((field) => {
      if (!field.name) return []
      return [field.name]
    }),
  )
  return {
    fields,
  }
}

export function validateJsonContent(
  data: Record<string, unknown>,
  loaded: { fields: string[] },
  file: string,
) {
  const flatKeys = Object.keys(data).filter((key) => key !== "uncertain")
  const covered = loaded.fields.filter((field) => field in data).length
  const total = loaded.fields.length
  const coverage_rate = total === 0 ? 100 : (covered / total) * 100
  const extra_fields = flatKeys.filter((key) => !loaded.fields.includes(key))

  return {
    file,
    covered,
    total_defined: total,
    coverage_rate,
    extra_fields,
    valid: true,
  }
}

