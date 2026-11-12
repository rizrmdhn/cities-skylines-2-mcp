import { useMutation, useQueryClient } from "@tanstack/react-query"

import { apiGet } from "@/lib/api"
import type { GameState, Ping } from "@/lib/bridge-types"
import { connectionStatusOf, isVersionMismatch, type ConnectionStatus } from "@/lib/connection"
import type { DesktopSettings } from "@/lib/desktop"
import { queryKeys } from "@/lib/queries"

export interface ConnectionTestResult {
  /** Never "checking": the test waits for both answers. */
  status: Exclude<ConnectionStatus, "checking">
  /** The URL the proxy used (the effective one, wherever it came from). */
  bridgeUrl: string
  /** Whether /ping was answered (the bridge is there even if /state then failed). */
  reached: boolean
  modVersion: string | undefined
  cityName: string | undefined
  versionMismatch: boolean
  readOnly: boolean
  error: string | undefined
}

async function get<T>(path: string): Promise<{ data?: T; error: Error | null }> {
  try {
    return { data: await apiGet<T>(path), error: null }
  } catch (err) {
    return { error: err instanceof Error ? err : new Error(String(err)) }
  }
}

/**
 * Asks the configured bridge /ping and, when it is up, /state through the desktop proxy (the
 * same path every page uses), and classifies the answers like the header does.
 */
export async function runConnectionTest(): Promise<ConnectionTestResult> {
  const settings = await apiGet<DesktopSettings>("/desktop/settings")
  const ping = await get<Ping>("/ping")
  const bridgeUp = ping.data !== undefined && ping.data.bridgeEnabled && !ping.data.isLoading
  const state = bridgeUp ? await get<GameState>("/state") : { data: undefined, error: null }
  const { status, error } = connectionStatusOf({
    ping: ping.data,
    pingError: ping.error,
    state: state.data,
    stateError: state.error,
  })
  return {
    status: status === "checking" ? "unreachable" : status,
    bridgeUrl: settings.effective.bridgeUrl,
    modVersion: ping.data?.version,
    reached: ping.data !== undefined,
    cityName: (state.data?.cityLoaded ? state.data.cityName : undefined) ?? undefined,
    versionMismatch: isVersionMismatch(ping.data?.version),
    readOnly: ping.data?.readOnly ?? false,
    error,
  }
}

/** The "Test connection" action; its answers also refresh the header's connection state. */
export function useConnectionTest() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: runConnectionTest,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.ping })
      void queryClient.invalidateQueries({ queryKey: queryKeys.state })
    },
  })
}
