import { useQuery } from "@tanstack/react-query"

import { apiGet } from "@/lib/api"
import { useDesktop } from "@/lib/desktop"

export type GameState = "unknown" | "not-running" | "starting" | "running" | "bridge-only" | "disabled" | "unsupported"

/** GET /api/desktop/game-detect; see desktop/README.md "Game detection". */
export interface GameDetectStatus {
  supported: boolean
  enabled: boolean
  state: GameState
  /** Process found or bridge answering. */
  active: boolean
  processName: string
  processFound: boolean | null
  bridgeReachable: boolean | null
  /** Epoch ms of the last change of `state`. */
  lastChange: number | null
  lastCheck: number | null
  nextCheckAt: number | null
  processError: string | null
}

export const gameDetectQueryKey = ["desktop", "game-detect"] as const

/** The game-detection status (desktop app with the game-detect feature only), refreshed every 5 s. */
export function useGameDetect() {
  const { info } = useDesktop()
  const available = info?.features.includes("game-detect") ?? false
  return useQuery({
    queryKey: gameDetectQueryKey,
    queryFn: ({ signal }) => apiGet<GameDetectStatus>("/desktop/game-detect", {}, signal),
    enabled: available,
    refetchInterval: 5_000,
    retry: false,
  }).data
}

/** One line for the settings page. */
export function describeGameState(status: GameDetectStatus): string {
  switch (status.state) {
    case "running":
      return "Cities: Skylines II is running and the bridge answers."
    case "starting":
      return "Cities: Skylines II is starting: the process is up, the bridge does not answer yet."
    case "bridge-only":
      return `The bridge answers, but no ${status.processName} process was found on this computer. The bridge is trusted.`
    case "not-running":
      return "Cities: Skylines II is not running."
    case "disabled":
      return "Game detection is turned off."
    case "unsupported":
      return "Game detection is only available on Windows."
    default:
      return "Checking…"
  }
}
