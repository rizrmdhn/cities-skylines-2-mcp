import { describe, expect, it } from "vitest"

import { errorResponse, isApiPath, jsonResponse, proxyBridgeRequest } from "./proxy.ts"

const BRIDGE = "http://bridge.test:8642/"
const TOKEN = "s3cret-token-value"

interface Call {
  url: string
  init: RequestInit | undefined
}

/** A fetch that records the call and answers with `answer`. */
function fakeFetch(answer: () => Response | Promise<Response>) {
  const calls: Call[] = []
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init })
    return answer()
  }) as typeof fetch
  return { calls, fetchFn }
}

function get(pathname: string, search = "", method = "GET") {
  return { method, pathname, searchParams: new URLSearchParams(search) }
}

describe("proxyBridgeRequest", () => {
  it("forwards an allowlisted GET with only its parameters, the token and the timeout", async () => {
    const { calls, fetchFn } = fakeFetch(() => Response.json({ ok: true }))
    const res = await proxyBridgeRequest(
      get("/api/city/coverage", "service=fire station&gaps=0&evil=1"),
      { bridgeUrl: BRIDGE, token: TOKEN, fetch: fetchFn }
    )
    expect(res.status).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ ok: true })
    expect(res.headers["Content-Type"]).toContain("application/json")
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe("http://bridge.test:8642/city/coverage?service=fire%20station&gaps=0")
    const headers = calls[0].init?.headers as Record<string, string>
    expect(headers["X-CS2MCP-Token"]).toBe(TOKEN)
    expect(headers["X-CS2MCP-Timeout-Ms"]).toBe("18500")
    expect(JSON.stringify(res)).not.toContain(TOKEN)
  })

  it("refuses other methods and unknown routes without calling the bridge", async () => {
    const { calls, fetchFn } = fakeFetch(() => Response.json({}))
    const post = await proxyBridgeRequest(get("/api/build/road", "", "POST"), {
      bridgeUrl: BRIDGE,
      fetch: fetchFn,
    })
    expect(post.status).toBe(405)
    expect(post.headers.Allow).toBe("GET")
    expect(JSON.parse(post.body)).toMatchObject({ status: 405, kind: "companion" })

    const unknown = await proxyBridgeRequest(get("/api/build/road"), { bridgeUrl: BRIDGE, fetch: fetchFn })
    expect(unknown.status).toBe(404)
    expect(JSON.parse(unknown.body)).toEqual({
      error: "unknown endpoint: /api/build/road",
      status: 404,
      kind: "companion",
    })
    expect(calls).toHaveLength(0)
  })

  it("sends no token header without a token", async () => {
    const { calls, fetchFn } = fakeFetch(() => Response.json({}))
    await proxyBridgeRequest(get("/api/ping"), { bridgeUrl: BRIDGE, token: "", fetch: fetchFn })
    expect((calls[0].init?.headers as Record<string, string>)["X-CS2MCP-Token"]).toBeUndefined()
  })

  it("maps a network failure to 502 and a timeout to 504", async () => {
    const down = fakeFetch(() => Promise.reject(new TypeError("fetch failed")))
    const res = await proxyBridgeRequest(get("/api/ping"), { bridgeUrl: BRIDGE, fetch: down.fetchFn })
    expect(res.status).toBe(502)
    expect(JSON.parse(res.body)).toMatchObject({ kind: "unreachable" })

    const slow = fakeFetch(() =>
      Promise.reject(Object.assign(new Error("timed out"), { name: "TimeoutError" }))
    )
    const late = await proxyBridgeRequest(get("/api/ping"), { bridgeUrl: BRIDGE, fetch: slow.fetchFn })
    expect(late.status).toBe(504)
    expect(JSON.parse(late.body)).toMatchObject({ status: 504, kind: "unreachable" })
  })

  it("passes a bridge error through with its message, or a generic one", async () => {
    const json = fakeFetch(() => Response.json({ error: "no city loaded" }, { status: 409 }))
    const res = await proxyBridgeRequest(get("/api/state"), { bridgeUrl: BRIDGE, fetch: json.fetchFn })
    expect(res.status).toBe(409)
    expect(JSON.parse(res.body)).toEqual({ error: "no city loaded", status: 409, kind: "bridge" })

    const html = fakeFetch(() => new Response("<h1>oops</h1>", { status: 500 }))
    const generic = await proxyBridgeRequest(get("/api/state"), { bridgeUrl: BRIDGE, fetch: html.fetchFn })
    expect(JSON.parse(generic.body)).toEqual({
      error: "bridge returned HTTP 500",
      status: 500,
      kind: "bridge",
    })
  })
})

describe("control routes", () => {
  function post(search: string, pathname = "/api/sim/control") {
    return get(pathname, search, "POST")
  }

  it("forwards POST /api/sim/control as POST with only the validated parameters and the token", async () => {
    const { calls, fetchFn } = fakeFetch(() => Response.json({ paused: false, selectedSpeed: 8 }))
    const res = await proxyBridgeRequest(post("speed=8.0&paused=false"), {
      bridgeUrl: BRIDGE,
      token: TOKEN,
      fetch: fetchFn,
    })
    expect(res.status).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ paused: false, selectedSpeed: 8 })
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe("http://bridge.test:8642/sim/control?speed=8&paused=false")
    expect(calls[0].init?.method).toBe("POST")
    expect(calls[0].init?.body).toBeUndefined()
    const headers = calls[0].init?.headers as Record<string, string>
    expect(headers["X-CS2MCP-Token"]).toBe(TOKEN)
    expect(headers["X-CS2MCP-Timeout-Ms"]).toBe("8500")
    expect(JSON.stringify(res)).not.toContain(TOKEN)
  })

  it.each([
    ["speed=0", "speed=0"],
    ["speed=4", "speed=4"],
    ["speed=0.5", "speed=0.5"],
    ["paused=true", "paused=true"],
    ["paused=false", "paused=false"],
  ])("accepts %s", async (search, forwarded) => {
    const { calls, fetchFn } = fakeFetch(() => Response.json({}))
    const res = await proxyBridgeRequest(post(search), { bridgeUrl: BRIDGE, fetch: fetchFn })
    expect(res.status).toBe(200)
    expect(calls[0].url).toBe(`http://bridge.test:8642/sim/control?${forwarded}`)
  })

  it.each([
    ["", "provide at least one of: speed, paused"],
    ["speed=9", "speed must be a number from 0 to 8"],
    ["speed=-1", "speed must be a number from 0 to 8"],
    ["speed=", "speed must be a number from 0 to 8"],
    ["speed=abc", "speed must be a number from 0 to 8"],
    ["speed=Infinity", "speed must be a number from 0 to 8"],
    ["speed=NaN", "speed must be a number from 0 to 8"],
    ["speed=1e0", "speed must be a number from 0 to 8"],
    ["speed=0x4", "speed must be a number from 0 to 8"],
    ["speed= 4", "speed must be a number from 0 to 8"],
    ["paused=yes", "paused must be true or false"],
    ["paused=True", "paused must be true or false"],
    ["paused=1", "paused must be true or false"],
    ["speed=1&speed=8", "speed given more than once"],
    ["speed=1&dismissPopups=true", "unknown parameter for /sim/control: dismissPopups"],
    ["speed=1&dryRun=true", "unknown parameter for /sim/control: dryRun"],
    ["__proto__=1", "unknown parameter for /sim/control: __proto__"],
    ["constructor=1", "unknown parameter for /sim/control: constructor"],
  ])("refuses %j with 400 before the bridge", async (search, error) => {
    const { calls, fetchFn } = fakeFetch(() => Response.json({}))
    const res = await proxyBridgeRequest(post(search), { bridgeUrl: BRIDGE, fetch: fetchFn })
    expect(res.status).toBe(400)
    expect(JSON.parse(res.body)).toEqual({ error, status: 400, kind: "companion" })
    expect(calls).toHaveLength(0)
  })

  it.each(["GET", "PUT", "DELETE", "PATCH", "HEAD"])(
    "answers 405 (Allow: POST) for %s /api/sim/control",
    async (method) => {
      const { calls, fetchFn } = fakeFetch(() => Response.json({}))
      const res = await proxyBridgeRequest(get("/api/sim/control", "speed=1", method), {
        bridgeUrl: BRIDGE,
        fetch: fetchFn,
      })
      expect(res.status).toBe(405)
      expect(res.headers.Allow).toBe("POST")
      expect(JSON.parse(res.body)).toMatchObject({ status: 405, kind: "companion" })
      expect(calls).toHaveLength(0)
    }
  )

  it.each([
    "/api/sim/run",
    "/api/sim/control/",
    "/api/sim/Control",
    "/api/build/road",
    "/api/game/save",
    "/api/city/taxes/set",
    "/api/ui/popups/dismiss",
    "/api/state",
    "/api/ping",
  ])("refuses POST %s before the bridge", async (pathname) => {
    const { calls, fetchFn } = fakeFetch(() => Response.json({}))
    const res = await proxyBridgeRequest(post("speed=1", pathname), { bridgeUrl: BRIDGE, fetch: fetchFn })
    expect(res.status).toBe(405)
    expect(res.headers.Allow).toBe("GET")
    expect(calls).toHaveLength(0)
  })

  it.each([
    [403, "/sim/control is refused: read-only mode is on (game Options > CS2MCP)"],
    [401, "missing or invalid X-CS2MCP-Token header"],
    [409, "no city loaded"],
    [400, "provide ?speed=0..8 and/or ?paused=true|false"],
  ])("passes bridge error %i through with its message", async (status, error) => {
    const { fetchFn } = fakeFetch(() => Response.json({ error }, { status }))
    const res = await proxyBridgeRequest(post("paused=true"), { bridgeUrl: BRIDGE, fetch: fetchFn })
    expect(res.status).toBe(status)
    expect(JSON.parse(res.body)).toEqual({ error, status, kind: "bridge" })
  })
})

describe("helpers", () => {
  it("recognises /api paths", () => {
    expect(isApiPath("/api")).toBe(true)
    expect(isApiPath("/api/ping")).toBe(true)
    expect(isApiPath("/apiary")).toBe(false)
    expect(isApiPath("/")).toBe(false)
  })

  it("builds JSON and error answers", () => {
    expect(jsonResponse(200, { a: 1 }).body).toBe('{"a":1}')
    expect(jsonResponse(200, '{"raw":true}').body).toBe('{"raw":true}')
    const error = errorResponse(400, "companion", "bad", { "X-Extra": "1" })
    expect(error.headers["X-Extra"]).toBe("1")
    expect(error.headers["Cache-Control"]).toBe("no-store")
    expect(JSON.parse(error.body)).toEqual({ error: "bad", status: 400, kind: "companion" })
  })
})
