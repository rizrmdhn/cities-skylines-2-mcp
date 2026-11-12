import { queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query"

import { apiGet, apiPost } from "@/lib/api"
import { useDesktop } from "@/lib/desktop"

/** GET /api/desktop/overlay (and the answer to its POST routes); see desktop/README.md "Overlay". */
export interface OverlayStatus {
  present: boolean
  enabled: boolean
  /** The overlay window exists. */
  open: boolean
  /** Electron accelerator, e.g. "CommandOrControl+Shift+O"; null = no hotkey. */
  hotkey: string | null
  hotkeyRegistered: boolean
  /** Why the hotkey is not active (taken by another application, rejected by the system). */
  hotkeyError: string | null
  /** 30 to 100. */
  opacity: number
  clickThrough: boolean
}

export const overlayQueryKey = ["desktop", "overlay"] as const

export const overlayQuery = () =>
  queryOptions({
    queryKey: overlayQueryKey,
    queryFn: ({ signal }) => apiGet<OverlayStatus>("/desktop/overlay", {}, signal),
    // The hotkey and the tray open and close the overlay without this window knowing: ask again now and then.
    refetchInterval: 3_000,
    retry: false,
  })

/** Whether the desktop app has the overlay feature (it answers /api/desktop/overlay). */
export function useOverlayAvailable() {
  const { info } = useDesktop()
  return info?.features.includes("overlay") ?? false
}

/** The overlay's status (desktop app with the overlay feature only) and the toggle action. */
export function useOverlay() {
  const available = useOverlayAvailable()
  const queryClient = useQueryClient()
  const status = useQuery({ ...overlayQuery(), enabled: available })
  const toggle = useMutation({
    mutationFn: () => apiPost<OverlayStatus>("/desktop/overlay/toggle"),
    onSuccess: (next) => queryClient.setQueryData(overlayQueryKey, next),
    onSettled: () => queryClient.invalidateQueries({ queryKey: overlayQueryKey }),
  })
  return { available, status: status.data, toggle }
}
