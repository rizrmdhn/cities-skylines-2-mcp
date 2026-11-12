export type ApiErrorKind = "unreachable" | "bridge" | "companion"

/** Error body of every failed /api call (see server/handler.ts). */
export class ApiError extends Error {
  readonly status: number
  readonly kind: ApiErrorKind

  constructor(message: string, status: number, kind: ApiErrorKind) {
    super(message)
    this.name = "ApiError"
    this.status = status
    this.kind = kind
  }
}

export type QueryParams = Record<string, string | number | boolean | undefined>

/** GET one allowlisted route through the companion, e.g. apiGet("/city/overview"). */
export async function apiGet<T>(
  path: string,
  params: QueryParams = {},
  signal?: AbortSignal
): Promise<T> {
  const url = new URL(`/api${path}`, window.location.origin)
  for (const [name, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(name, String(value))
  }

  let response: Response
  try {
    response = await fetch(url, { signal, headers: { Accept: "application/json" } })
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
      error?.kind ?? "companion"
    )
  }
  return body as T
}
