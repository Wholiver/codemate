export * from "./client.js"
export * from "./server.js"

import { createcodemateClient } from "./client.js"
import { createcodemateServer } from "./server.js"
import type { ServerOptions } from "./server.js"

export * as data from "./data.js"

export async function createcodemate(options?: ServerOptions) {
  const server = await createcodemateServer({
    ...options,
  })

  const client = createcodemateClient({
    baseUrl: server.url,
  })

  return {
    client,
    server,
  }
}
