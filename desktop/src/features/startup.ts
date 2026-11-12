/**
 * Start with Windows: registers the packaged app as a login item (HKCU\...\Run) so the companion
 * can sit in the tray from the moment the user logs in.
 *
 *   startup.openAtLogin   boolean, default false. The tray's "Start with Windows" checkbox appears
 *                         because this exact key is defined (see tray.ts, START_WITH_WINDOWS_KEY).
 *                         A change is applied by app.setLoginItemSettings in the onChange listener.
 *   startup.startHidden   boolean, default true: the login item passes --hidden, so the app starts
 *                         in the tray without a window (ctx.launch.hidden).
 *
 * Only a packaged app on Windows can do this (`supported`). In a development run the login item
 * would start a bare electron.exe, so there the schema refuses `true` (the tray click and the
 * settings page get that message) and nothing is ever written to the registry.
 *
 * Path and updates: the login item points at process.execPath. The NSIS per-user installer puts
 * the app in %LOCALAPPDATA%\Programs\CS2MCP Companion\ and updates replace the files in that
 * folder, so the path (and with it the Run entry) survives updates. The entry is re-written at
 * every start when its arguments differ from what the settings ask for. If the app was reinstalled
 * to another folder, the old entry points at the old exe: this exe finds no entry of its own and
 * the setting reads as off until the user turns it on again, which overwrites the old entry (same
 * registry value name, the AppUserModelID).
 *
 * Reconciling: the user can switch the entry off in Task Manager > Startup apps (the Run value
 * stays, the StartupApproved flag flips) or something may delete it. At start the stored setting
 * is compared with the real state and the setting follows the system (see `reconcile`). We never
 * re-enable an entry the user disabled in Windows.
 */
import { isAbsolute, normalize } from "node:path"

import { z } from "zod"

import { defineFeature, type DesktopContext } from "../context.ts"

declare module "../settings.ts" {
  interface SettingValues {
    "startup.openAtLogin": boolean
    "startup.startHidden": boolean
  }
}

export const OPEN_AT_LOGIN_KEY = "startup.openAtLogin"
export const START_HIDDEN_ARG = "--hidden"

/** One Run-key entry as Electron reports it (app.getLoginItemSettings().launchItems, Windows). */
export interface LaunchItem {
  name: string
  path: string
  args: string[]
  scope: string
  enabled: boolean
}

/** The part of app.getLoginItemSettings() this feature reads. */
export interface LoginItemState {
  /** An entry for this exe with exactly the queried arguments exists. */
  openAtLogin: boolean
  /** An entry for this exe (any arguments) exists and is not disabled in Task Manager. */
  executableWillLaunchAtLogin: boolean
  launchItems: LaunchItem[]
}

/** The Electron side, injectable. */
export interface LoginItems {
  get(query: { path: string; args: string[] }): LoginItemState
  set(change: { openAtLogin: boolean; path: string; args: string[] }): void
}

export type LoginItemsFactory = () => Promise<LoginItems>

export const createElectronLoginItems: LoginItemsFactory = async () => {
  const { app } = await import("electron")
  return {
    get: (query) => {
      const state = app.getLoginItemSettings(query)
      return {
        openAtLogin: state.openAtLogin,
        executableWillLaunchAtLogin: state.executableWillLaunchAtLogin,
        launchItems: state.launchItems ?? [],
      }
    },
    // `enabled` is left at its default (true): turning the setting on again also clears a
    // Task Manager "Disabled" flag, which is what the user asked for by clicking the switch.
    set: ({ openAtLogin, path, args }) => app.setLoginItemSettings({ openAtLogin, path, args }),
  }
}

/** What Windows says about this exe's login item. */
export type SystemState =
  | "enabled"
  /** Registered and approved, but with other arguments than the settings ask for. */
  | "other-arguments"
  /** Registered, but switched off in Task Manager > Startup apps (or Windows Settings). */
  | "disabled-in-windows"
  | "not-registered"

function samePath(a: string, b: string) {
  const clean = (value: string) => normalize(value.replace(/^"|"$/g, "")).toLowerCase()
  return clean(a) === clean(b)
}

export function classifyLoginItem(state: LoginItemState, exePath: string): SystemState {
  if (state.openAtLogin && state.executableWillLaunchAtLogin) return "enabled"
  if (state.executableWillLaunchAtLogin) return "other-arguments"
  const own = state.launchItems.some((item) => samePath(item.path, exePath))
  return state.openAtLogin || own ? "disabled-in-windows" : "not-registered"
}

/** GET /api/desktop/startup */
export interface StartupStatus {
  /** false in a development run and outside Windows; the switch is shown disabled with `reason`. */
  supported: boolean
  reason: string | null
  /** The stored setting. */
  openAtLogin: boolean
  startHidden: boolean
  /** What Windows says now; null when not supported. */
  system: SystemState | null
  /** The exe and arguments the login item runs; null when not supported. */
  executablePath: string | null
  arguments: string[]
  /** This run was started by the login item (or any --hidden launch). */
  startedHidden: boolean
  /** The outcome of the check made at start. */
  reconciled: { at: number; outcome: string } | null
  /** The last error from changing the login item, if any. */
  error: string | null
}

export function createStartup(createLoginItems: LoginItemsFactory = createElectronLoginItems): ReturnType<typeof defineFeature> {
  return defineFeature({
    id: "startup",
    setup(ctx: DesktopContext) {
      const platformOk = ctx.platform === "win32"
      const supported = platformOk && ctx.isPackaged
      const reason = !platformOk
        ? "Start with Windows is only available on Windows."
        : !ctx.isPackaged
          ? "Start with Windows is only available in the installed app: in a development run it would start a bare Electron."
          : null

      const openAtLogin = ctx.settings.define(OPEN_AT_LOGIN_KEY, {
        // In a development run `true` is refused, so the tray checkbox and the settings page can
        // never write a login item that would launch electron.exe.
        schema: z.boolean().refine((on) => !on || supported, reason ?? "not available"),
        default: false,
      })
      const startHidden = ctx.settings.define("startup.startHidden", { schema: z.boolean(), default: true })

      const exePath = process.execPath
      let items: LoginItems | null = null
      let quiet = false
      let reconciled: StartupStatus["reconciled"] = null
      let lastError: string | null = null

      const loginArgs = () => (startHidden.get() ? [START_HIDDEN_ARG] : [])

      function read(): LoginItemState | null {
        if (!items) return null
        try {
          return items.get({ path: exePath, args: loginArgs() })
        } catch (err) {
          ctx.log.warn("could not read the login item", err)
          return null
        }
      }

      function systemState(): SystemState | null {
        const state = read()
        return state ? classifyLoginItem(state, exePath) : null
      }

      /** Writes (or removes) the login item. Never throws; a failure is kept for the status. */
      function apply(on: boolean): boolean {
        if (!items) return false
        try {
          items.set({ openAtLogin: on, path: exePath, args: on ? loginArgs() : [] })
          lastError = null
          ctx.log.info(on ? `login item set: ${exePath} ${loginArgs().join(" ")}`.trim() : "login item removed")
          return true
        } catch (err) {
          lastError = err instanceof Error ? err.message : String(err)
          ctx.log.warn("could not change the login item", err)
          return false
        }
      }

      /** Changes the stored setting without applying it again (it already matches the system). */
      function followSystem(on: boolean) {
        quiet = true
        let saved: Promise<void>
        try {
          saved = openAtLogin.set(on) // listeners run synchronously
        } finally {
          quiet = false
        }
        saved.catch((err: unknown) => ctx.log.warn("could not save the start with Windows setting", err))
      }

      /**
       * Makes the stored setting agree with Windows (called once at start).
       *   enabled              nothing to do; the stored value follows (on).
       *   other-arguments      an approved entry exists with different arguments: it is on; rewrite it
       *                        with the arguments the settings ask for.
       *   disabled-in-windows  the user switched it off in Task Manager: the setting becomes off. The
       *                        entry is left alone (we never override that choice); turning the
       *                        setting on again re-registers it and clears the flag.
       *   not-registered       no entry for this exe (removed, or the app was moved): the setting becomes off.
       */
      function reconcile() {
        const system = systemState()
        if (system === null) return
        const stored = openAtLogin.get()
        let outcome: string
        switch (system) {
          case "enabled":
            outcome = stored ? "in sync (on)" : "found on in Windows, setting turned on"
            if (!stored) followSystem(true)
            break
          case "other-arguments":
            outcome = "login item had other arguments, rewritten"
            apply(true)
            if (!stored) followSystem(true)
            break
          case "disabled-in-windows":
            outcome = stored ? "turned off in Windows (Startup apps), setting turned off" : "in sync (off)"
            if (stored) followSystem(false)
            break
          case "not-registered":
            outcome = stored ? "no login item found, setting turned off" : "in sync (off)"
            if (stored) followSystem(false)
            break
        }
        reconciled = { at: Date.now(), outcome }
        ctx.log.info(`start with Windows: ${outcome}`)
      }

      openAtLogin.onChange((on) => {
        if (quiet || !supported) return
        // A failed write leaves the setting and the system apart: read the system back.
        if (!apply(on)) reconcile()
      })
      startHidden.onChange(() => {
        if (quiet || !supported || !openAtLogin.get()) return
        if (!apply(true)) reconcile()
      })

      function status(): StartupStatus {
        return {
          supported,
          reason,
          openAtLogin: openAtLogin.get(),
          startHidden: startHidden.get(),
          system: supported ? systemState() : null,
          executablePath: supported ? exePath : null,
          arguments: supported ? loginArgs() : [],
          startedHidden: ctx.launch.hidden,
          reconciled,
          error: lastError,
        }
      }

      ctx.routes.get("/desktop/startup", () => status())

      ctx.onReady(async () => {
        if (!supported || !isAbsolute(exePath)) return
        try {
          items = await createLoginItems()
        } catch (err) {
          ctx.log.error("login items are unavailable", err)
          return
        }
        reconcile()
      })
    },
  })
}

export default createStartup()
