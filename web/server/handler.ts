import type { IncomingMessage, ServerResponse } from "node:http"

import { findControlRoute } from "./routes.ts"
import {
  errorResponse,
  isApiPath,
  proxyBridgeRequest,
  type ProxyResponse,
} from "./proxy.ts"

export type { ApiErrorBody, ErrorKind } from "./proxy.ts"

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

/** Writes a ProxyResponse to a Node response. */
export function sendProxyResponse(res: ServerResponse, response: ProxyResponse) {
  res.writeHead(response.status, response.headers)
  res.end(response.body)
}

/**
 * Same rules as the bridge itself: only loopback Host names on our own port (DNS rebinding),
 * and no requests started by another site (a cross-origin Origin header). A request that changes
 * game state (`requireOrigin`) must also carry our own Origin: browsers always send one on POST,
 * so a missing Origin means a client we cannot vouch for.
 */
export function refusalReason(
  req: IncomingMessage,
  port: number | undefined,
  { requireOrigin = false }: { requireOrigin?: boolean } = {}
): string | null {
  if (port === undefined) return "companion is not listening yet"
  const allowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`]
  const host = req.headers.host?.toLowerCase()
  if (!host || !allowedHosts.includes(host)) {
    return `Host header must be ${allowedHosts.join(" or ")}`
  }
  const origin = req.headers.origin?.toLowerCase()
  if (origin === undefined && requireOrigin) {
    return "requests that change the game need an Origin header from the companion's own page"
  }
  if (
    origin !== undefined &&
    !allowedHosts.some((allowed) => origin === `http://${allowed}`)
  ) {
    return "requests from other sites are refused"
  }
  return null
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

    const refusal = refusalReason(req, options.getPort(), {
      requireOrigin: api && req.method === "POST" && findControlRoute(url.pathname) !== undefined,
    })
    if (refusal) {
      sendProxyResponse(res, errorResponse(403, "companion", refusal))
      return true
    }
    if (api) {
      const response = await proxyBridgeRequest(
        { method: req.method ?? "GET", pathname: url.pathname, searchParams: url.searchParams },
        { bridgeUrl: options.bridgeUrl, token: options.token }
      )
      sendProxyResponse(res, response)
    } else {
      options.serveStatic!(req, res)
    }
    return true
  }
}
