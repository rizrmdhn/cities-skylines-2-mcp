/**
 * The only bridge routes the web companion can reach, in two separate allowlists:
 *   ALLOWED_ROUTES  read-only GETs; none of them may change game state.
 *   CONTROL_ROUTES  the few POSTs that do change it, each with a validator per parameter; only the
 *                   paths named in CONTROL_ROUTE_PATHS may be listed there.
 * The browser calls `/api<path>` and only the listed query parameters are passed on.
 */
export interface AllowedRoute {
  /** Bridge route, also the companion route after the `/api` prefix. */
  path: string
  /** Query parameters forwarded to the bridge; anything else is dropped. */
  params: readonly string[]
  /** How long the companion waits for the bridge. */
  timeoutMs: number
}

export const API_PREFIX = "/api"

export const ALLOWED_ROUTES: readonly AllowedRoute[] = [
  { path: "/ping", params: [], timeoutMs: 3_000 },
  { path: "/state", params: [], timeoutMs: 10_000 },
  { path: "/city/overview", params: [], timeoutMs: 10_000 },
  { path: "/city/demand", params: [], timeoutMs: 10_000 },
  { path: "/city/budget", params: [], timeoutMs: 10_000 },
  { path: "/city/services", params: [], timeoutMs: 10_000 },
  { path: "/city/coverage", params: ["service", "gaps"], timeoutMs: 20_000 },
  { path: "/city/traffic", params: ["limit"], timeoutMs: 20_000 },
  { path: "/city/notifications", params: ["limit"], timeoutMs: 10_000 },
  { path: "/city/happiness", params: [], timeoutMs: 10_000 },
  { path: "/city/infoview", params: ["view"], timeoutMs: 20_000 },
  { path: "/city/road-network", params: ["nets"], timeoutMs: 30_000 },
  { path: "/history", params: ["limit"], timeoutMs: 10_000 },
  { path: "/camera", params: [], timeoutMs: 5_000 },
  { path: "/city/gridmap", params: ["layer"], timeoutMs: 30_000 },
  {
    path: "/city/road-graph",
    params: ["x", "z", "radius", "limit", "nets"],
    timeoutMs: 20_000,
  },
]

/**
 * Routes that change game state. Must match isMutatingPath in mcp-server/src/index.ts and
 * IsMutatingPath in CS2MCP.Bridge/HttpBridgeServer.cs: none of them may be in the read allowlist,
 * and a control route must be one of them (so the bridge requires POST and honours read-only mode).
 */
export function isMutatingBridgePath(path: string): boolean {
  return (
    path.startsWith("/build/") ||
    path.startsWith("/sim/") ||
    path.endsWith("/set") ||
    [
      "/game/save",
      "/ui/popups/dismiss",
      "/city/tiles/buy",
      "/city/dev-tree/purchase",
      "/transit/stops/place",
      "/transit/lines/create",
      "/transit/routes/create",
      "/transit/lines/delete",
    ].includes(path)
  )
}

function bridgePathOf(apiPath: string): string | undefined {
  return apiPath.startsWith(API_PREFIX + "/") ? apiPath.slice(API_PREFIX.length) : undefined
}

export function findAllowedRoute(apiPath: string): AllowedRoute | undefined {
  const bridgePath = bridgePathOf(apiPath)
  return ALLOWED_ROUTES.find((route) => route.path === bridgePath)
}

/** Checks one raw query value: the value to send to the bridge, or an error message. */
export type ParamValidator = (raw: string) => { value: string } | { error: string }

/** A state-changing bridge route the companion forwards as POST, with validated parameters only. */
export interface ControlRoute {
  path: string
  method: "POST"
  /** Every parameter the route takes; anything else is refused. At least one must be present. */
  params: Readonly<Record<string, ParamValidator>>
  timeoutMs: number
}

/**
 * The state-changing bridge routes the companion may call, by name. Adding one here is a deliberate
 * decision about what a browser page may do to the running game; the control allowlist below may
 * contain nothing else (checked at load and by tests).
 */
export const CONTROL_ROUTE_PATHS: readonly string[] = ["/sim/control"]

/** Simulation speed of /sim/control: 0 = paused, 1 = normal, 2, 4 = the game's fastest, 8 = the bridge's maximum. */
export const MAX_SIM_SPEED = 8

const speedParam: ParamValidator = (raw) => {
  // Plain decimal only: no exponent, hex, sign, Infinity or empty string.
  const speed = /^\d{1,3}(\.\d{1,3})?$/.test(raw) ? Number(raw) : NaN
  if (!Number.isFinite(speed) || speed < 0 || speed > MAX_SIM_SPEED) {
    return { error: `speed must be a number from 0 to ${MAX_SIM_SPEED}` }
  }
  return { value: String(speed) }
}

const booleanParam =
  (name: string): ParamValidator =>
  (raw) =>
    raw === "true" || raw === "false" ? { value: raw } : { error: `${name} must be true or false` }

export const CONTROL_ROUTES: readonly ControlRoute[] = [
  {
    path: "/sim/control",
    method: "POST",
    params: { speed: speedParam, paused: booleanParam("paused") },
    timeoutMs: 10_000,
  },
]

export function findControlRoute(apiPath: string): ControlRoute | undefined {
  const bridgePath = bridgePathOf(apiPath)
  return CONTROL_ROUTES.find((route) => route.path === bridgePath)
}

/**
 * Validates the query of a control request: the parameters to forward, or why it is refused.
 * Unknown, repeated or invalid parameters refuse the whole request.
 */
export function validateControlParams(
  route: ControlRoute,
  searchParams: URLSearchParams
): { params: URLSearchParams } | { error: string } {
  const params = new URLSearchParams()
  for (const name of new Set(searchParams.keys())) {
    const validate = Object.hasOwn(route.params, name) ? route.params[name] : undefined
    if (!validate) return { error: `unknown parameter for ${route.path}: ${name}` }
    const values = searchParams.getAll(name)
    if (values.length > 1) return { error: `${name} given more than once` }
    const result = validate(values[0])
    if ("error" in result) return result
    params.set(name, result.value)
  }
  if (params.size === 0) {
    return { error: `provide at least one of: ${Object.keys(route.params).join(", ")}` }
  }
  return { params }
}

/**
 * The two allowlists' invariants, checked when this module loads: no read route changes game
 * state, and the control routes are exactly the ones named in `permittedControlPaths`.
 */
export function assertRouteInvariants(
  readRoutes: readonly AllowedRoute[],
  controlRoutes: readonly ControlRoute[],
  permittedControlPaths: readonly string[]
) {
  for (const route of readRoutes) {
    if (isMutatingBridgePath(route.path)) {
      throw new Error(`allowlisted route ${route.path} changes game state`)
    }
  }
  const seen = new Set<string>()
  for (const route of controlRoutes) {
    if (!permittedControlPaths.includes(route.path)) {
      throw new Error(`control route ${route.path} is not in CONTROL_ROUTE_PATHS`)
    }
    if (seen.has(route.path)) throw new Error(`control route ${route.path} is listed twice`)
    seen.add(route.path)
    if (route.method !== "POST" || !isMutatingBridgePath(route.path)) {
      throw new Error(`control route ${route.path} must be a state-changing POST`)
    }
    if (readRoutes.some((read) => read.path === route.path)) {
      throw new Error(`control route ${route.path} is also in the read allowlist`)
    }
  }
}

assertRouteInvariants(ALLOWED_ROUTES, CONTROL_ROUTES, CONTROL_ROUTE_PATHS)
