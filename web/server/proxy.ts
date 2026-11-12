/**
 * Transport-agnostic core of the companion's /api: plain data in, plain data out. The HTTP
 * server (handler.ts), the Vite dev middleware and the desktop app's app:// protocol all answer
 * /api requests through proxyBridgeRequest, so the allowlist and the token handling exist once.
 */
import {
  API_PREFIX,
  findAllowedRoute,
  findControlRoute,
  validateControlParams,
} from "./routes.ts"

export type ErrorKind = "unreachable" | "bridge" | "companion"

/** Body of every failed /api call. */
export interface ApiErrorBody {
  error: string
  status: number
  kind: ErrorKind
}

/** One /api request, independent of the transport it arrived on. */
export interface ProxyRequest {
  method: string
  /** Path including the /api prefix, already URL-decoded by the URL parser, e.g. "/api/city/gridmap". */
  pathname: string
  searchParams: URLSearchParams
}

export interface ProxyOptions {
  /** Bridge base URL, e.g. http://127.0.0.1:8642 */
  bridgeUrl: string
  /** Shared secret sent to the bridge as X-CS2MCP-Token; never part of a ProxyResponse. */
  token?: string
  /** Defaults to the global fetch; tests and other runtimes may pass their own. */
  fetch?: typeof fetch
}

/** What to send back: `body` is always JSON text. */
export interface ProxyResponse {
  status: number
  headers: Record<string, string>
  body: string
}

/** The bridge releases a request this long before we give up on it, so its own message wins. */
const BRIDGE_TIMEOUT_MARGIN_MS = 1_500

/** Headers of every JSON answer of the companion. */
export const JSON_HEADERS: Readonly<Record<string, string>> = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
}

/** A JSON answer; a string body is taken as JSON text already. */
export function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {}
): ProxyResponse {
  return {
    status,
    headers: { ...headers, ...JSON_HEADERS },
    body: typeof body === "string" ? body : JSON.stringify(body),
  }
}

/** The `{error, status, kind}` answer every failed /api call gets. */
export function errorResponse(
  status: number,
  kind: ErrorKind,
  error: string,
  headers: Record<string, string> = {}
): ProxyResponse {
  return jsonResponse(status, { error, status, kind } satisfies ApiErrorBody, headers)
}

export function isApiPath(pathname: string) {
  return pathname === API_PREFIX || pathname.startsWith(API_PREFIX + "/")
}

/**
 * True for a request that would change the game (a POST on a control route). Transports require
 * the companion's own Origin on these, besides refusing foreign ones on every /api call: browsers
 * always send an Origin on POST, so a missing one is a client we cannot vouch for.
 */
export function changesGame(method: string, pathname: string) {
  return method === "POST" && findControlRoute(pathname) !== undefined
}

/** Refusal text for a control POST without an Origin. */
export const ORIGIN_REQUIRED_MESSAGE =
  "requests that change the game need an Origin header from the companion's own page"

/**
 * Answers one /api request. Only two kinds reach the bridge, with only their own query parameters,
 * the bridge timeout header and the token:
 *   - GET on a read route (ALLOWED_ROUTES), unknown parameters dropped;
 *   - POST on a control route (CONTROL_ROUTES), every parameter validated, anything else refused.
 * Never throws.
 */
export async function proxyBridgeRequest(
  request: ProxyRequest,
  options: ProxyOptions
): Promise<ProxyResponse> {
  const control = findControlRoute(request.pathname)
  if (control) {
    if (request.method !== control.method) {
      return errorResponse(
        405,
        "companion",
        `${control.path} changes game state: only ${control.method} is allowed`,
        { Allow: control.method }
      )
    }
    const validated = validateControlParams(control, request.searchParams)
    if ("error" in validated) return errorResponse(400, "companion", validated.error)
    return forward(control.method, control.path, validated.params, control.timeoutMs, options)
  }

  if (request.method !== "GET") {
    return errorResponse(
      405,
      "companion",
      "this route is read-only: only GET is allowed",
      { Allow: "GET" }
    )
  }
  const route = findAllowedRoute(request.pathname)
  if (!route) {
    return errorResponse(404, "companion", `unknown endpoint: ${request.pathname}`)
  }

  const query = new URLSearchParams()
  for (const name of route.params) {
    const value = request.searchParams.get(name)
    if (value !== null) query.set(name, value)
  }
  return forward("GET", route.path, query, route.timeoutMs, options)
}

/** Sends one checked request to the bridge and maps its answer (or failure) to a ProxyResponse. */
async function forward(
  method: "GET" | "POST",
  path: string,
  query: URLSearchParams,
  timeoutMs: number,
  options: ProxyOptions
): Promise<ProxyResponse> {
  // Spaces as %20: older bridge builds kept '+' literal.
  const queryString = query.toString().replace(/\+/g, "%20")
  const bridgeUrl = options.bridgeUrl.replace(/\/+$/, "")
  const target = `${bridgeUrl}${path}${queryString ? `?${queryString}` : ""}`

  const headers: Record<string, string> = {
    "X-CS2MCP-Timeout-Ms": String(Math.max(1_000, timeoutMs - BRIDGE_TIMEOUT_MARGIN_MS)),
  }
  if (options.token) headers["X-CS2MCP-Token"] = options.token

  const doFetch = options.fetch ?? fetch
  let bridgeResponse: Response
  let text: string
  try {
    bridgeResponse = await doFetch(target, {
      method,
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    })
    text = await bridgeResponse.text()
  } catch (err) {
    if ((err as Error).name === "TimeoutError") {
      return errorResponse(
        504,
        "unreachable",
        `the CS2 bridge did not answer ${path} within ${timeoutMs / 1000} s`
      )
    }
    return errorResponse(
      502,
      "unreachable",
      `Cannot reach the CS2 bridge at ${options.bridgeUrl}. Make sure Cities: Skylines II is running and the CS2MCP mod is enabled.`
    )
  }

  if (bridgeResponse.ok) return jsonResponse(200, text)

  let message = `bridge returned HTTP ${bridgeResponse.status}`
  try {
    const payload = JSON.parse(text) as { error?: unknown }
    if (typeof payload?.error === "string") message = payload.error
  } catch {
    // not JSON: keep the generic message
  }
  return errorResponse(bridgeResponse.status, "bridge", message)
}
