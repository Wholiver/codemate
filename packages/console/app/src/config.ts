/**
 * Application-wide constants and configuration
 */
export const config = {
  // Base URL
  baseUrl: "https://codemate.ai",

  // GitHub
  github: {
    repoUrl: "https://github.com/anomalyco/codemate",
    starsFormatted: {
      compact: "150K",
      full: "150,000",
    },
  },

  // Social links
  social: {
    twitter: "https://x.com/codemate",
    discord: "https://discord.gg/codemate",
  },

  // Static stats (used on landing page)
  stats: {
    contributors: "—",
    commits: "11,000",
    monthlyUsers: "6.5M",
  },
} as const
