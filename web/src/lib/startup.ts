import { useQuery } from "@tanstack/react-query"

import { apiGet } from "@/lib/api"
import { useDesktop } from "@/lib/desktop"

/** GET /api/desktop/startup; see desktop/README.md "Start with Windows". */
export interface StartupStatus {
  /** false in a development run and outside Windows. */
  supported: boolean
  reason: string | null
  openAtLogin: boolean
  startHidden: boolean
  /** What Windows says: "enabled" | "other-arguments" | "disabled-in-windows" | "not-registered"; null when unsupported. */
  system: string | null
  executablePath: string | null
  arguments: string[]
  startedHidden: boolean
  reconciled: { at: number; outcome: string } | null
  error: string | null
}

export const startupQueryKey = ["desktop", "startup"] as const

/** The start-with-Windows status (desktop app with the startup feature only). */
export function useStartupStatus() {
  const { info } = useDesktop()
  const available = info?.features.includes("startup") ?? false
  return useQuery({
    queryKey: startupQueryKey,
    queryFn: ({ signal }) => apiGet<StartupStatus>("/desktop/startup", {}, signal),
    enabled: available,
    retry: false,
  }).data
}
