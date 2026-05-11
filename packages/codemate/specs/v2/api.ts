// @ts-nocheck

import { codemate } from "@codemate-ai/core"
import { ReadTool } from "@codemate-ai/core/tools"

const codemate = codemate.make({})

codemate.tool.add(ReadTool)

codemate.tool.add({
  name: "bash",
  schema: {
    type: "object",
    properties: {
      command: {
        type: "string",
        description: "The command to run.",
      },
    },
    required: ["command"],
  },
  execute(input, ctx) {},
})

codemate.auth.add({
  provider: "openai",
  type: "api",
  value: process.env.OPENAI_API_KEY,
})

codemate.agent.add({
  name: "build",
  permissions: [],
  model: {
    id: "gpt-5-5",
    provider: "openai",
    variant: "xhigh",
  },
})

const sessionID = await codemate.session.create({
  agent: "build",
})

codemate.subscribe((event) => {
  console.log(event)
})

await codemate.session.prompt({
  sessionID,
  text: "hey what is up",
})

await codemate.session.prompt({
  sessionID,
  text: "what is up with this",
  files: [
    {
      mime: "image/png",
      uri: "data:image/png;base64,xxxx",
    },
  ],
})

await codemate.session.wait()

console.log(await codemate.session.messages(sessionID))
