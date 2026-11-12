import { describe, expect, it } from "vitest"

import {
  ALLOWED_ROUTES,
  assertRouteInvariants,
  CONTROL_ROUTE_PATHS,
  CONTROL_ROUTES,
  findAllowedRoute,
  findControlRoute,
  isMutatingBridgePath,
  type ControlRoute,
} from "./routes.ts"

const noParams = { params: {}, timeoutMs: 1_000 } as const

describe("route allowlists", () => {
  it("the read allowlist contains no state-changing route", () => {
    for (const route of ALLOWED_ROUTES) {
      expect(isMutatingBridgePath(route.path), route.path).toBe(false)
    }
  })

  it("the control allowlist is exactly POST /sim/control", () => {
    // Adding a control route means changing this test too: it is a deliberate act.
    expect(CONTROL_ROUTE_PATHS).toEqual(["/sim/control"])
    expect(CONTROL_ROUTES.map((route) => `${route.method} ${route.path}`)).toEqual(["POST /sim/control"])
    expect(Object.keys(CONTROL_ROUTES[0].params)).toEqual(["speed", "paused"])
  })

  it("the two allowlists are separate", () => {
    expect(findAllowedRoute("/api/sim/control")).toBeUndefined()
    expect(findControlRoute("/api/sim/control")?.path).toBe("/sim/control")
    for (const route of ALLOWED_ROUTES) {
      expect(findControlRoute(`/api${route.path}`), route.path).toBeUndefined()
    }
    expect(findControlRoute("/sim/control")).toBeUndefined()
    expect(findControlRoute("/api/sim/run")).toBeUndefined()
  })

  it("refuses a read route that changes game state", () => {
    expect(() =>
      assertRouteInvariants([{ path: "/sim/run", params: [], timeoutMs: 1_000 }], [], [])
    ).toThrow("allowlisted route /sim/run changes game state")
  })

  it("refuses a control route that is not named in CONTROL_ROUTE_PATHS", () => {
    const extra: ControlRoute = { path: "/game/save", method: "POST", ...noParams }
    expect(() => assertRouteInvariants([], [...CONTROL_ROUTES, extra], CONTROL_ROUTE_PATHS)).toThrow(
      "control route /game/save is not in CONTROL_ROUTE_PATHS"
    )
  })

  it("refuses a duplicated, read-only or doubly listed control route", () => {
    const sim: ControlRoute = { path: "/sim/control", method: "POST", ...noParams }
    expect(() => assertRouteInvariants([], [sim, sim], ["/sim/control"])).toThrow("listed twice")
    const notMutating: ControlRoute = { path: "/state", method: "POST", ...noParams }
    expect(() => assertRouteInvariants([], [notMutating], ["/state"])).toThrow(
      "must be a state-changing POST"
    )
    expect(() =>
      assertRouteInvariants([{ path: "/sim/control", params: [], timeoutMs: 1 }], [], [])
    ).toThrow("changes game state")
  })

  it("accepts the real allowlists", () => {
    expect(() => assertRouteInvariants(ALLOWED_ROUTES, CONTROL_ROUTES, CONTROL_ROUTE_PATHS)).not.toThrow()
  })
})
