export * from "./client.js"
export * from "./server.js"

import { createCodemateClient } from "./client.js"
import { createCodemateServer } from "./server.js"
import type { ServerOptions } from "./server.js"

export async function createCodemate(options?: ServerOptions) {
  const server = await createCodemateServer({
    ...options,
  })

  const client = createCodemateClient({
    baseUrl: server.url,
  })

  return {
    client,
    server,
  }
}
