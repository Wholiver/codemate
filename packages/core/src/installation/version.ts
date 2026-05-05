declare global {
  const CODEMATE_VERSION: string
  const CODEMATE_CHANNEL: string
}

export const InstallationVersion = typeof CODEMATE_VERSION === "string" ? CODEMATE_VERSION : "local"
export const InstallationChannel = typeof CODEMATE_CHANNEL === "string" ? CODEMATE_CHANNEL : "local"
export const InstallationLocal = InstallationChannel === "local"
