const stage = process.env.SST_STAGE || "dev"

export default {
  url: stage === "production" ? "https://codemate.ai" : `https://${stage}.codemate.ai`,
  console: stage === "production" ? "https://codemate.ai/auth" : `https://${stage}.codemate.ai/auth`,
  email: "contact@anoma.ly",
  socialCard: "https://social-cards.sst.dev",
  github: "https://github.com/anomalyco/codemate",
  discord: "https://codemate.ai/discord",
  headerLinks: [
    { name: "app.header.home", url: "/" },
    { name: "app.header.docs", url: "/docs/" },
  ],
}
