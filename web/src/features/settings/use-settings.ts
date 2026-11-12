/**
 * Reading and saving the desktop app's settings (GET/POST /api/desktop/settings). Every save goes
 * through useSaveSettings: optimistic, rolled back per key on failure, with the 400 body's
 * per-key issues. Settings sections use useSetting(key, fallback) for one value.
 */
import {
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query"
import { useCallback, useEffect, useState } from "react"

import { ApiError, apiGet, apiPost } from "@/lib/api"
import { desktopQueryKeys, useDesktop, type DesktopSettings } from "@/lib/desktop"

/** One refused entry of a save, as POST /api/desktop/settings reports it; key null = the whole request. */
export interface SettingIssue {
  key: string | null
  message: string
}

export const desktopSettingsQuery = () =>
  queryOptions({
    queryKey: desktopQueryKeys.settings,
    queryFn: ({ signal }) => apiGet<DesktopSettings>("/desktop/settings", {}, signal),
    // Changed only through this app, which writes the answer back into the cache.
    staleTime: 30_000,
  })

/** The settings, fetched only in the desktop app. */
export function useDesktopSettings() {
  const { isDesktop } = useDesktop()
  return useQuery({ ...desktopSettingsQuery(), enabled: isDesktop })
}

/** The issues of a failed save: per key from the 400 body, otherwise the error as a whole. */
export function settingIssues(error: unknown): SettingIssue[] {
  if (!error) return []
  if (error instanceof ApiError) {
    const issues = (error.body as { issues?: unknown } | undefined)?.issues
    if (Array.isArray(issues) && issues.length > 0) {
      return issues.map((issue: { key?: unknown; message?: unknown }) => ({
        key: typeof issue.key === "string" ? issue.key : null,
        message: String(issue.message ?? error.message),
      }))
    }
  }
  return [{ key: null, message: error instanceof Error ? error.message : String(error) }]
}

/** Keys whose change points the app at another bridge (or another token). */
const CONNECTION_KEYS = ["bridgeUrl", "token"]

/**
 * Drops every cached bridge answer so the whole app asks the newly configured bridge (the old
 * city's data must not linger). The desktop queries are kept.
 */
export function resetBridgeQueries(queryClient: QueryClient) {
  return queryClient.resetQueries({ predicate: (query) => query.queryKey[0] !== "desktop" })
}

/** The patch applied to the cached settings. Secrets are never cached: only `<key>Set` changes. */
function applyOptimistic(settings: DesktopSettings, patch: Record<string, unknown>): DesktopSettings {
  const next: DesktopSettings = { ...settings }
  for (const [key, value] of Object.entries(patch)) {
    if (`${key}Set` in settings && !(key in settings)) {
      next[`${key}Set`] = typeof value === "string" && value.trim() !== ""
    } else {
      next[key] = value
    }
  }
  return next
}

/** Puts back the values of the patched keys only, so other saves in flight keep theirs. */
function rollback(settings: DesktopSettings, previous: DesktopSettings, patch: Record<string, unknown>) {
  const next: DesktopSettings = { ...settings }
  for (const key of Object.keys(patch)) {
    for (const name of [key, `${key}Set`]) {
      if (name in previous) next[name] = previous[name]
    }
  }
  return next
}

const SAVED_FOR_MS = 2_500

export interface SaveSettings {
  /** POSTs a partial patch, e.g. { "tray.closeToTray": true }. Resolves false when it was refused. */
  save(patch: Record<string, unknown>): Promise<boolean>
  saving: boolean
  /** True for a moment after a successful save. */
  saved: boolean
  /** Issues of the last failed save (empty after a success). */
  issues: SettingIssue[]
  /** The issue message for one key; issues without a key are reported for every key. */
  errorFor(key: string): string | undefined
  /** Forgets the last error (e.g. when the user edits the field again). */
  clearError(): void
}

/** Saves settings with an optimistic update. Each call has its own saving/saved/error state. */
export function useSaveSettings(): SaveSettings {
  const queryClient = useQueryClient()
  const key = desktopQueryKeys.settings
  const mutation = useMutation({
    mutationFn: (patch: Record<string, unknown>) =>
      apiPost<DesktopSettings>("/desktop/settings", patch),
    onMutate: async (patch) => {
      await queryClient.cancelQueries({ queryKey: key })
      const previous = queryClient.getQueryData<DesktopSettings>(key)
      if (previous) queryClient.setQueryData(key, applyOptimistic(previous, patch))
      return { previous }
    },
    onError: (_error, patch, context) => {
      const current = queryClient.getQueryData<DesktopSettings>(key)
      if (current && context?.previous) {
        queryClient.setQueryData(key, rollback(current, context.previous, patch))
      }
    },
    onSuccess: (answer, patch) => {
      queryClient.setQueryData(key, answer)
      // Not awaited: with an unreachable bridge the refetches take seconds, the save is done.
      if (Object.keys(patch).some((name) => CONNECTION_KEYS.includes(name))) {
        void resetBridgeQueries(queryClient)
      }
    },
  })

  const [savedAt, setSavedAt] = useState<number | null>(null)
  useEffect(() => {
    if (savedAt === null) return
    const timer = setTimeout(() => setSavedAt(null), SAVED_FOR_MS)
    return () => clearTimeout(timer)
  }, [savedAt])

  const { mutateAsync, reset } = mutation
  const save = useCallback(
    async (patch: Record<string, unknown>) => {
      setSavedAt(null)
      try {
        await mutateAsync(patch)
        setSavedAt(Date.now())
        return true
      } catch {
        return false
      }
    },
    [mutateAsync]
  )

  const issues = settingIssues(mutation.error)
  return {
    save,
    saving: mutation.isPending,
    saved: savedAt !== null && !mutation.isPending,
    issues,
    errorFor: (name) => (issues.find((issue) => issue.key === name) ?? issues.find((issue) => issue.key === null))?.message,
    clearError: reset,
  }
}

export type SaveStatus = "idle" | "saving" | "saved" | "error"

/** One setting, typed by its fallback, as the field rows take it. */
export interface SettingField<T> {
  key: string
  /** The cached value (optimistic while a save is in flight); `fallback` until the settings loaded. */
  value: T
  /** False until the settings loaded, and when no desktop feature defines the key. */
  available: boolean
  save(value: T): Promise<boolean>
  status: SaveStatus
  /** Why the last save was refused (the 400 body's message for this key). */
  error: string | undefined
  clearError(): void
}

/**
 * One namespaced setting of a desktop feature, e.g. useSetting("tray.closeToTray", false).
 * `fallback` gives the type and is shown until the settings loaded; use the feature's default.
 */
export function useSetting<T>(key: string, fallback: T): SettingField<T> {
  const settings = useDesktopSettings()
  const saver = useSaveSettings()
  const available = settings.data !== undefined && key in settings.data
  const { save } = saver
  const error = saver.errorFor(key)
  return {
    key,
    value: available ? (settings.data[key] as T) : fallback,
    available,
    save: useCallback((value: T) => save({ [key]: value }), [save, key]),
    status: saver.saving ? "saving" : error ? "error" : saver.saved ? "saved" : "idle",
    error,
    clearError: saver.clearError,
  }
}
