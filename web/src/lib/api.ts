export type ApiErrorKind = "unreachable" | "bridge" | "companion"

/** Error body of every failed /api call (see server/proxy.ts). */
export class ApiError extends Error {
  readonly status: number
  readonly kind: ApiErrorKind
  /** The parsed error body, for routes that add details (e.g. `issues` of a refused settings update). */
  readonly body: unknown

  constructor(message: string, status: number, kind: ApiErrorKind, body?: unknown) {
    super(message)
    this.name = "ApiError"
    this.status = status
    this.kind = kind
    this.body = body
  }
}

export type QueryParams = Record<string, string | number | boolean | undefined>

function apiUrl(path: string, params: QueryParams = {}) {
  const url = new URL(`/api${path}`, window.location.origin)
  for (const [name, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(name, String(value))
  }
  return url
}

/** Sends one request and turns a non-2xx answer into an ApiError. */
async function apiRequest<T>(url: URL, init: RequestInit): Promise<T> {
  let response: Response
  try {
    response = await fetch(url, init)
  } catch (err) {
    if ((err as Error).name === "AbortError") throw err
    throw new ApiError(
      "Cannot reach the web companion server. Is it still running?",
      0,
      "unreachable"
    )
  }

  const text = await response.text()
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    body = undefined
  }
  if (!response.ok) {
    const error = body as { error?: string; kind?: ApiErrorKind } | undefined
    throw new ApiError(
      error?.error ?? `HTTP ${response.status}`,
      response.status,
      error?.kind ?? "companion",
      body
    )
  }
  return body as T
}

/** GET one allowlisted route through the companion, e.g. apiGet("/city/overview"). */
export function apiGet<T>(
  path: string,
  params: QueryParams = {},
  signal?: AbortSignal
): Promise<T> {
  return apiRequest<T>(apiUrl(path, params), {
    signal,
    headers: { Accept: "application/json" },
  })
}

/**
 * POST a JSON body to a companion route. Only the desktop app answers it, on its own
 * /api/desktop/* routes, e.g. apiPost("/desktop/settings", { bridgeUrl: null }); the bridge proxy
 * refuses it with 405 (its control routes take query parameters: use apiControl).
 */
export function apiPost<T>(path: string, body: unknown = {}, signal?: AbortSignal): Promise<T> {
  return apiRequest<T>(apiUrl(path), {
    method: "POST",
    signal,
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
}

/**
 * POST one of the bridge proxy's control routes (server/routes.ts CONTROL_ROUTES), parameters in
 * the query string and no body, e.g. apiControl("/sim/control", { speed: 2 }). The companion
 * validates the parameters and refuses anything else before it reaches the game.
 */
export function apiControl<T>(path: string, params: QueryParams, signal?: AbortSignal): Promise<T> {
  return apiRequest<T>(apiUrl(path, params), {
    method: "POST",
    signal,
    headers: { Accept: "application/json" },
  })
}
