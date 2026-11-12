import type { IncomingMessage, ServerResponse } from "node:http"

import {
  ALLOWED_ROUTES,
  API_PREFIX,
  findAllowedRoute,
  isMutatingBridgePath,
} from "./routes.ts"

export type ErrorKind = "unreachable" | "bridge" | "companion"

export interface ApiErrorBody {
  error: string
  status: number
  kind: ErrorKind
}

export interface CompanionHandlerOptions {
  /** Bridge base URL, e.g. http://127.0.0.1:8642 */
  bridgeUrl: string
  /** Shared secret sent to the bridge as X-CS2MCP-Token; never sent to the browser. */
  token?: string
  /** Port the browser reaches the companion on. Read per request: the dev server may pick another port. */
  getPort: () => number | undefined
  /** Serves everything outside /api; when absent those requests are left to the caller. */
  serveStatic?: (req: IncomingMessage, res: ServerResponse) => void
}

/** The bridge releases a request this long before we give up on it, so its own message wins. */
const BRIDGE_TIMEOUT_MARGIN_MS = 1_500

for (const route of ALLOWED_ROUTES) {
  if (isMutatingBridgePath(route.path)) {
    throw new Error(`allowlisted route ${route.path} changes game state`)
  }
}

export function sendJson(res: ServerResponse, status: number, body: unknown) {
  const text = typeof body === "string" ? body : JSON.stringify(body)
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  })
  res.end(text)
}

function sendError(
  res: ServerResponse,
  status: number,
  kind: ErrorKind,
  error: string,
  headers: Record<string, string> = {}
) {
  for (const [name, value] of Object.entries(headers)) res.setHeader(name, value)
  sendJson(res, status, { error, status, kind } satisfies ApiErrorBody)
}

/**
 * Same rules as the bridge itself: only loopback Host names on our own port (DNS rebinding),
 * and no requests started by another site (a cross-origin Origin header).
 */
export function refusalReason(
  req: IncomingMessage,
  port: number | undefined
): string | null {
  if (port === undefined) return "companion is not listening yet"
  const allowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`]
  const host = req.headers.host?.toLowerCase()
  if (!host || !allowedHosts.includes(host)) {
    return `Host header must be ${allowedHosts.join(" or ")}`
  }
  const origin = req.headers.origin?.toLowerCase()
  if (
    origin !== undefined &&
    !allowedHosts.some((allowed) => origin === `http://${allowed}`)
  ) {
    return "requests from other sites are refused"
  }
  return null
}

function isApiPath(pathname: string) {
  return pathname === API_PREFIX || pathname.startsWith(API_PREFIX + "/")
}

async function forwardToBridge(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  options: CompanionHandlerOptions
) {
  if (req.method !== "GET") {
    sendError(res, 405, "companion", "the web companion is read-only: only GET is allowed", {
      Allow: "GET",
    })
    return
  }
  const route = findAllowedRoute(url.pathname)
  if (!route) {
    sendError(res, 404, "companion", `unknown endpoint: ${url.pathname}`)
    return
  }

  const query = new URLSearchParams()
  for (const name of route.params) {
    const value = url.searchParams.get(name)
    if (value !== null) query.set(name, value)
  }
  // Spaces as %20: older bridge builds kept '+' literal.
  const queryString = query.toString().replace(/\+/g, "%20")
  const target = `${options.bridgeUrl.replace(/\/+$/, "")}${route.path}${queryString ? `?${queryString}` : ""}`

  const headers: Record<string, string> = {
    "X-CS2MCP-Timeout-Ms": String(
      Math.max(1_000, route.timeoutMs - BRIDGE_TIMEOUT_MARGIN_MS)
    ),
  }
  if (options.token) headers["X-CS2MCP-Token"] = options.token

  let bridgeResponse: Response
  try {
    bridgeResponse = await fetch(target, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(route.timeoutMs),
    })
  } catch (err) {
    const error = err as Error
    if (error.name === "TimeoutError") {
      sendError(
        res,
        504,
        "unreachable",
        `the CS2 bridge did not answer ${route.path} within ${route.timeoutMs / 1000} s`
      )
    } else {
      sendError(
        res,
        502,
        "unreachable",
        `Cannot reach the CS2 bridge at ${options.bridgeUrl}. Make sure Cities: Skylines II is running and the CS2MCP mod is enabled.`
      )
    }
    return
  }

  const text = await bridgeResponse.text()
  if (bridgeResponse.ok) {
    sendJson(res, 200, text)
    return
  }
  let message = `bridge returned HTTP ${bridgeResponse.status}`
  try {
    const payload = JSON.parse(text) as { error?: unknown }
    if (typeof payload?.error === "string") message = payload.error
  } catch {
    // not JSON: keep the generic message
  }
  sendError(res, bridgeResponse.status, "bridge", message)
}

/**
 * Handles one request. Returns false when the request is not ours (outside /api and no static
 * server), so a host such as the Vite dev server can carry on with it.
 */
export function createCompanionHandler(options: CompanionHandlerOptions) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const url = new URL(req.url ?? "/", "http://companion.invalid")
    const api = isApiPath(url.pathname)
    if (!api && !options.serveStatic) return false

    const refusal = refusalReason(req, options.getPort())
    if (refusal) {
      sendError(res, 403, "companion", refusal)
      return true
    }
    if (api) {
      await forwardToBridge(req, res, url, options)
    } else {
      options.serveStatic!(req, res)
    }
    return true
  }
}
