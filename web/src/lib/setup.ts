/**
 * Client of the desktop app's `setup` feature (GET/POST /api/desktop/setup*), used by the
 * first-run wizard on /setup. The token never appears here: the main process generates, stores
 * and copies it. See desktop/README.md ("First-run setup").
 */
import { queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query"

import { apiGet, apiPost } from "@/lib/api"
import { desktopQueryKeys, useDesktop, type ConfigSource, type DesktopSettings } from "@/lib/desktop"

export type SetupBridgeLink = "ready" | "no-city" | "loading" | "disabled" | "unauthorized" | "unreachable"

export interface SetupBridge {
  link: SetupBridgeLink
  url: string
  modVersion: string | null
  appVersion: string
  versionMismatch: boolean
  readOnly: boolean
  city: string | null
  error: string | null
}

export type GameTokenState = "unsupported" | "unknown" | "unset" | "set" | "matches" | "different"

export type ClientEntryState = "none" | "current" | "outdated" | "unreadable"

export interface SetupClient {
  id: "claude-desktop" | "claude-code" | "codex" | "gemini-cli" | "cursor" | "vscode"
  name: string
  /** "json": the companion edits the file. "command": the client has its own CLI. */
  mode: "json" | "command"
  detected: boolean
  configPath: string
  note: string | null
  configExists: boolean
  state: ClientEntryState
  /** Our entry as found; env values are never sent, only their names. */
  entry: { command: string | null; args: string[]; envKeys: string[] } | null
  problem: string | null
}

/** GET /api/desktop/setup */
export interface SetupStatus {
  completed: boolean
  platform: string
  bridge: SetupBridge
  token: {
    set: boolean
    source: ConfigSource
    /** False when the process environment provides the token (it would override a saved one). */
    replaceable: boolean
    secretsEncrypted: boolean
    gameEnv: { supported: boolean; state: GameTokenState }
  }
  server: {
    found: boolean
    file: string | null
    searched: string[]
    problem: string | null
    mode: "dev" | "packaged"
    command: string
    args: string[]
    env: Record<string, string>
    serverName: string
  }
  clients: SetupClient[]
}

export type SnippetTarget = "claude-code" | "codex" | "codex-toml" | "gemini-cli" | "json" | "vscode"

export interface SetupSnippet {
  target: SnippetTarget
  title: string
  language: "powershell" | "json" | "toml"
  /** The token, when included, is masked in this text. */
  text: string
  where: string
  copied: boolean
  includesToken: boolean
}

export interface RegisterResult {
  client: SetupClient["id"]
  name: string
  change: "added" | "updated" | "removed" | "unchanged" | "manual"
  configPath: string | null
  backup: string | null
  envKeys?: string[]
  restart?: string
  command?: string
}

export const setupQueryKey = ["desktop", "setup"] as const

export const setupQuery = (poll: boolean) =>
  queryOptions({
    queryKey: setupQueryKey,
    queryFn: ({ signal }) => apiGet<SetupStatus>("/desktop/setup", {}, signal),
    refetchInterval: poll ? 3_000 : false,
    staleTime: 0,
    retry: false,
  })

/** The wizard's status; `poll` re-asks every 3 s (the game-mod step waits for the game to start). */
export function useSetupStatus(poll = false) {
  const { isDesktop } = useDesktop()
  return useQuery({ ...setupQuery(poll), enabled: isDesktop })
}

/** One POST action of the setup feature; refreshes the status afterwards. */
export function useSetupAction<TBody extends object | undefined, TResult>(path: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (body: TBody) => apiPost<TResult>(`/desktop/setup/${path}`, body),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: setupQueryKey }),
  })
}

/** Writes `setup.completed` into the cached settings so the first-run redirect does not fire again. */
export function useSetupCompletion() {
  const queryClient = useQueryClient()
  const remember = (completed: boolean) =>
    queryClient.setQueryData<DesktopSettings>(desktopQueryKeys.settings, (settings) =>
      settings ? { ...settings, "setup.completed": completed } : settings
    )
  const complete = useMutation({
    mutationFn: () => apiPost<{ completed: boolean }>("/desktop/setup/complete"),
    onSuccess: () => remember(true),
  })
  const reset = useMutation({
    mutationFn: () => apiPost<{ completed: boolean }>("/desktop/setup/reset"),
    onSuccess: () => remember(false),
  })
  return { complete, reset }
}
