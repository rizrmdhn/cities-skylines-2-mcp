import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { CONTENT_SECURITY_POLICY, createAppHandler } from "../src/app-protocol.ts"
import { BridgeError } from "../src/bridge.ts"
import settingsApi from "../src/features/settings-api.ts"
import { createRouteRegistry } from "../src/routes.ts"
import { createTestContext } from "../src/testing.ts"

const TOKEN = "s3cret-token-value"

/** A fake bridge recording what reached it. */
function fakeBridge(answer: (url: URL) => Response = () => Response.json({ ok: true })) {
  const calls: { url: URL; headers: Record<string, string> }[] = []
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> })
    return answer(url)
  }) as typeof fetch
  return { calls, fetchFn }
}

let renderer: string
beforeAll(() => {
  renderer = mkdtempSync(join(tmpdir(), "cs2mcp-renderer-"))
  writeFileSync(join(renderer, "index.html"), "<!doctype html><title>app</title>")
})
afterAll(() => rmSync(renderer, { recursive: true, force: true }))

describe("app:// static files", () => {
  it("serves the web app with the CSP on HTML and an SPA fallback", async () => {
    const t = await createTestContext({ rendererDir: renderer })
    for (const path of ["/", "/map", "/activity?x=1"]) {
      const res = await t.fetch(path)
      expect(res.status, path).toBe(200)
      expect(res.headers.get("Content-Security-Policy")).toBe(CONTENT_SECURITY_POLICY)
      expect(await res.text()).toContain("<title>app</title>")
    }
    expect((await t.fetch("/assets/missing.js")).status).toBe(404)
    // the URL parser already folds %2e%2e segments; an encoded slash reaches the resolver
    expect((await t.fetch("/%2e%2e/%2e%2e/package.json")).status).toBe(404)
    expect((await t.fetch("/..%2f..%2fpackage.json")).status).toBe(403)
  })

  it("answers only its own host", async () => {
    const handler = createAppHandler({
      rendererDir: renderer,
      routes: createRouteRegistry(),
      proxyOptions: () => ({ bridgeUrl: "http://127.0.0.1:1" }),
    })
    expect((await handler(new Request("app://cs2mcp/"))).status).toBe(200)
    expect((await handler(new Request("app://other/"))).status).toBe(404)
    expect((await handler(new Request("app://other/api/ping"))).status).toBe(404)
  })

  it("answers HEAD without a body", async () => {
    const t = await createTestContext({ rendererDir: renderer })
    const res = await t.fetch("/", { method: "HEAD" })
    expect(res.status).toBe(200)
    expect(await res.text()).toBe("")
  })
})

describe("app:// /api proxy", () => {
  it("forwards allowlisted GETs with the token and refuses the rest", async () => {
    const bridge = fakeBridge()
    const t = await createTestContext({ bridgeFetch: bridge.fetchFn, env: { CS2MCP_TOKEN: TOKEN } })
    const ok = await t.request("GET", "/api/city/overview?evil=1")
    expect(ok.status).toBe(200)
    expect(bridge.calls[0].url.href).toBe("http://127.0.0.1:8642/city/overview")
    expect(bridge.calls[0].headers["X-CS2MCP-Token"]).toBe(TOKEN)

    const post = await t.request("POST", "/api/build/road", {})
    expect(post.status).toBe(405)
    const unknown = await t.request("GET", "/api/build/road")
    expect(unknown.status).toBe(404)
    expect(bridge.calls).toHaveLength(1)
  })

  it("refuses API calls from another origin", async () => {
    const bridge = fakeBridge()
    const t = await createTestContext({ bridgeFetch: bridge.fetchFn })
    const res = await t.fetch("/api/state", { headers: { Origin: "https://evil.example" } })
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ kind: "companion" })
    const own = await t.fetch("/api/state", { headers: { Origin: "app://cs2mcp" } })
    expect(own.status).toBe(200)
    expect(bridge.calls).toHaveLength(1)
  })

  it("reports an unreachable bridge", async () => {
    const t = await createTestContext()
    const res = await t.request("GET", "/api/ping")
    expect(res).toMatchObject({ status: 502, body: { kind: "unreachable" } })
  })
})

describe("settings routes", () => {
  it("shows settings without the token", async () => {
    const t = await createTestContext({ features: [settingsApi], env: { CS2MCP_TOKEN: TOKEN } })
    await t.core.token.set("stored-token-value")
    const res = await t.request<Record<string, unknown>>("GET", "/api/desktop/settings")
    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      bridgeUrl: null,
      tokenSet: true,
      effective: {
        bridgeUrl: "http://127.0.0.1:8642",
        bridgeUrlSource: "default",
        tokenSet: true,
        tokenSource: "env",
      },
      secretsEncrypted: false,
    })
    const text = JSON.stringify(res.body)
    expect(text).not.toContain(TOKEN)
    expect(text).not.toContain("stored-token-value")
  })

  it("applies a POSTed change to the next proxied call without a restart", async () => {
    const bridge = fakeBridge()
    const t = await createTestContext({ features: [settingsApi], bridgeFetch: bridge.fetchFn })
    await t.request("GET", "/api/ping")
    expect(bridge.calls[0].url.origin).toBe("http://127.0.0.1:8642")
    expect(bridge.calls[0].headers["X-CS2MCP-Token"]).toBeUndefined()

    const res = await t.request<Record<string, unknown>>("POST", "/api/desktop/settings", {
      bridgeUrl: "http://127.0.0.1:9999/",
      token: "new-token",
    })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({
      bridgeUrl: "http://127.0.0.1:9999",
      tokenSet: true,
      effective: { bridgeUrl: "http://127.0.0.1:9999", bridgeUrlSource: "settings", tokenSource: "settings" },
    })
    expect(JSON.stringify(res.body)).not.toContain("new-token")

    await t.request("GET", "/api/ping")
    expect(bridge.calls[1].url.origin).toBe("http://127.0.0.1:9999")
    expect(bridge.calls[1].headers["X-CS2MCP-Token"]).toBe("new-token")

    // empty clears
    const cleared = await t.request<Record<string, unknown>>("POST", "/api/desktop/settings", { token: "" })
    expect(cleared.body.tokenSet).toBe(false)
  })

  it("refuses invalid or unknown settings and changes nothing", async () => {
    const t = await createTestContext({ features: [settingsApi] })
    const bad = await t.request<Record<string, unknown>>("POST", "/api/desktop/settings", {
      bridgeUrl: "ftp://nope",
      token: "fine",
    })
    expect(bad.status).toBe(400)
    expect(bad.body).toMatchObject({ status: 400, kind: "companion" })
    expect(String(bad.body.error)).toContain("bridgeUrl")
    expect(bad.body.issues).toEqual([{ key: "bridgeUrl", message: "must be an http:// or https:// URL" }])
    expect(t.core.token.get()).toBeNull()

    expect((await t.request("POST", "/api/desktop/settings", { "window.main": null })).status).toBe(400)
    const unknown = await t.request<Record<string, unknown>>("POST", "/api/desktop/settings", { surprise: 1 })
    expect(unknown).toMatchObject({ status: 400, body: { issues: [{ key: "surprise", message: "unknown setting" }] } })
    const notObject = await t.request<Record<string, unknown>>("POST", "/api/desktop/settings", [1])
    expect(notObject.body.issues).toEqual([{ key: null, message: "expected a JSON object of settings" }])
  })
})

describe("ctx.bridge", () => {
  it("reaches allowlisted routes only, with current settings", async () => {
    const bridge = fakeBridge((url) =>
      url.pathname === "/state" ? Response.json({ error: "nope" }, { status: 503 }) : Response.json({ cityName: "Riverside" })
    )
    const t = await createTestContext({ bridgeFetch: bridge.fetchFn })
    await expect(t.ctx.bridge.get("/city/overview")).resolves.toEqual({ cityName: "Riverside" })

    const refused = await t.ctx.bridge.get("/build/road").catch((err: unknown) => err)
    expect(refused).toBeInstanceOf(BridgeError)
    expect(refused).toMatchObject({ status: 404, kind: "companion" })

    const failing = await t.ctx.bridge.get("/state").catch((err: unknown) => err)
    expect(failing).toMatchObject({ status: 503, kind: "bridge", message: "nope" })

    await t.ctx.bridge.get("/city/notifications", { limit: 5, other: "x" })
    expect(bridge.calls.at(-1)?.url.search).toBe("?limit=5")
    expect(bridge.calls).toHaveLength(3)
  })
})
