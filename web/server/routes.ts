/**
 * The only bridge routes the web companion can reach. Each is a read-only GET on the bridge;
 * the browser calls `/api<path>` and only the listed query parameters are passed on.
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
 * IsMutatingPath in CS2MCP.Bridge/HttpBridgeServer.cs: none of them may ever be allowlisted.
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

export function findAllowedRoute(apiPath: string): AllowedRoute | undefined {
  if (!apiPath.startsWith(API_PREFIX + "/")) return undefined
  const bridgePath = apiPath.slice(API_PREFIX.length)
  return ALLOWED_ROUTES.find((route) => route.path === bridgePath)
}
