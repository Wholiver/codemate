import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import * as SessionClosedLoop from "@/session/closed-loop"
import { filterTrajectoryByRun } from "@/session/trajectory"

const DESCRIPTION = `Append a markdown entry to project changelog (.codemate/changelog.md).`

export const Parameters = Schema.Struct({
  title: Schema.String,
  body: Schema.String,
})

const DOC_TOPIC_KEYWORDS = ["readme", "architecture", "markdown", "doc link", "文档", "链接", "拼写", "typo"]
const TLS_TOPIC_KEYWORDS = [
  "tls",
  "ssl",
  "certificate",
  "openssl",
  "server.key",
  "server.crt",
  "server.pem",
  "verification.txt",
  "check_cert.py",
  "common name",
  "cn=",
  "fingerprint",
]

function includesAny(text: string, keywords: string[]) {
  const lower = text.toLowerCase()
  return keywords.some((keyword) => lower.includes(keyword))
}

export const ChangelogAppendTool = Tool.define(
  "changelog_append",
  Effect.gen(function* () {
    const loop = yield* SessionClosedLoop.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          yield* ctx.ask({
            permission: "changelog_append",
            patterns: [params.title],
            always: ["*"],
            metadata: {
              title: params.title,
            },
          })

          let title = params.title
          let body = params.body
          const activeRun = yield* loop.activeRun(ctx.sessionID).pipe(Effect.orElseSucceed(() => undefined))
          if (activeRun?.status === "active") {
            const trajectory = yield* loop.listTrajectory(ctx.sessionID).pipe(Effect.orElseSucceed(() => []))
            const trajectoryForRun = filterTrajectoryByRun(trajectory, activeRun.run_id)
            const actualArtifactPaths = [
              ...new Set(trajectoryForRun.flatMap((record) => record.artifact_paths).filter((path) => path.trim().length > 0)),
            ]
            const isPrimarySslPath = (path: string) => /^\/app\/ssl(?:\/|$)/.test(path)
            const isFallbackSslPath = (path: string) => /^~\/app\/ssl(?:\/|$)/.test(path)
            const hasTlsRun =
              actualArtifactPaths.some((path) => isPrimarySslPath(path) || isFallbackSslPath(path)) ||
              trajectoryForRun.some((record) =>
                [...record.actual_outputs, ...record.verification_results].join("\n").toLowerCase().includes("certificate"),
              )
            if (hasTlsRun) {
              const combined = `${title}\n${body}`
              const mentionsDocTopic = includesAny(combined, DOC_TOPIC_KEYWORDS)
              const mentionsTlsTopic = includesAny(combined, TLS_TOPIC_KEYWORDS)
              if (mentionsDocTopic && !mentionsTlsTopic) {
                return {
                  title: "Changelog skipped",
                  output: "Skipped unrelated changelog entry for the current task.",
                  metadata: {
                    skipped: true,
                    reason: "stale_writer_topic",
                  },
                }
              }

              const fallbackOnly =
                actualArtifactPaths.some((path) => isFallbackSslPath(path)) &&
                !actualArtifactPaths.some((path) => isPrimarySslPath(path))
              if (fallbackOnly) {
                title = title.replaceAll("/app/ssl", "~/app/ssl")
                body = body.replaceAll("/app/ssl", "~/app/ssl")
                if (!body.toLowerCase().includes("~app/ssl") && !body.toLowerCase().includes("~/app/ssl")) {
                  body = `${body.trim()}\n\n- Note: /app was unavailable or read-only; outputs were written under ~/app/ssl.`
                }
              }
            }
          }

          yield* loop.appendChangelog({ sessionID: ctx.sessionID, title, body })

          return {
            title: "Changelog updated",
            output: `Appended changelog entry: ${title}`,
            metadata: {
              title,
            },
          }
        }),
    }
  }),
)
