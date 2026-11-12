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

/** Connection state derived from /ping (answers even while loading) and, once that is fine, /state. */
export function useConnection(): Connection {
  const ping = useQuery(pingQuery())
  const bridgeUp =
    ping.data !== undefined && ping.data.bridgeEnabled && !ping.data.isLoading
  const state = useQuery({ ...stateQuery(), enabled: bridgeUp })

  let status: ConnectionStatus
  let error: string | undefined
  if (ping.isError) {
    status = "unreachable"
    error = ping.error.message
  } else if (!ping.data) {
    status = "checking"
  } else if (!ping.data.bridgeEnabled) {
    status = "disabled"
  } else if (ping.data.isLoading) {
    status = "loading"
  } else if (state.error instanceof ApiError && state.error.status === 401) {
    status = "unauthorized"
    error = state.error.message
  } else if (state.data && !state.data.cityLoaded) {
    status = "no-city"
  } else if (state.data?.cityLoaded) {
    status = "ready"
  } else if (state.isError) {
    status = "unreachable"
    error = state.error.message
  } else {
    status = "checking"
  }

  const modVersion = ping.data?.version
  return {
    status,
    ready: status === "ready",
    readOnly: ping.data?.readOnly ?? false,
    ping: ping.data,
    state: state.data,
    modVersion,
    versionMismatch:
      modVersion !== undefined && baseVersion(modVersion) !== baseVersion(APP_VERSION),
    error,
  }
}
