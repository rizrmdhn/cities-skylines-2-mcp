import { http, HttpResponse } from "msw"

import type { ConfigSource, DesktopSettings } from "@/lib/desktop"
import { enableDesktopMode, server } from "@/test/server"

interface Options {
  /** Values the main process would report from the environment (they win over saved values). */
  env?: { bridgeUrl?: string; token?: string }
  /** Stored settings, e.g. { bridgeUrl: "http://...", "tray.closeToTray": true }. Keys here are "defined". */
  values?: Record<string, unknown>
  secretsEncrypted?: boolean
  /** Per key: returns a message to refuse a value the way a feature's schema would (400 with `issues`). */
  validate?: Record<string, (value: unknown) => string | undefined>
  /** Slows the answer to POST (resolve it from the test) to look at the optimistic state. */
  holdPosts?: Promise<void>
  /** Extra desktop features reported by /api/desktop/info. */
  features?: string[]
}

/**
 * A stand-in for the main process's settings routes, with the same shape as desktop/src:
 * secrets only as `<key>Set`, 400 with per-key `issues`, `null`/"" clears bridgeUrl and token.
 * Also turns on desktop mode. `posts` records every request body; `responses` every answer body.
 */
export function mockDesktopSettings(options: Options = {}) {
  const values: Record<string, unknown> = { bridgeUrl: null, ...options.values }
  let token: string | null = null
  const posts: unknown[] = []
  const responses: string[] = []

  function snapshot(): DesktopSettings {
    const env = options.env ?? {}
    const bridgeUrl = env.bridgeUrl ?? (values.bridgeUrl as string | null) ?? "http://127.0.0.1:8642"
    const bridgeUrlSource: ConfigSource = env.bridgeUrl ? "env" : values.bridgeUrl ? "settings" : "default"
    const tokenSource: ConfigSource = env.token ? "env" : token ? "settings" : "default"
    return {
      ...(values as { bridgeUrl: string | null }),
      tokenSet: token !== null,
      effective: {
        bridgeUrl,
        bridgeUrlSource,
        tokenSet: Boolean(env.token ?? token),
        tokenSource,
      },
      secretsEncrypted: options.secretsEncrypted ?? true,
    }
  }
  const answer = (body: unknown, init?: ResponseInit) => {
    responses.push(JSON.stringify(body))
    return HttpResponse.json(body as Record<string, unknown>, init)
  }

  enableDesktopMode({ features: ["settings-api", ...(options.features ?? [])] })
  server.use(
    http.get("*/api/desktop/settings", () => answer(snapshot())),
    http.post("*/api/desktop/settings", async ({ request }) => {
      const patch = (await request.json()) as Record<string, unknown>
      posts.push(patch)
      await options.holdPosts
      const issues: { key: string; message: string }[] = []
      for (const [key, value] of Object.entries(patch)) {
        let message: string | undefined
        if (key === "token") {
          if (value !== null && typeof value !== "string") message = "expected string or null"
        } else if (!(key in values)) message = "unknown setting"
        else if (key === "bridgeUrl") {
          if (value !== null && value !== "" && !/^https?:\/\/\S+$/.test(String(value))) {
            message = "must be an http:// or https:// URL"
          }
        }
        message ??= options.validate?.[key]?.(value)
        if (message) issues.push({ key, message })
      }
      if (issues.length > 0) {
        const error = issues.map((issue) => `${issue.key}: ${issue.message}`).join("; ")
        return answer({ error, status: 400, kind: "companion", issues }, { status: 400 })
      }
      for (const [key, value] of Object.entries(patch)) {
        if (key === "token") token = value === null || value === "" ? null : String(value)
        else values[key] = key === "bridgeUrl" && value === "" ? null : value
      }
      return answer(snapshot())
    }),
    http.get("*/api/desktop/app-folders", () =>
      answer({ logs: "C:/Users/test/AppData/Roaming/CS2MCP Companion/logs", settings: "C:/Users/test/AppData/Roaming/CS2MCP Companion" })
    ),
    http.post("*/api/desktop/app-folders/:which", ({ params }) => {
      posts.push({ open: params.which })
      return answer({ ok: true })
    })
  )
  return {
    posts,
    responses,
    /** The token as the "main process" holds it; the renderer must never see it. */
    get token() {
      return token
    },
    values,
  }
}
