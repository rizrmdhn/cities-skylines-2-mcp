import { describe, expect, it } from "vitest"
import { z } from "zod"

import { createLogger, createMemorySink } from "../src/logger.ts"
import { createRouteRegistry, isDesktopApiPath, RouteError } from "../src/routes.ts"

function call(registry: ReturnType<typeof createRouteRegistry>, method: string, pathname: string, bodyText = "", search = "") {
  return registry
    .dispatch({ method, pathname, searchParams: new URLSearchParams(search), bodyText })
    .then((res) => ({ ...res, json: JSON.parse(res.body) as Record<string, unknown> }))
}

describe("route registry", () => {
  it("answers GET and POST handlers with JSON", async () => {
    const routes = createRouteRegistry()
    routes.get("/desktop/echo", (req) => ({ q: req.query.get("q"), method: req.method }))
    routes.post("/desktop/echo", (req) => ({ got: req.body }))
    routes.post("/desktop/nothing", () => undefined)

    const get = await call(routes, "GET", "/api/desktop/echo", "", "q=1")
    expect(get.status).toBe(200)
    expect(get.headers["Content-Type"]).toContain("application/json")
    expect(get.json).toEqual({ q: "1", method: "GET" })

    expect((await call(routes, "POST", "/api/desktop/echo", '{"a":1}')).json).toEqual({ got: { a: 1 } })
    expect((await call(routes, "POST", "/api/desktop/nothing")).json).toEqual({ ok: true })
    expect(routes.list()).toEqual([
      { method: "GET", path: "/desktop/echo" },
      { method: "POST", path: "/desktop/echo" },
      { method: "POST", path: "/desktop/nothing" },
    ])
  })

  it("answers 404 for unknown paths and 405 with Allow for other methods", async () => {
    const routes = createRouteRegistry()
    routes.get("/desktop/info", () => ({}))
    const missing = await call(routes, "GET", "/api/desktop/nope")
    expect(missing.status).toBe(404)
    expect(missing.json).toEqual({ error: "unknown endpoint: /api/desktop/nope", status: 404, kind: "companion" })

    const wrong = await call(routes, "POST", "/api/desktop/info", "{}")
    expect(wrong.status).toBe(405)
    expect(wrong.headers.Allow).toBe("GET")
    expect(wrong.json).toMatchObject({ status: 405, kind: "companion" })
  })

  it("turns errors into {error, status, kind: companion}", async () => {
    const lines: string[] = []
    const routes = createRouteRegistry({ log: createLogger(createMemorySink(lines)) })
    routes.post("/desktop/typed", () => {
      throw new RouteError(409, "already running")
    })
    routes.post("/desktop/parse", (req) => req.parse(z.object({ n: z.number() })))
    routes.get("/desktop/crash", () => {
      throw new Error("secret internals")
    })

    expect(await call(routes, "POST", "/api/desktop/typed")).toMatchObject({
      status: 409,
      json: { error: "already running", status: 409, kind: "companion" },
    })
    const parse = await call(routes, "POST", "/api/desktop/parse", '{"n":"x"}')
    expect(parse.status).toBe(400)
    expect(parse.json.error).toMatch(/^n: /)
    expect((await call(routes, "POST", "/api/desktop/parse", '{"n":2}')).json).toEqual({ n: 2 })
    expect((await call(routes, "POST", "/api/desktop/parse", "{nope")).status).toBe(400)

    const crash = await call(routes, "GET", "/api/desktop/crash")
    expect(crash.status).toBe(500)
    expect(crash.body).not.toContain("secret internals")
    expect(lines.join("\n")).toContain("secret internals")
  })

  it("refuses badly formed and duplicate paths", () => {
    const routes = createRouteRegistry()
    for (const path of ["/other", "/desktop", "/desktop/", "/desktop/Upper", "/api/desktop/x"]) {
      expect(() => routes.get(path, () => null), path).toThrow()
    }
    routes.get("/desktop/a/b-c", () => null)
    expect(() => routes.get("/desktop/a/b-c", () => null)).toThrow(/twice/)
  })

  it("recognises desktop API paths", () => {
    expect(isDesktopApiPath("/api/desktop/info")).toBe(true)
    expect(isDesktopApiPath("/api/desktop")).toBe(true)
    expect(isDesktopApiPath("/api/desktopx")).toBe(false)
    expect(isDesktopApiPath("/api/state")).toBe(false)
  })
})
