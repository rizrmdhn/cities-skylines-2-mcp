import { queryOptions, useQuery } from "@tanstack/react-query"

import { ApiError, apiGet } from "@/lib/api"

/**
 * The desktop app (desktop/) serves this same web app on app://cs2mcp and answers extra routes
 * under /api/desktop/*. The browser companion answers them with a JSON 404, which is how the app
 * knows where it runs. See desktop/README.md for the contract.
 */

/** GET /api/desktop/info */
export interface DesktopInfo {
  desktop: true
  version: string
  platform: string
  packaged: boolean
  /** Ids of the registered desktop features, e.g. "settings-api", "tray". */
  features: string[]
}

export type ConfigSource = "env" | "settings" | "dotenv" | "default"

/**
 * GET /api/desktop/settings (and the answer to POST). Secret settings (the token) appear only
 * as `<key>Set`. Feature settings appear under their namespaced key, e.g. "tray.closeToTray".
 */
export interface DesktopSettings {
  /** Stored bridge URL; null = not set here (env, .env or the default applies). */
  bridgeUrl: string | null
  /** Whether a token is stored. */
  tokenSet: boolean
  /** What the proxy actually uses right now, and where each value comes from. */
  effective: {
    bridgeUrl: string
    bridgeUrlSource: ConfigSource
    tokenSet: boolean
    tokenSource: ConfigSource
  }
  /** Whether stored secrets are encrypted at rest (Electron safeStorage). */
  secretsEncrypted: boolean
  [featureKey: string]: unknown
}

export const desktopQueryKeys = {
  info: ["desktop", "info"] as const,
  settings: ["desktop", "settings"] as const,
}

/** null when not running in the desktop app (the companion answered 404, or did not answer). */
export async function fetchDesktopInfo(signal?: AbortSignal): Promise<DesktopInfo | null> {
  try {
    return await apiGet<DesktopInfo>("/desktop/info", {}, signal)
  } catch (err) {
    if (err instanceof ApiError) return null
    throw err
  }
}

/** Asked once per page load: where the app runs does not change while it is open. */
export const desktopInfoQuery = () =>
  queryOptions({
    queryKey: desktopQueryKeys.info,
    queryFn: ({ signal }) => fetchDesktopInfo(signal),
    staleTime: Infinity,
    gcTime: Infinity,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  })

export interface Desktop {
  /** False while the answer is pending and in the browser companion. */
  isDesktop: boolean
  info: DesktopInfo | undefined
  /** True until the first answer arrived. */
  isPending: boolean
}

/** Whether the app runs inside the desktop shell, and its info. Never polls. */
export function useDesktop(): Desktop {
  const query = useQuery(desktopInfoQuery())
  const info = query.data ?? undefined
  return { isDesktop: info !== undefined, info, isPending: query.isPending }
}
