import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import * as SessionClosedLoop from "@/session/closed-loop"

const DESCRIPTION = `Persistent memory toolkit with user/project scopes.

Actions:
- add: save memory content for reuse
- search: semantic-ish keyword retrieval from saved memory
- list: view memories
- profile: aggregate counts and top tags
- forget: remove memory entries by id or query`

export const Parameters = Schema.Struct({
  action: Schema.Literals(["add", "search", "list", "profile", "forget", "help"]),
  content: Schema.optional(Schema.String).annotate({ description: "Memory content for add" }),
  query: Schema.optional(Schema.String).annotate({ description: "Query for search/forget" }),
  id: Schema.optional(Schema.String).annotate({ description: "Exact memory id for forget" }),
  scope: Schema.optional(Schema.Literals(["user", "project"]))
    .annotate({ description: "Memory scope (default user for add, both for search/list)" }),
  top_k: Schema.optional(Schema.Number).annotate({ description: "Max results for search" }),
  tags: Schema.optional(Schema.mutable(Schema.Array(Schema.String))).annotate({ description: "Tags for add" }),
})

export const SupermemoryTool = Tool.define<
  typeof Parameters,
  Record<string, unknown>,
  SessionClosedLoop.Service
>(
  "supermemory",
  Effect.gen(function* () {
    const loop = yield* SessionClosedLoop.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          yield* ctx.ask({
            permission: "supermemory",
            patterns: [params.action],
            always: ["*"],
            metadata: {
              action: params.action,
              scope: params.scope,
            },
          })

          if (params.action === "help") {
            return {
              title: "Supermemory help",
              output: DESCRIPTION,
              metadata: {},
            }
          }

          if (params.action === "add") {
            if (!params.content?.trim()) {
              return {
                title: "Memory add skipped",
                output: "content is required for action=add",
                metadata: {},
              }
            }
            const record = yield* loop.supermemoryAdd({
              content: params.content,
              scope: params.scope ?? "user",
              tags: params.tags ?? [],
              sessionID: ctx.sessionID,
              messageID: ctx.messageID,
              attribution: {
                session_id: String(ctx.sessionID),
                message_id: String(ctx.messageID),
                process_id: "tool",
                tool_name: "supermemory",
                agent: ctx.agent,
              },
            })
            return {
              title: "Memory added",
              output: JSON.stringify(record, null, 2),
              metadata: { record },
            }
          }

          if (params.action === "search") {
            if (!params.query?.trim()) {
              return {
                title: "Memory search skipped",
                output: "query is required for action=search",
                metadata: {},
              }
            }
            const records = yield* loop.supermemorySearch({
              query: params.query,
              scope: params.scope,
              topK: params.top_k,
              sessionID: ctx.sessionID,
              messageID: ctx.messageID,
              attribution: {
                session_id: String(ctx.sessionID),
                message_id: String(ctx.messageID),
                process_id: "tool",
                tool_name: "supermemory",
                agent: ctx.agent,
              },
            })
            return {
              title: `Memory search (${records.length})`,
              output: JSON.stringify(records, null, 2),
              metadata: { records },
            }
          }

          if (params.action === "list") {
            const records = yield* loop.supermemoryList({
              scope: params.scope,
              sessionID: ctx.sessionID,
              messageID: ctx.messageID,
              attribution: {
                session_id: String(ctx.sessionID),
                message_id: String(ctx.messageID),
                process_id: "tool",
                tool_name: "supermemory",
                agent: ctx.agent,
              },
            })
            return {
              title: `Memory list (${records.length})`,
              output: JSON.stringify(records, null, 2),
              metadata: { records },
            }
          }

          if (params.action === "profile") {
            const profile = yield* loop.supermemoryProfile({
              sessionID: ctx.sessionID,
              messageID: ctx.messageID,
              attribution: {
                session_id: String(ctx.sessionID),
                message_id: String(ctx.messageID),
                process_id: "tool",
                tool_name: "supermemory",
                agent: ctx.agent,
              },
            })
            return {
              title: "Memory profile",
              output: JSON.stringify(profile, null, 2),
              metadata: { profile },
            }
          }

          const removed = yield* loop.supermemoryForget({
            id: params.id,
            query: params.query,
            sessionID: ctx.sessionID,
            messageID: ctx.messageID,
            attribution: {
              session_id: String(ctx.sessionID),
              message_id: String(ctx.messageID),
              process_id: "tool",
              tool_name: "supermemory",
              agent: ctx.agent,
            },
          })
          return {
            title: "Memory forget",
            output: `Removed ${removed} memory entr${removed === 1 ? "y" : "ies"}.`,
            metadata: { removed },
          }
        }),
    }
  }),
)
