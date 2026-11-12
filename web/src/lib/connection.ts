import { useQuery } from "@tanstack/react-query"

import { ApiError } from "@/lib/api"
import type { GameState, Ping } from "@/lib/bridge-types"
import { pingQuery, stateQuery } from "@/lib/queries"

export const APP_VERSION = __APP_VERSION__

export type ConnectionStatus =
  | "checking"
  | "unreachable"
  | "unauthorized"
  | "disabled"
  | "loading"
  | "no-city"
  | "ready"

export interface Connection {
  status: ConnectionStatus
  /** Only "ready" means a city is loaded and city routes can be queried. */
  ready: boolean
  readOnly: boolean
  ping: Ping | undefined
  state: GameState | undefined
  modVersion: string | undefined
  versionMismatch: boolean
  error: string | undefined
}

/** "0.11.0+abc123" -> "0.11.0" (the mod reports its informational version). */
function baseVersion(version: string) {
  return version.split("+", 1)[0].trim()
}

/** Whether the mod and this app were built from different versions. */
export function isVersionMismatch(modVersion: string | undefined) {
  return modVersion !== undefined && baseVersion(modVersion) !== baseVersion(APP_VERSION)
}

/** The answers (or errors) of /ping and /state; state is only asked once ping says the bridge is up. */
export interface ConnectionProbe {
  ping: Ping | undefined
  pingError: Error | null
  state: GameState | undefined
  stateError: Error | null
}

/** The status the answers of /ping and /state amount to (shared by the header and the settings page). */
export function connectionStatusOf({ ping, pingError, state, stateError }: ConnectionProbe): {
  status: ConnectionStatus
  error: string | undefined
} {
  if (pingError) return { status: "unreachable", error: pingError.message }
  if (!ping) return { status: "checking", error: undefined }
  if (!ping.bridgeEnabled) return { status: "disabled", error: undefined }
  if (ping.isLoading) return { status: "loading", error: undefined }
  if (stateError instanceof ApiError && stateError.status === 401) {
    return { status: "unauthorized", error: stateError.message }
  }
  if (state && !state.cityLoaded) return { status: "no-city", error: undefined }
  if (state?.cityLoaded) return { status: "ready", error: undefined }
  if (stateError) return { status: "unreachable", error: stateError.message }
  return { status: "checking", error: undefined }
}

/** Connection state derived from /ping (answers even while loading) and, once that is fine, /state. */
export function useConnection(): Connection {
  const ping = useQuery(pingQuery())
  const bridgeUp =
    ping.data !== undefined && ping.data.bridgeEnabled && !ping.data.isLoading
  const state = useQuery({ ...stateQuery(), enabled: bridgeUp })

  const { status, error } = connectionStatusOf({
    ping: ping.data,
    pingError: ping.error,
    state: state.data,
    stateError: state.error,
  })

  const modVersion = ping.data?.version
  return {
    status,
    ready: status === "ready",
    readOnly: ping.data?.readOnly ?? false,
    ping: ping.data,
    state: state.data,
    modVersion,
    versionMismatch: isVersionMismatch(modVersion),
    error,
  }
}
