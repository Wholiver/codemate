import { UI } from "../ui"
import { cmd } from "./cmd"

export const WebCommand = cmd({
  command: "web",
  builder: (yargs) => yargs,
  describe: "web interface is disabled",
  handler: async () => {
    UI.error("The web interface is disabled in this build.")
    process.exitCode = 1
  },
})
