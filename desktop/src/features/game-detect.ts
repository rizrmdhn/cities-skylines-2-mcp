/**
 * Game detection: tells whether Cities: Skylines II is running, so the companion can sit in the
 * tray and come forward when the game starts (and go away again when it exits).
 *
 * Two cheap signals, no native module:
 *   process  `tasklist /FI "IMAGENAME eq Cities2.exe" /FO CSV /NH` (execFile, windowsHide, 5 s timeout).
 *            The output is parsed as CSV rows whose first column is the image name, never by the
 *            "no tasks" message, which Windows localizes.
 *   bridge   GET /ping through ctx.bridge. Anything the bridge answers (even 401) counts as reachable.
 *
 * state:  not-running  no process, bridge silent
 *         starting     process up, bridge not answering (yet)
 *         running      process up, bridge answers
 *         bridge-only  bridge answers but the process was not found (another exe name, or a bridge
 *                      URL that points to another machine): the bridge is trusted
 *         unknown      enabled, first check pending       disabled / unsupported  nothing is checked
 *
 * The game is "up" (`active`) when its process is found or the bridge answers. Actions run on the
 * transition inactive -> active (start) and active -> inactive (exit). The first observation after
 * the companion started only sets the baseline: no action, so opening the companion while the game
 * already runs does not hide it, and a login start never "reacts" to a game that was already there.
 * An exit needs EXIT_CONFIRMATIONS consecutive inactive checks (a bridge that times out for a
 * moment while a save loads must not look like an exit).
 *
 * Interval: gameDetect.intervalSeconds (default 10). While the main window is visible and the game
 * is `running` the page already polls the bridge, so checks are slowed to SLOW_FACTOR x the interval.
 * Checks never overlap, and a failing tasklist keeps the last known process answer (reported as
 * processError) instead of flapping the state.
 *
 * Other features: getGameState() is the last result (no I/O), onGameStateChange(listener) is called on
 * every change of `state`.
 */
import { execFile } from "node:child_process"
import { join } from "node:path"

import { z } from "zod"

import { BridgeError } from "../bridge.ts"
import { defineFeature, type DesktopContext } from "../context.ts"
import type { Unsubscribe } from "../settings.ts"

declare module "../settings.ts" {
  interface SettingValues {
    "gameDetect.enabled": boolean
    "gameDetect.intervalSeconds": number
    "gameDetect.processName": string | null
    "gameDetect.showWindowOnStart": boolean
    "gameDetect.showOverlayOnStart": boolean
    "gameDetect.onExit": GameExitAction
  }
}

export type GameState = "unknown" | "not-running" | "starting" | "running" | "bridge-only" | "disabled" | "unsupported"
export type GameExitAction = "nothing" | "hide" | "quit"

export const DEFAULT_PROCESS_NAME = "Cities2.exe"
export const DEFAULT_INTERVAL_SECONDS = 10
/** While the window is open and the game runs, check this many times less often. */
export const SLOW_FACTOR = 3
/** Inactive checks in a row before the game counts as exited. */
export const EXIT_CONFIRMATIONS = 2
const TASKLIST_TIMEOUT_MS = 5_000
const PROCESS_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}\.exe$/i

// ---------------------------------------------------------------------------------------------
// Process detection
// ---------------------------------------------------------------------------------------------

/** True when the process is running; throws when it could not be determined. */
export type ProcessProbe = (imageName: string) => Promise<boolean>

/** Whether `/FO CSV /NH` output lists `imageName` (first column, case-insensitive). */
export function parseTasklist(output: string, imageName: string): boolean {
  const wanted = imageName.toLowerCase()
  for (const line of output.split(/\r?\n/)) {
    // "Cities2.exe","12345","Console","1","1,234,567 K"
    const match = /^"([^"]*)"/.exec(line.trim())
    if (match && match[1]!.toLowerCase() === wanted) return true
  }
  return false
}

export const tasklistProbe: ProcessProbe = (imageName) =>
  new Promise((resolve, reject) => {
    // The full path: a tasklist.exe earlier on PATH (or in the working directory) must not win.
    const tasklist = join(process.env.SystemRoot || "C:\\Windows", "System32", "tasklist.exe")
    execFile(
      tasklist,
      ["/FI", `IMAGENAME eq ${imageName}`, "/FO", "CSV", "/NH"],
      { windowsHide: true, timeout: TASKLIST_TIMEOUT_MS, maxBuffer: 1024 * 1024, encoding: "utf8" },
      (err, stdout) => {
        if (err) reject(err)
        else resolve(parseTasklist(stdout, imageName))
      }
    )
  })

/** The game's process and the bridge together. */
export function deriveState(processFound: boolean, bridgeReachable: boolean): "not-running" | "starting" | "running" | "bridge-only" {
  if (processFound) return bridgeReachable ? "running" : "starting"
  return bridgeReachable ? "bridge-only" : "not-running"
}

/** Delay until the next check. */
export function nextCheckDelayMs(intervalSeconds: number, state: GameState, windowVisible: boolean) {
  const base = intervalSeconds * 1000
  return windowVisible && state === "running" ? base * SLOW_FACTOR : base
}

// ---------------------------------------------------------------------------------------------
// State shared with other features
// ---------------------------------------------------------------------------------------------

/** GET /api/desktop/game-detect */
export interface GameDetectStatus {
  /** false outside Windows: nothing is checked. */
  supported: boolean
  enabled: boolean
  state: GameState
  /** The game counts as up: process found or bridge answering. */
  active: boolean
  processName: string
  /** null = not determined yet (or tasklist failed and there is no earlier answer). */
  processFound: boolean | null
  /** null = not checked yet. */
  bridgeReachable: boolean | null
  /** Epoch ms of the last change of `state`; null before the first check. */
  lastChange: number | null
  lastCheck: number | null
  /** Epoch ms of the next scheduled check; null when idle. */
  nextCheckAt: number | null
  /** Why the process could not be determined at the last check. */
  processError: string | null
}

const IDLE_STATUS: GameDetectStatus = {
  supported: false,
  enabled: false,
  state: "unknown",
  active: false,
  processName: DEFAULT_PROCESS_NAME,
  processFound: null,
  bridgeReachable: null,
  lastChange: null,
  lastCheck: null,
  nextCheckAt: null,
  processError: null,
}

let current: GameDetectStatus = IDLE_STATUS
const listeners = new Set<(status: GameDetectStatus, previous: GameState) => void>()

/** The last known game state, without any I/O. Before the feature started: `{ state: "unknown", supported: false, … }`. */
export function getGameState(): GameDetectStatus {
  return current
}

/** Called after every change of `state` (not on every check). Returns the unsubscribe function. */
export function onGameStateChange(listener: (status: GameDetectStatus, previous: GameState) => void): Unsubscribe {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

// ---------------------------------------------------------------------------------------------
// The feature
// ---------------------------------------------------------------------------------------------

export function createGameDetect(probeProcess: ProcessProbe = tasklistProbe): ReturnType<typeof defineFeature> {
  return defineFeature({
    id: "game-detect",
    setup(ctx: DesktopContext) {
      const supported = ctx.platform === "win32"
      const enabled = ctx.settings.define("gameDetect.enabled", { schema: z.boolean(), default: true })
      const intervalSeconds = ctx.settings.define("gameDetect.intervalSeconds", {
        schema: z.number().int().min(2).max(300),
        default: DEFAULT_INTERVAL_SECONDS,
      })
      const processName = ctx.settings.define("gameDetect.processName", {
        schema: z
          .string()
          .regex(PROCESS_NAME_PATTERN, "must be an executable file name such as Cities2.exe")
          .nullable(),
        default: null,
      })
      const showWindowOnStart = ctx.settings.define("gameDetect.showWindowOnStart", { schema: z.boolean(), default: false })
      const showOverlayOnStart = ctx.settings.define("gameDetect.showOverlayOnStart", { schema: z.boolean(), default: false })
      const onExit = ctx.settings.define("gameDetect.onExit", {
        schema: z.enum(["nothing", "hide", "quit"]),
        default: "nothing",
      })

      const imageName = () => processName.get() ?? DEFAULT_PROCESS_NAME

      let timer: NodeJS.Timeout | undefined
      let checking = false
      let checkAgain = false
      let stopped = false
      /** Last answers; processFound survives a failed tasklist. */
      let processFound: boolean | null = null
      let bridgeReachable: boolean | null = null
      let processError: string | null = null
      let state: GameState = supported ? "unknown" : "unsupported"
      let lastChange: number | null = null
      let lastCheck: number | null = null
      let nextCheckAt: number | null = null
      let inactiveChecks = 0
      /** Whether the game counts as up for the actions: null until the first observation (the baseline), flips to false only after EXIT_CONFIRMATIONS inactive checks. */
      let confirmedActive: boolean | null = null

      function publish(previous: GameState) {
        current = {
          supported,
          enabled: enabled.get(),
          state,
          active: state === "starting" || state === "running" || state === "bridge-only",
          processName: imageName(),
          processFound,
          bridgeReachable,
          lastChange,
          lastCheck,
          nextCheckAt,
          processError,
        }
        if (previous !== state) {
          for (const listener of [...listeners]) {
            try {
              listener(current, previous)
            } catch (err) {
              ctx.log.warn("a game state listener failed", err)
            }
          }
        }
      }

      // --- probes -----------------------------------------------------------------------------

      async function pingBridge(): Promise<boolean> {
        try {
          await ctx.bridge.get("/ping")
          return true
        } catch (err) {
          if (!(err instanceof BridgeError)) throw err
          // The bridge answered with an error (401 without a token, 5xx): the game is there.
          return err.kind === "bridge"
        }
      }

      async function checkProcess(): Promise<void> {
        try {
          processFound = await probeProcess(imageName())
          processError = null
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          if (processError === null) ctx.log.warn(`could not look for ${imageName()}: ${message}`)
          processError = message
        }
      }

      // --- actions ----------------------------------------------------------------------------

      /** Calls another feature's route in-process (null when it is not there or refuses). */
      async function callRoute<T>(method: "GET" | "POST", path: string): Promise<T | null> {
        if (!ctx.routes.list().some((route) => route.method === method && route.path === path)) return null
        const response = await ctx.routes.dispatch({
          method,
          pathname: `/api${path}`,
          searchParams: new URLSearchParams(),
          bodyText: "",
        })
        if (response.status < 200 || response.status >= 300) {
          ctx.log.info(`${method} ${path} answered ${response.status}`)
          return null
        }
        return JSON.parse(response.body) as T
      }

      /** Brings the main window forward without taking the keyboard focus from the game when it exists. */
      function showWindow() {
        const win = ctx.getMainWindow()
        if (!win) {
          ctx.showMainWindow() // a new window is focused; there is no softer way to create it
        } else if (win.isMinimized()) {
          win.restore()
        } else if (!win.isVisible()) {
          win.showInactive()
        }
      }

      async function hideToTray() {
        const tray = await callRoute<{ present?: boolean }>("GET", "/desktop/tray")
        if (!tray?.present) {
          ctx.log.info("the game exited, but there is no tray icon to hide to: window left as it is")
          return
        }
        ctx.getMainWindow()?.hide()
        await callRoute("POST", "/desktop/overlay/hide")
      }

      async function onGameStarted() {
        ctx.log.info("game started")
        if (showWindowOnStart.get()) showWindow()
        if (showOverlayOnStart.get()) await callRoute("POST", "/desktop/overlay/show")
      }

      async function onGameExited() {
        const action = onExit.get()
        ctx.log.info(`game exited (action: ${action})`)
        if (action === "hide") await hideToTray()
        else if (action === "quit") ctx.quit()
      }

      function transition(active: boolean) {
        if (confirmedActive === null) {
          confirmedActive = active // baseline
          return
        }
        if (active === confirmedActive) return
        confirmedActive = active
        void (active ? onGameStarted() : onGameExited()).catch((err: unknown) =>
          ctx.log.warn(`the ${active ? "start" : "exit"} action failed`, err)
        )
      }

      // --- the check --------------------------------------------------------------------------

      async function check() {
        if (checking) {
          checkAgain = true
          return
        }
        checking = true
        try {
          const [, reachable] = await Promise.all([checkProcess(), pingBridge()])
          if (stopped || !enabled.get()) return
          bridgeReachable = reachable
          lastCheck = Date.now()
          const previous = state
          state = deriveState(processFound ?? false, reachable)
          if (previous !== state) {
            lastChange = lastCheck
            ctx.log.info(`game ${state}${state === "bridge-only" ? " (bridge answers, no process found)" : ""}`)
          }
          const active = state !== "not-running"
          if (active) {
            inactiveChecks = 0
            transition(true)
          } else if (++inactiveChecks >= EXIT_CONFIRMATIONS || confirmedActive === null) {
            transition(false)
          }
          publish(previous)
        } catch (err) {
          ctx.log.warn("game check failed", err)
        } finally {
          checking = false
          if (checkAgain) {
            checkAgain = false
            checkNow()
          } else {
            schedule()
          }
        }
      }

      function schedule() {
        clearTimeout(timer)
        timer = undefined
        nextCheckAt = null
        if (stopped || !supported || !enabled.get()) return
        const win = ctx.getMainWindow()
        const visible = win !== null && !win.isDestroyed() && win.isVisible() && !win.isMinimized()
        const delay = nextCheckDelayMs(intervalSeconds.get(), state, visible)
        nextCheckAt = Date.now() + delay
        timer = setTimeout(() => void check(), delay)
        current = { ...current, nextCheckAt }
      }

      function checkNow() {
        clearTimeout(timer)
        timer = undefined
        void check()
      }

      function start() {
        if (!supported) return
        if (enabled.get()) {
          checkNow()
          return
        }
        clearTimeout(timer)
        timer = undefined
        const previous = state
        state = "disabled"
        nextCheckAt = null
        confirmedActive = null
        inactiveChecks = 0
        if (previous !== "disabled") lastChange = Date.now()
        publish(previous)
      }

      enabled.onChange(() => {
        if (enabled.get()) state = "unknown"
        start()
      })
      intervalSeconds.onChange(() => schedule())
      processName.onChange(() => {
        processFound = null
        processError = null
        if (enabled.get()) checkNow()
      })

      // --- routes and lifecycle ---------------------------------------------------------------

      ctx.routes.get("/desktop/game-detect", () => ({ ...current, supported, enabled: enabled.get(), processName: imageName() }))

      ctx.onReady(() => {
        publish("unknown")
        start()
      })

      ctx.onBeforeQuit(() => {
        stopped = true
        clearTimeout(timer)
        listeners.clear()
        current = IDLE_STATUS
      })
    },
  })
}

export default createGameDetect()
