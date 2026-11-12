import { useMemo } from "react"
import { useQuery } from "@tanstack/react-query"

import { mergeArchive } from "@/features/activity/merge-archive"
import { useHistoryArchive } from "@/features/activity/use-archive"
import { groupSessions, type Session } from "@/lib/sessions"
import { historyQuery, overviewQuery } from "@/lib/queries"

/**
 * The AI history grouped into sessions (newest first), shared by the activity page and the map
 * replay. In the desktop app the archive (which survives game restarts) is merged with the
 * bridge's live log; elsewhere it is the live log alone.
 */
export function useActivity() {
  const history = useQuery(historyQuery())
  const overview = useQuery(overviewQuery())
  const archive = useHistoryArchive()
  const live = history.data?.entries
  const archived = archive.data?.entries
  const batchRunning = history.data?.batchRunning

  const entries = useMemo(
    () => (live || archived ? mergeArchive(archived, live) : undefined),
    [live, archived]
  )
  const sessions = useMemo<Session[] | undefined>(
    () => (entries ? groupSessions(entries, { batchRunning }) : undefined),
    [entries, batchRunning]
  )

  return {
    /** The bridge's own answer (spending, whether a batch is running, the log since the save was loaded). */
    history,
    entries,
    sessions,
    /** The archive of earlier game runs is part of `entries`. */
    archived: archived !== undefined,
    /** Set only when there is nothing to show: the bridge failed and there is no archive. */
    error: entries === undefined ? history.error : null,
    isPending: entries === undefined && !history.isError,
    city: overview.data?.cityName ?? archive.data?.city ?? undefined,
  }
}
