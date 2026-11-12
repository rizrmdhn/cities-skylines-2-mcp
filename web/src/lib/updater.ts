import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"

import { apiGet, apiPost } from "@/lib/api"
import { useDesktop } from "@/lib/desktop"

/**
 * The desktop app's updater feature (desktop/src/features/updater.ts): GET /api/desktop/updater
 * and the check / download / install actions. Everything here is inert in the browser companion.
 */

export type UpdaterStatus = "unsupported" | "idle" | "checking" | "available" | "downloading" | "ready" | "error"

export interface UpdateProgress {
  /** 0 to 100 */
  percent: number
  transferred: number
  total: number
  bytesPerSecond: number
}

/** GET /api/desktop/updater (and the answer to every POST). */
export interface UpdaterState {
  status: UpdaterStatus
  /** Why status is "unsupported" (a development run, a zip build, not Windows). */
  unsupportedReason: string | null
  currentVersion: string
  /** The newer version, once found; kept while it downloads and when it is ready. */
  availableVersion: string | null
  releaseNotesUrl: string | null
  progress: UpdateProgress | null
  /** ISO time of the last finished check. */
  lastCheck: string | null
  error: string | null
  autoCheck: boolean
  autoDownload: boolean
  channel: "stable" | "beta"
}

export type UpdaterAction = "check" | "download" | "install"

export const UPDATER_FEATURE = "updater"
export const updaterQueryKey = ["desktop", "updater"] as const

/** Local round trips are cheap: follow a running check or download closely, otherwise now and then. */
const BUSY_REFRESH_MS = 1000
const IDLE_REFRESH_MS = 60_000

/** The updater's state and actions; `state` stays undefined in the browser and without the feature. */
export function useUpdater() {
  const { isDesktop, info } = useDesktop()
  const queryClient = useQueryClient()
  const available = isDesktop && (info?.features.includes(UPDATER_FEATURE) ?? false)

  const query = useQuery({
    queryKey: updaterQueryKey,
    queryFn: ({ signal }) => apiGet<UpdaterState>("/desktop/updater", {}, signal),
    enabled: available,
    retry: false,
    refetchInterval: (q) =>
      q.state.data?.status === "checking" || q.state.data?.status === "downloading"
        ? BUSY_REFRESH_MS
        : IDLE_REFRESH_MS,
  })

  const action = useMutation({
    mutationFn: (name: UpdaterAction) => apiPost<UpdaterState>(`/desktop/updater/${name}`),
    onSuccess: (state) => queryClient.setQueryData(updaterQueryKey, state),
    // A refused action (409) leaves the state as it is; fetch it again to show what is true now.
    onError: () => void queryClient.invalidateQueries({ queryKey: updaterQueryKey }),
  })

  return { available, state: query.data, isPending: query.isPending, action }
}

/** Whether the header should draw attention to the updater. */
export function hasPendingUpdate(state: UpdaterState | undefined): state is UpdaterState {
  if (!state) return false
  if (state.status === "available" || state.status === "downloading" || state.status === "ready") return true
  return state.status === "error" && state.availableVersion !== null
}
