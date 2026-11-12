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
