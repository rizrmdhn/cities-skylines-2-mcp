/**
 * Updates the installed app from GitHub Releases (electron-updater, the NSIS installer's
 * update path). Active only in the installed app; a development run, the zip build and other
 * platforms answer "unsupported" and never contact GitHub.
 *
 *   GET  /api/desktop/updater            the state below
 *   POST /api/desktop/updater/check      checks now (waits for the answer, returns the state)
 *   POST /api/desktop/updater/download   starts the download (returns at once, state "downloading")
 *   POST /api/desktop/updater/install    quits, runs the downloaded installer, restarts the app
 *
 * Flow: shortly after start and then every 6 hours the newest published `desktop-v*` release is
 * looked up (update-releases.ts: the repository also holds the game mod's releases, so GitHub's
 * "latest release" is not usable), compared with the running version, and the updater is pointed
 * at that release's files. A newer version is downloaded in the background (`updater.autoDownload`)
 * and installed when the app quits, or at once through /install.
 *
 * Settings: `updater.autoCheck` (default on), `updater.autoDownload` (default on),
 * `updater.channel` ("stable" or "beta": also take prereleases, default "stable").
 */
import { readdirSync } from "node:fs"
import { dirname } from "node:path"
import { z } from "zod"

import { defineFeature, type DesktopContext, type DesktopFeature } from "../context.ts"
import { RouteError } from "../routes.ts"
import {
  channelOf,
  compareVersions,
  pickRelease,
  RELEASES_API_URL,
  releaseFeedUrl,
  type CompanionRelease,
  type UpdateChannel,
} from "../update-releases.ts"

declare module "../settings.ts" {
  interface SettingValues {
    "updater.autoCheck": boolean
    "updater.autoDownload": boolean
    "updater.channel": UpdateChannel
  }
}

export type UpdaterStatus = "unsupported" | "idle" | "checking" | "available" | "downloading" | "ready" | "error"

export interface DownloadProgress {
  percent: number
  transferred: number
  total: number
  bytesPerSecond: number
}

/** GET /api/desktop/updater */
export interface UpdaterState {
  status: UpdaterStatus
  /** Why status is "unsupported"; null otherwise. */
  unsupportedReason: string | null
  currentVersion: string
  /** The newer version found (also while it downloads, and once it is ready); null when none. */
  availableVersion: string | null
  /** The release page of availableVersion. */
  releaseNotesUrl: string | null
  /** Only while downloading. */
  progress: DownloadProgress | null
  /** ISO time of the last finished check; null before the first. */
  lastCheck: string | null
  /** The message of the last failed check or download (status "error"). */
  error: string | null
  autoCheck: boolean
  autoDownload: boolean
  channel: UpdateChannel
}

/** What the feature needs from electron-updater; tests pass a fake. */
export interface UpdateDriver {
  /** Points the updater at one release and asks whether it is newer; resolves its version if so. */
  check(feed: { url: string; channel: string }): Promise<{ version: string } | null>
  download(onProgress: (progress: DownloadProgress) => void): Promise<void>
  /** Runs the downloaded installer silently and restarts the app. */
  quitAndInstall(): void
}

export interface UpdaterOptions {
  /** The releases API answer (JSON). Default: GitHub, through Electron's network stack (proxy aware). */
  fetchReleases?: () => Promise<unknown>
  /** Created on first use. Default: electron-updater's NSIS updater. */
  createDriver?: (ctx: DesktopContext) => Promise<UpdateDriver>
  /** Null when this run can update itself, otherwise why not. Default: only the installed Windows app. */
  unsupportedReason?: (ctx: DesktopContext) => string | null
  /** First check after start (default 30 s) and the time between checks (default 6 h). */
  initialDelayMs?: number
  intervalMs?: number
}

/** The NSIS installer puts "Uninstall <product>.exe" next to the app; a zip or unpacked build has none. */
function defaultUnsupportedReason(ctx: DesktopContext): string | null {
  if (!ctx.isPackaged) return "This is a development run; updates are checked only in the installed app."
  if (ctx.platform !== "win32") return "Updates are only available on Windows."
  try {
    if (readdirSync(dirname(process.execPath)).some((name) => /^uninstall.*\.exe$/i.test(name))) return null
  } catch {
    // Treated like a missing installer below.
  }
  return "This copy was not set up by the installer (zip or unpacked build); download the new version instead."
}

async function fetchReleasesFromGitHub(): Promise<unknown> {
  const { net } = await import("electron")
  const response = await net.fetch(RELEASES_API_URL, {
    headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
    signal: AbortSignal.timeout(20_000),
  })
  if (!response.ok) {
    const limited = response.status === 403 || response.status === 429
    throw new Error(
      limited ? "GitHub is limiting requests from this network; try again later" : `GitHub answered ${response.status}`
    )
  }
  return response.json()
}

async function createElectronUpdaterDriver(ctx: DesktopContext): Promise<UpdateDriver> {
  const { autoUpdater } = await import("electron-updater")
  const log = ctx.log
  autoUpdater.logger = {
    info: (message) => log.debug(String(message)),
    warn: (message) => log.warn(String(message)),
    error: (message) => log.error(String(message)),
    debug: (message) => log.debug(message),
  }
  // The feature decides when to download; the library installs a downloaded update on quit.
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.autoRunAppAfterInstall = true
  // Without a listener, an "error" event of the library would be thrown as an exception.
  autoUpdater.on("error", (err) => log.debug(`electron-updater: ${err.message}`))
  let onProgress: ((progress: DownloadProgress) => void) | undefined
  autoUpdater.on("download-progress", (p) =>
    onProgress?.({
      percent: p.percent,
      transferred: p.transferred,
      total: p.total,
      bytesPerSecond: p.bytesPerSecond,
    })
  )
  return {
    async check({ url, channel }) {
      autoUpdater.setFeedURL({ provider: "generic", url })
      autoUpdater.channel = channel
      autoUpdater.allowDowngrade = false
      const result = await autoUpdater.checkForUpdates()
      return result?.isUpdateAvailable ? { version: result.updateInfo.version } : null
    },
    async download(progress) {
      onProgress = progress
      try {
        await autoUpdater.downloadUpdate()
      } finally {
        onProgress = undefined
      }
    },
    quitAndInstall() {
      autoUpdater.quitAndInstall(true, true)
    },
  }
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err))

export function createUpdater(options: UpdaterOptions = {}): DesktopFeature {
  const {
    fetchReleases = fetchReleasesFromGitHub,
    createDriver = createElectronUpdaterDriver,
    unsupportedReason = defaultUnsupportedReason,
    initialDelayMs = 30_000,
    intervalMs = 6 * 60 * 60 * 1000,
  } = options

  return defineFeature({
    id: "updater",
    setup(ctx) {
      const autoCheck = ctx.settings.define("updater.autoCheck", { schema: z.boolean(), default: true })
      const autoDownload = ctx.settings.define("updater.autoDownload", { schema: z.boolean(), default: true })
      const channel = ctx.settings.define<UpdateChannel>("updater.channel", {
        schema: z.enum(["stable", "beta"]),
        default: "stable",
      })

      const unsupported = unsupportedReason(ctx)
      let status: UpdaterStatus = unsupported ? "unsupported" : "idle"
      let release: CompanionRelease | null = null
      let progress: DownloadProgress | null = null
      let lastCheck: string | null = null
      let error: string | null = null
      let driver: Promise<UpdateDriver> | undefined
      const getDriver = () => (driver ??= createDriver(ctx))

      const state = (): UpdaterState => ({
        status,
        unsupportedReason: unsupported,
        currentVersion: ctx.version,
        availableVersion: release?.version ?? null,
        releaseNotesUrl: release?.url ?? null,
        progress: status === "downloading" ? progress : null,
        lastCheck,
        error: status === "error" ? error : null,
        autoCheck: autoCheck.get(),
        autoDownload: autoDownload.get(),
        channel: channel.get(),
      })

      function requireSupported() {
        if (unsupported) throw new RouteError(409, unsupported)
      }

      async function check(): Promise<UpdaterState> {
        requireSupported()
        if (status === "checking" || status === "downloading" || status === "ready") return state()
        status = "checking"
        error = null
        try {
          const latest = pickRelease(await fetchReleases(), channel.get())
          lastCheck = new Date().toISOString()
          if (!latest || compareVersions(latest.version, ctx.version) <= 0) {
            release = null
            status = "idle"
            ctx.log.info(`up to date (${ctx.version}${latest ? `, newest release ${latest.version}` : ""})`)
            return state()
          }
          const found = await (await getDriver()).check({ url: releaseFeedUrl(latest.tag), channel: channelOf(latest.version) })
          lastCheck = new Date().toISOString()
          if (!found) {
            release = null
            status = "idle"
            return state()
          }
          release = latest
          status = "available"
          ctx.log.info(`update ${found.version} available`)
          if (autoDownload.get()) startDownload()
        } catch (err) {
          lastCheck = new Date().toISOString()
          error = message(err)
          status = "error"
          ctx.log.warn(`update check failed: ${error}`)
        }
        return state()
      }

      /** Flips to "downloading" at once; the download runs in the background. */
      function startDownload(): UpdaterState {
        requireSupported()
        if (status === "downloading" || status === "ready") return state()
        if (!release || (status !== "available" && status !== "error")) {
          throw new RouteError(409, "no update to download; check for updates first")
        }
        status = "downloading"
        error = null
        progress = { percent: 0, transferred: 0, total: 0, bytesPerSecond: 0 }
        ctx.log.info(`downloading ${release.version}`)
        void getDriver()
          .then((d) => d.download((p) => (progress = p)))
          .then(() => {
            status = "ready"
            ctx.log.info("update downloaded; it installs when the app quits")
          })
          .catch((err: unknown) => {
            error = message(err)
            status = "error"
            ctx.log.warn(`update download failed: ${error}`)
          })
        return state()
      }

      ctx.routes.get("/desktop/updater", state)
      ctx.routes.post("/desktop/updater/check", check)
      ctx.routes.post("/desktop/updater/download", startDownload)
      ctx.routes.post("/desktop/updater/install", async () => {
        requireSupported()
        if (status !== "ready") throw new RouteError(409, "no update has been downloaded yet")
        ctx.log.info("installing the update")
        ;(await getDriver()).quitAndInstall()
        return state()
      })

      if (unsupported) {
        ctx.log.info(`updates disabled: ${unsupported}`)
        return
      }

      // A new channel starts over; turning automatic download on picks up an update that waits.
      channel.onChange(() => {
        if (status === "available" || status === "idle" || status === "error") {
          release = null
          status = "idle"
          void check()
        }
      })
      autoDownload.onChange((on) => {
        if (on && status === "available") startDownload()
      })
      autoCheck.onChange((on) => {
        if (on && (status === "idle" || status === "error")) void check()
      })

      let initial: NodeJS.Timeout | undefined
      let periodic: NodeJS.Timeout | undefined
      const automaticCheck = () => {
        if (autoCheck.get()) void check()
      }
      ctx.onReady(() => {
        initial = setTimeout(automaticCheck, initialDelayMs)
        periodic = setInterval(automaticCheck, intervalMs)
        initial.unref()
        periodic.unref()
      })
      ctx.onBeforeQuit(() => {
        clearTimeout(initial)
        clearInterval(periodic)
      })
    },
  })
}

export default createUpdater()
