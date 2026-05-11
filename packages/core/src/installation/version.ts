declare global {
  const codemate_VERSION: string
  const codemate_CHANNEL: string
}

export const InstallationVersion = typeof codemate_VERSION === "string" ? codemate_VERSION : "local"
export const InstallationChannel = typeof codemate_CHANNEL === "string" ? codemate_CHANNEL : "local"
export const InstallationLocal = InstallationChannel === "local"
