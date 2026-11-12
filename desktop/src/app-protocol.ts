/**
 * Everything served on app://cs2mcp/, as a plain fetch-style handler (Request -> Response) so it
 * runs under Electron's protocol.handle and in Node tests alike:
 *   /api/desktop/*  -> the desktop route registry (routes.ts)
 *   /api/*          -> the bridge proxy core shared with the browser companion
 *   anything else   -> the built web app, via the static resolver shared with the companion
 */
import { readFile } from "node:fs/promises"

import { errorResponse, isApiPath, proxyBridgeRequest, type ProxyOptions, type ProxyResponse } from "../../web/server/proxy.ts"
import { resolveStaticFile } from "../../web/server/static-files.ts"
import type { Logger } from "./logger.ts"
import { isDesktopApiPath, type RouteRegistry } from "./routes.ts"

export const APP_SCHEME = "app"
export const APP_HOST = "cs2mcp"
export const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`

/** URL of a page of the web app, e.g. appUrl("/overlay") -> app://cs2mcp/overlay */
export function appUrl(route = "/") {
  return `${APP_ORIGIN}/${route.replace(/^\/+/, "")}`
}

export function isAppUrl(url: string) {
  try {
    const parsed = new URL(url)
    return parsed.protocol === `${APP_SCHEME}:` && parsed.host === APP_HOST
  } catch {
    return false
  }
}

/**
 * Sent with every HTML page. Inline styles stay allowed: React style props are fine anyway, but
 * the toaster (sonner) and the theme switch insert <style> elements.
 */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-src 'none'",
  "frame-ancestors 'none'",
].join("; ")

export interface AppHandlerOptions {
  /** The built web app (desktop/dist/renderer). */
  rendererDir: string
  routes: RouteRegistry
  /** Read per request: settings changes apply to the next call. */
  proxyOptions: () => ProxyOptions
  log?: Logger
}

function toResponse({ status, headers, body }: ProxyResponse) {
  return new Response(body, { status, headers })
}

export function createAppHandler({ rendererDir, routes, proxyOptions, log }: AppHandlerOptions) {
  async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (url.protocol !== `${APP_SCHEME}:` || url.host !== APP_HOST) {
      return new Response("not found", { status: 404 })
    }

    if (isApiPath(url.pathname)) {
      // Only our own pages may call the API (they send no Origin, or ours). Unlike the browser
      // companion this does not demand an Origin on the control POST: Electron sends none on
      // same-origin app:// requests (the smoke test checks the real button), and no other page can
      // reach this handler, because every window is locked to app://cs2mcp (security.ts).
      const origin = request.headers.get("Origin")
      if (origin !== null && origin !== APP_ORIGIN) {
        return toResponse(errorResponse(403, "companion", "requests from other sites are refused"))
      }
      if (isDesktopApiPath(url.pathname)) {
        return toResponse(
          await routes.dispatch({
            method: request.method,
            pathname: url.pathname,
            searchParams: url.searchParams,
            bodyText: request.method === "GET" || request.method === "HEAD" ? "" : await request.text(),
          })
        )
      }
      return toResponse(
        await proxyBridgeRequest(
          { method: request.method, pathname: url.pathname, searchParams: url.searchParams },
          proxyOptions()
        )
      )
    }

    const resolution = resolveStaticFile(rendererDir, request.method, url.pathname)
    if (resolution.kind === "error") {
      return new Response(resolution.body || null, {
        status: resolution.status,
        headers: resolution.headers,
      })
    }
    const headers = { ...resolution.headers }
    if (headers["Content-Type"]?.startsWith("text/html")) {
      headers["Content-Security-Policy"] = CONTENT_SECURITY_POLICY
    }
    const body = request.method === "HEAD" ? null : await readFile(resolution.file)
    return new Response(body, { status: 200, headers })
  }

  return async (request: Request): Promise<Response> => {
    try {
      return await handle(request)
    } catch (err) {
      log?.error(`${request.method} ${request.url} failed`, err)
      return toResponse(errorResponse(500, "companion", "internal error; see the desktop log"))
    }
  }
}
