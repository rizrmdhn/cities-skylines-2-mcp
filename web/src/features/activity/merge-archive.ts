import type { HistoryEntry } from "@/lib/bridge-types"
import { entryKey } from "@/lib/sessions"

/**
 * The desktop app's archive (every entry it has seen, across game restarts) and the bridge's
 * live log (which may hold entries the archive has not polled yet). Both newest first; the
 * result is too. Entries are the same when `entryKey` matches; the archive's copy wins.
 *
 * Live entries the archive lacks are newer than everything in it (the archive polls the same
 * log), so they go last in time order. Ids cannot order entries of different game runs.
 */
export function mergeArchive(
  archive: readonly HistoryEntry[] | undefined,
  live: readonly HistoryEntry[] | undefined
): HistoryEntry[] {
  if (!archive) return [...(live ?? [])]
  const seen = new Set(archive.map(entryKey))
  const fresh = (live ?? []).filter((entry) => !seen.has(entryKey(entry)))
  return [...fresh, ...archive]
}
