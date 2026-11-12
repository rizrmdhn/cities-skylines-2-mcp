import { useQuery } from "@tanstack/react-query"

import { apiGet } from "@/lib/api"
import type { HistoryEntry } from "@/lib/bridge-types"
import { useDesktop } from "@/lib/desktop"

/** GET /api/desktop/history-archive (desktop app only): the merged log of every game run, newest first. */
export interface HistoryArchive {
  city: string
  total: number
  maxEntries: number
  entries: HistoryEntry[]
}

/** Undefined data in the browser companion, in a desktop app without the feature, and while the game was never seen. */
export function useHistoryArchive() {
  const { info } = useDesktop()
  return useQuery({
    queryKey: ["desktop", "history-archive"] as const,
    queryFn: ({ signal }) => apiGet<HistoryArchive>("/desktop/history-archive", {}, signal),
    enabled: info?.features.includes("history-archive") ?? false,
    refetchInterval: 10_000,
    retry: false,
  })
}
