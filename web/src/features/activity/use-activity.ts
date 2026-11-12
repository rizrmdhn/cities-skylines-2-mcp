import { useMemo } from "react"
import { useQuery } from "@tanstack/react-query"

import { groupSessions, type Session } from "@/lib/sessions"
import { historyQuery, overviewQuery } from "@/lib/queries"

/** The AI history grouped into sessions (newest first), shared by the activity page and the map replay. */
export function useActivity() {
  const history = useQuery(historyQuery())
  const overview = useQuery(overviewQuery())
  const entries = history.data?.entries
  const batchRunning = history.data?.batchRunning

  const sessions = useMemo<Session[] | undefined>(
    () => (entries ? groupSessions(entries, { batchRunning }) : undefined),
    [entries, batchRunning]
  )

  return {
    history,
    entries,
    sessions,
    city: overview.data?.cityName ?? undefined,
  }
}
