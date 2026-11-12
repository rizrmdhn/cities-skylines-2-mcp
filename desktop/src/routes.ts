/**
 * The main <-> renderer contract: the renderer calls fetch("/api/desktop/...") on the app://
 * origin and these handlers answer. GET for reads, POST with a JSON body for actions. Answers
 * are JSON; failures use the same {error, status, kind} body as the bridge proxy, with kind
 * "companion".
 */
import { z } from "zod"

import { errorResponse, jsonResponse, type ProxyResponse } from "../../web/server/proxy.ts"
import type { Logger } from "./logger.ts"
import { SettingsValidationError } from "./settings.ts"

export type DesktopMethod = "GET" | "POST"

export interface DesktopRequest {
  method: DesktopMethod
  /** Route path after /api, e.g. "/desktop/info". */
  path: string
  query: URLSearchParams
  /** Parsed JSON body of a POST; undefined when the body is empty. */
  body: unknown
  /** The body validated by a zod schema; a mismatch answers 400 with the issues. */
  parse<T>(schema: z.ZodType<T>): T
}

/** Return any JSON-serialisable value (undefined answers {"ok": true}), or throw RouteError. */
export type RouteHandler = (request: DesktopRequest) => unknown

/** Thrown by a handler to answer with this status and message (kind "companion"). */
export class RouteError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = "RouteError"
    this.status = status
  }
}

/** Raw request as the transport hands it over. */
export interface RawDesktopRequest {
  method: string
  /** Full path including /api, e.g. "/api/desktop/info". */
  pathname: string
  searchParams: URLSearchParams
  bodyText: string
}

export interface RouteRegistry {
  /** Registers GET /api<path>; `path` must start with "/desktop/". */
  get(path: string, handler: RouteHandler): void
  /** Registers POST /api<path> taking a JSON body; `path` must start with "/desktop/". */
  post(path: string, handler: RouteHandler): void
  list(): { method: DesktopMethod; path: string }[]
  dispatch(request: RawDesktopRequest): Promise<ProxyResponse>
}

export const DESKTOP_API_PREFIX = "/api/desktop"
const PATH_PATTERN = /^\/desktop(\/[a-z0-9][a-z0-9-]*)+$/

export function isDesktopApiPath(pathname: string) {
  return pathname === DESKTOP_API_PREFIX || pathname.startsWith(DESKTOP_API_PREFIX + "/")
}

function zodIssues(error: z.ZodError) {
  return error.issues
    .map((issue) => (issue.path.length ? `${issue.path.join(".")}: ${issue.message}` : issue.message))
    .join("; ")
}

export function createRouteRegistry({ log }: { log?: Logger } = {}): RouteRegistry {
  const routes = new Map<string, Map<DesktopMethod, RouteHandler>>()

  function add(method: DesktopMethod, path: string, handler: RouteHandler) {
    if (!PATH_PATTERN.test(path)) {
      throw new Error(`desktop route "${path}" must look like /desktop/<name>[/<name>...] (lowercase, digits, -)`)
    }
    const byMethod = routes.get(path) ?? new Map<DesktopMethod, RouteHandler>()
    if (byMethod.has(method)) throw new Error(`${method} ${path} is registered twice`)
    byMethod.set(method, handler)
    routes.set(path, byMethod)
  }

  return {
    get: (path, handler) => add("GET", path, handler),
    post: (path, handler) => add("POST", path, handler),
    list: () =>
      [...routes].flatMap(([path, byMethod]) => [...byMethod.keys()].map((method) => ({ method, path }))),

    async dispatch(raw) {
      const path = raw.pathname.slice("/api".length)
      const byMethod = routes.get(path)
      if (!byMethod) return errorResponse(404, "companion", `unknown endpoint: ${raw.pathname}`)
      const handler = byMethod.get(raw.method as DesktopMethod)
      if (!handler) {
        const allow = [...byMethod.keys()].join(", ")
        return errorResponse(405, "companion", `${raw.pathname} answers ${allow} only`, { Allow: allow })
      }

      let body: unknown
      if (raw.bodyText.trim() !== "") {
        try {
          body = JSON.parse(raw.bodyText)
        } catch {
          return errorResponse(400, "companion", "the request body is not valid JSON")
        }
      }
      const request: DesktopRequest = {
        method: raw.method as DesktopMethod,
        path,
        query: raw.searchParams,
        body,
        parse(schema) {
          const result = schema.safeParse(body)
          if (!result.success) throw new RouteError(400, zodIssues(result.error))
          return result.data
        },
      }

      try {
        const result = await handler(request)
        return jsonResponse(200, JSON.stringify(result === undefined ? { ok: true } : result))
      } catch (err) {
        if (err instanceof RouteError) return errorResponse(err.status, "companion", err.message)
        if (err instanceof SettingsValidationError) {
          // `issues` lets the settings page put each message next to its field.
          return jsonResponse(400, { error: err.message, status: 400, kind: "companion", issues: err.fields })
        }
        if (err instanceof z.ZodError) return errorResponse(400, "companion", zodIssues(err))
        log?.error(`${raw.method} ${raw.pathname} failed`, err)
        return errorResponse(500, "companion", `${raw.method} ${raw.pathname} failed; see the desktop log`)
      }
    },
  }
}
