const unsupportedProviderIDs = ["codemate", "codemate-go", "opencode", "opencode-go", "opencode-zen", "zen"]

export const UNSUPPORTED_PROVIDER_IDS = new Set(unsupportedProviderIDs)

export function isUnsupportedProviderID(providerID: string) {
  return UNSUPPORTED_PROVIDER_IDS.has(providerID)
}

export const ProviderUnsupported = {
  UNSUPPORTED_PROVIDER_IDS,
  isUnsupportedProviderID,
}
