import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type Server,
} from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"

import { ALLOWED_ROUTES, isMutatingBridgePath } from "./routes.ts"
import { createCompanionServer } from "./server.ts"

const TOKEN = "s3cret-token-value"

interface Recorded {
  method: string
  url: string
  headers: IncomingHttpHeaders
}

interface Reply {
  status: number
  body: unknown
}

/** A fake bridge that records every request and answers with `reply`. */
let recorded: Recorded[] = []
let reply: (req: Recorded) => Reply = (req) => ({
  status: 200,
  body: { ok: true, path: req.url },
})
let bridge: Server
let bridgeUrl: string

function listen(server: Server): Promise<number> {
  return new Promise((resolveListen) =>
    server.listen(0, "127.0.0.1", () =>
      resolveListen((server.address() as AddressInfo).port)
    )
  )
}

function close(server: Server): Promise<void> {
  return new Promise((resolveClose) => server.close(() => resolveClose()))
}

interface Response {
  status: number
  headers: IncomingHttpHeaders
  text: string
  json: () => unknown
}

function call(
  port: number,
  path: string,
  options: { method?: string; headers?: Record<string, string> } = {}
): Promise<Response> {
  return new Promise((resolveCall, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path,
        method: options.method ?? "GET",
        headers: options.headers,
      },
      (res) => {
        let text = ""
        res.setEncoding("utf8")
        res.on("data", (chunk: string) => (text += chunk))
        res.on("end", () =>
          resolveCall({
            status: res.statusCode ?? 0,
            headers: res.headers,
            text,
            json: () => JSON.parse(text),
          })
        )
      }
    )
    req.on("error", reject)
    req.end()
  })
}

beforeAll(async () => {
  bridge = createServer((req, res) => {
    const entry = { method: req.method ?? "", url: req.url ?? "", headers: req.headers }
    recorded.push(entry)
    const { status, body } = reply(entry)
    res.writeHead(status, { "Content-Type": "application/json" })
    res.end(JSON.stringify(body))
  })
  bridgeUrl = `http://127.0.0.1:${await listen(bridge)}`
})

afterAll(() => close(bridge))

let companion: Server | undefined
let staticDir: string | undefined

afterEach(async () => {
  recorded = []
  reply = (req) => ({ status: 200, body: { ok: true, path: req.url } })
  if (companion) await close(companion)
  companion = undefined
  if (staticDir) rmSync(staticDir, { recursive: true, force: true })
  staticDir = undefined
})

async function startCompanion(
  options: { bridgeUrl?: string; token?: string; staticDir?: string } = {}
) {
  companion = createCompanionServer({
    bridgeUrl: options.bridgeUrl ?? bridgeUrl,
    token: options.token ?? TOKEN,
    staticDir: options.staticDir,
  })
  return listen(companion)
}

describe("allowlisted routes", () => {
  it.each(ALLOWED_ROUTES.map((route) => route.path))(
    "forwards /api%s to the same bridge route",
    async (path) => {
      const port = await startCompanion()
      const res = await call(port, `/api${path}`)
      expect(res.status).toBe(200)
      expect(res.json()).toEqual({ ok: true, path })
      expect(recorded).toHaveLength(1)
      expect(recorded[0].method).toBe("GET")
      expect(recorded[0].url).toBe(path)
    }
  )

  it("passes only the parameters the route allows", async () => {
    const port = await startCompanion()
    await call(
      port,
      "/api/city/road-graph?x=120.5&z=-40&radius=300&limit=3000&nets=all&evil=1&token=x"
    )
    expect(recorded[0].url).toBe(
      "/city/road-graph?x=120.5&z=-40&radius=300&limit=3000&nets=all"
    )

    await call(port, "/api/city/gridmap?layer=landValue&x=1")
    expect(recorded[1].url).toBe("/city/gridmap?layer=landValue")

    await call(port, "/api/state?limit=5")
    expect(recorded[2].url).toBe("/state")
  })

  it("tells the bridge how long it will wait", async () => {
    const port = await startCompanion()
    await call(port, "/api/city/gridmap?layer=landValue")
    expect(recorded[0].headers["x-cs2mcp-timeout-ms"]).toBe("28500")
  })

  it("never allowlists a route the bridge treats as state-changing", () => {
    for (const route of ALLOWED_ROUTES) {
      expect(isMutatingBridgePath(route.path), route.path).toBe(false)
    }
  })
})

describe("refused requests never reach the bridge", () => {
  it.each(["/api/build/road", "/api/sim/run", "/api/city/taxes/set", "/api/screenshot", "/api"])(
    "answers 404 for %s",
    async (path) => {
      const port = await startCompanion()
      const res = await call(port, path)
      expect(res.status).toBe(404)
      expect(res.json()).toMatchObject({ status: 404, kind: "companion" })
      expect(recorded).toHaveLength(0)
    }
  )

  it.each(["POST", "PUT", "DELETE", "PATCH"])("answers 405 for %s", async (method) => {
    const port = await startCompanion()
    const res = await call(port, "/api/state", { method })
    expect(res.status).toBe(405)
    expect(res.headers.allow).toBe("GET")
    expect(res.json()).toMatchObject({ status: 405, kind: "companion" })
    expect(recorded).toHaveLength(0)
  })

  it("answers 405 (Allow: POST) for GET /api/sim/control", async () => {
    const port = await startCompanion()
    const res = await call(port, "/api/sim/control?paused=true")
    expect(res.status).toBe(405)
    expect(res.headers.allow).toBe("POST")
    expect(res.json()).toMatchObject({ status: 405, kind: "companion" })
    expect(recorded).toHaveLength(0)
  })

  it.each(["/api/build/road", "/api/sim/run", "/api/game/save", "/api/ui/popups/dismiss", "/api/city/taxes/set"])(
    "refuses POST %s even from the companion's own page",
    async (path) => {
      const port = await startCompanion()
      const res = await call(port, path, {
        method: "POST",
        headers: { Origin: `http://127.0.0.1:${port}` },
      })
      expect(res.status).toBe(405)
      expect(res.headers.allow).toBe("GET")
      expect(recorded).toHaveLength(0)
    }
  )

  it("refuses a Host that is not loopback on the companion port", async () => {
    const port = await startCompanion()
    for (const host of ["evil.example", `evil.example:${port}`, "127.0.0.1:1", `192.168.1.5:${port}`]) {
      const res = await call(port, "/api/state", { headers: { Host: host } })
      expect(res.status, host).toBe(403)
      expect(res.json()).toMatchObject({ kind: "companion" })
    }
    expect(recorded).toHaveLength(0)
  })

  it("accepts localhost and 127.0.0.1 on the companion port", async () => {
    const port = await startCompanion()
    for (const host of [`localhost:${port}`, `127.0.0.1:${port}`]) {
      const res = await call(port, "/api/state", { headers: { Host: host } })
      expect(res.status, host).toBe(200)
    }
  })

  it("refuses requests sent from another site", async () => {
    const port = await startCompanion()
    for (const origin of ["http://evil.example", `http://localhost:${port + 1}`, "null"]) {
      const res = await call(port, "/api/state", { headers: { Origin: origin } })
      expect(res.status, origin).toBe(403)
    }
    expect(recorded).toHaveLength(0)
  })
})

describe("simulation control", () => {
  function control(port: number, query: string, headers: Record<string, string> = {}) {
    return call(port, `/api/sim/control${query}`, { method: "POST", headers })
  }

  it("forwards POST /api/sim/control as POST with only the validated parameters and the token", async () => {
    reply = () => ({ status: 200, body: { paused: false, selectedSpeed: 4 } })
    const port = await startCompanion()
    const res = await control(port, "?speed=4", { Origin: `http://127.0.0.1:${port}` })
    expect(res.status).toBe(200)
    expect(res.json()).toEqual({ paused: false, selectedSpeed: 4 })
    expect(recorded).toHaveLength(1)
    expect(recorded[0].method).toBe("POST")
    expect(recorded[0].url).toBe("/sim/control?speed=4")
    expect(recorded[0].headers["x-cs2mcp-token"]).toBe(TOKEN)
    expect(recorded[0].headers["x-cs2mcp-timeout-ms"]).toBe("8500")
    expect(recorded[0].headers.origin).toBeUndefined()
    expect(res.text).not.toContain(TOKEN)
  })

  it("accepts the localhost origin too", async () => {
    const port = await startCompanion()
    const res = await control(port, "?paused=true", {
      Host: `localhost:${port}`,
      Origin: `http://localhost:${port}`,
    })
    expect(res.status).toBe(200)
    expect(recorded[0].url).toBe("/sim/control?paused=true")
  })

  it("refuses a POST without an Origin header", async () => {
    const port = await startCompanion()
    const res = await control(port, "?paused=true")
    expect(res.status).toBe(403)
    expect(res.json()).toMatchObject({ status: 403, kind: "companion" })
    expect(recorded).toHaveLength(0)
  })

  it("refuses a POST from another site", async () => {
    const port = await startCompanion()
    for (const origin of ["http://evil.example", `http://localhost:${port + 1}`, `https://127.0.0.1:${port}`, "null"]) {
      const res = await control(port, "?speed=8", { Origin: origin })
      expect(res.status, origin).toBe(403)
    }
    expect(recorded).toHaveLength(0)
  })

  it("refuses invalid values and extra parameters before the bridge", async () => {
    const port = await startCompanion()
    const origin = { Origin: `http://127.0.0.1:${port}` }
    for (const query of ["", "?speed=9", "?speed=fast", "?paused=1", "?speed=1&dismissPopups=true", "?speed=1&speed=2"]) {
      const res = await control(port, query, origin)
      expect(res.status, query).toBe(400)
      expect(res.json()).toMatchObject({ status: 400, kind: "companion" })
    }
    expect(recorded).toHaveLength(0)
  })

  it.each([
    [403, "/sim/control is refused: read-only mode is on (game Options > CS2MCP)"],
    [401, "missing or invalid X-CS2MCP-Token header"],
    [409, "no city loaded"],
  ])("passes bridge error %i through with its message", async (status, error) => {
    reply = () => ({ status, body: { error } })
    const port = await startCompanion()
    const res = await control(port, "?paused=true", { Origin: `http://127.0.0.1:${port}` })
    expect(res.status).toBe(status)
    expect(res.json()).toEqual({ error, status, kind: "bridge" })
  })
})

describe("token handling", () => {
  it("sends the token to the bridge and never back to the browser", async () => {
    reply = () => ({ status: 200, body: { cityName: "Riverside" } })
    const port = await startCompanion()
    const res = await call(port, "/api/city/overview", {
      headers: { Origin: `http://127.0.0.1:${port}` },
    })
    expect(res.status).toBe(200)
    expect(recorded[0].headers["x-cs2mcp-token"]).toBe(TOKEN)
    expect(recorded[0].headers.origin).toBeUndefined()
    expect(res.text).not.toContain(TOKEN)
    expect(JSON.stringify(res.headers)).not.toContain(TOKEN)
  })

  it("keeps the token out of bridge error messages", async () => {
    reply = () => ({ status: 401, body: { error: "missing or invalid X-CS2MCP-Token header" } })
    const port = await startCompanion()
    const res = await call(port, "/api/state")
    expect(res.text).not.toContain(TOKEN)
  })

  it("sends no token header when none is configured", async () => {
    const port = await startCompanion({ token: "" })
    await call(port, "/api/state")
    expect(recorded[0].headers["x-cs2mcp-token"]).toBeUndefined()
  })
})

describe("errors", () => {
  it("answers 502 unreachable when the bridge is down", async () => {
    const down = createServer()
    const downPort = await listen(down)
    await close(down)
    const port = await startCompanion({ bridgeUrl: `http://127.0.0.1:${downPort}` })
    const res = await call(port, "/api/ping")
    expect(res.status).toBe(502)
    expect(res.json()).toMatchObject({ status: 502, kind: "unreachable" })
  })

  it.each([
    [401, "missing or invalid X-CS2MCP-Token header"],
    [403, "Host header must be 127.0.0.1:8642 or localhost:8642"],
    [503, "the bridge is switched off in the game's Options > CS2MCP page"],
  ])("passes bridge error %i through with its message", async (status, error) => {
    reply = () => ({ status, body: { error } })
    const port = await startCompanion()
    const res = await call(port, "/api/city/overview")
    expect(res.status).toBe(status)
    expect(res.json()).toEqual({ error, status, kind: "bridge" })
  })
})

describe("identification", () => {
  it("names itself on every response when given a version", async () => {
    companion = createCompanionServer({ bridgeUrl, token: TOKEN, version: "1.2.3" })
    const port = await listen(companion)
    expect((await call(port, "/api/state")).headers["x-cs2mcp-companion"]).toBe("1.2.3")
    expect((await call(port, "/api/build/road")).headers["x-cs2mcp-companion"]).toBe("1.2.3")
  })
})

describe("static files", () => {
  async function startWithApp() {
    staticDir = mkdtempSync(join(tmpdir(), "cs2mcp-web-"))
    writeFileSync(join(staticDir, "index.html"), "<!doctype html><title>app</title>")
    mkdirSync(join(staticDir, "assets"))
    writeFileSync(join(staticDir, "assets", "app.js"), "console.log(1)")
    return startCompanion({ staticDir })
  }

  it("serves the app and falls back to index.html for client routes", async () => {
    const port = await startWithApp()
    for (const path of ["/", "/activity", "/map?layer=landValue"]) {
      const res = await call(port, path)
      expect(res.status, path).toBe(200)
      expect(res.text).toContain("<title>app</title>")
    }
    const asset = await call(port, "/assets/app.js")
    expect(asset.headers["content-type"]).toContain("text/javascript")
    expect((await call(port, "/assets/missing.js")).status).toBe(404)
  })

  it("applies the Host check to pages too", async () => {
    const port = await startWithApp()
    const res = await call(port, "/", { headers: { Host: "evil.example" } })
    expect(res.status).toBe(403)
  })

  it("does not serve files outside the app folder", async () => {
    const port = await startWithApp()
    const res = await call(port, "/%2e%2e/%2e%2e/package.json")
    expect(res.status).not.toBe(200)
  })
})
