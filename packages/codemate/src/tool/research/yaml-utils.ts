import YAML from "yaml"

export function generateYaml(value: unknown) {
  return YAML.stringify(value)
}

