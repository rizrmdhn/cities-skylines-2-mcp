/**
 * Server-side bridge access for features (background polling without a window). Goes through
 * the same allowlist core as the renderer's /api calls: only read-only GET routes listed in
 * web/server/routes.ts can be reached.
 */
import { proxyBridgeRequest, type ApiErrorBody, type ErrorKind, type ProxyOptions } from "../../web/server/proxy.ts"

export type BridgeParams = Record<string, string | number | boolean | undefined>

export interface BridgeClient {
  /**
   * GET one allowlisted bridge route, e.g. ctx.bridge.get<Ping>("/ping") or
   * ctx.bridge.get("/city/notifications", { limit: 5 }). Throws BridgeError on any failure.
   */
  get<T = unknown>(path: string, params?: BridgeParams): Promise<T>
}

/** Same fields as the {error, status, kind} body the renderer sees. */
export class BridgeError extends Error {
  readonly status: number
  readonly kind: ErrorKind
  constructor(body: ApiErrorBody) {
    super(body.error)
    this.name = "BridgeError"
    this.status = body.status
    this.kind = body.kind
  }
}

/** `options` is read on every call, so a changed bridge URL or token applies at once. */
export function createBridgeClient(options: () => ProxyOptions): BridgeClient {
  return {
    async get<T>(path: string, params: BridgeParams = {}) {
      const searchParams = new URLSearchParams()
      for (const [name, value] of Object.entries(params)) {
        if (value !== undefined) searchParams.set(name, String(value))
      }
      const response = await proxyBridgeRequest(
        { method: "GET", pathname: `/api${path}`, searchParams },
        options()
      )
      const body = JSON.parse(response.body) as unknown
      if (response.status >= 200 && response.status < 300) return body as T
      throw new BridgeError(body as ApiErrorBody)
    },
  }
}
