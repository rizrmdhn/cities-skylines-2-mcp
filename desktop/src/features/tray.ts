/**
 * System tray icon with live connection status, a small control menu and close-to-tray.
 *
 *   - Icon + tooltip: connected (green dot) / no city or game busy (amber) / offline (grey + red),
 *     with the city name. Polled with GET /ping and GET /state (both cheap), slower while the
 *     bridge is down (5 s doubling to 60 s).
 *   - Menu: Open companion, status line, Pause / Resume, Speed 1x 2x 4x 8x, "Start with Windows"
 *     (only when another feature defines the boolean setting START_WITH_WINDOWS_KEY), Quit.
 *     Pause and speed go through ctx.bridge.control, i.e. the proxy core's control allowlist
 *     (never a raw fetch); they are disabled while the bridge is read-only or no city is loaded.
 *   - Close to tray (setting tray.closeToTray, default on): closing the main window hides it and
 *     the app keeps running; the first time, a balloon explains where it went.
 *   - Other features can add menu items with contributeToTrayMenu() (the overlay's "Show overlay").
 *   - Left click toggles the window, double click opens it.
 *   - Works when the app was launched with --hidden (no main window exists yet): the tray is
 *     created in onReady either way and "Open" creates the window.
 *
 *   GET /api/desktop/tray   { present, closeToTray, status: TraySnapshot, controls: boolean }
 *
 * The Electron parts (Tray, Menu, nativeImage) are behind TrayView so the logic stays Node-testable.
 */
import { join } from "node:path"

import type { MenuItemConstructorOptions, NativeImage } from "electron"
import { z } from "zod"

import { BridgeError, type BridgeClient } from "../bridge.ts"
import { defineFeature, type DesktopContext, type DesktopFeature } from "../context.ts"

declare module "../settings.ts" {
  interface SettingValues {
    "tray.closeToTray": boolean
    "tray.hintShown": boolean
  }
}

/**
 * The boolean setting a start-with-Windows feature defines. The tray shows its checkbox only when
 * this key exists (checked at every menu build, so feature order does not matter).
 */
export const START_WITH_WINDOWS_KEY = "startup.openAtLogin"

/** Which icon file is shown: tray-<status>.png (+ @1.5x / @2x) under assets/. */
export type TrayIcon = "connected" | "no-city" | "offline"

/** The state of the bridge as the tray sees it (same vocabulary as web/src/lib/connection.ts). */
export type TrayState = "checking" | "unreachable" | "unauthorized" | "disabled" | "loading" | "no-city" | "ready"

export interface TraySnapshot {
  state: TrayState
  city: string | null
  readOnly: boolean
  /** Simulation state; null unless a city is loaded. */
  paused: boolean | null
  speed: number | null
  forcedPause: string | null
  error: string | null
  /** ms since epoch of the last probe; null before the first one. */
  checkedAt: number | null
}

interface Ping {
  bridgeEnabled: boolean
  isLoading: boolean
  readOnly: boolean
}

interface GameState {
  isLoading: boolean
  cityLoaded: boolean
  cityName: string | null
  simulation: { paused: boolean; selectedSpeed: number; forcedPause: string | null } | null
}

export const INITIAL_SNAPSHOT: TraySnapshot = {
  state: "checking",
  city: null,
  readOnly: false,
  paused: null,
  speed: null,
  forcedPause: null,
  error: null,
  checkedAt: null,
}

/** Speeds offered in the menu; the bridge accepts 0..8 (web/server/routes.ts). */
export const MENU_SPEEDS = [1, 2, 4, 8] as const

// ---------------------------------------------------------------------------------------------
// Probing
// ---------------------------------------------------------------------------------------------

function failure(state: "unreachable" | "unauthorized", err: unknown, base: Partial<TraySnapshot> = {}): TraySnapshot {
  return {
    ...INITIAL_SNAPSHOT,
    ...base,
    state,
    error: err instanceof Error ? err.message : String(err),
    checkedAt: Date.now(),
  }
}

/** One look at the bridge: /ping first (answers even while loading), /state once it is up. Never throws a BridgeError. */
export async function probeBridge(bridge: BridgeClient): Promise<TraySnapshot> {
  let ping: Ping
  try {
    ping = await bridge.get<Ping>("/ping")
  } catch (err) {
    if (!(err instanceof BridgeError)) throw err
    return failure(err.status === 401 ? "unauthorized" : "unreachable", err)
  }
  const base = { readOnly: ping.readOnly === true, checkedAt: Date.now() }
  if (!ping.bridgeEnabled) return { ...INITIAL_SNAPSHOT, ...base, state: "disabled" }
  if (ping.isLoading) return { ...INITIAL_SNAPSHOT, ...base, state: "loading" }

  let state: GameState
  try {
    state = await bridge.get<GameState>("/state")
  } catch (err) {
    if (!(err instanceof BridgeError)) throw err
    return failure(err.status === 401 ? "unauthorized" : "unreachable", err, { readOnly: base.readOnly })
  }
  if (state.isLoading) return { ...INITIAL_SNAPSHOT, ...base, state: "loading" }
  if (!state.cityLoaded) return { ...INITIAL_SNAPSHOT, ...base, state: "no-city" }
  const simulation = state.simulation
  return {
    ...INITIAL_SNAPSHOT,
    ...base,
    state: "ready",
    city: state.cityName,
    paused: simulation?.paused ?? null,
    speed: simulation?.selectedSpeed ?? null,
    forcedPause: simulation?.forcedPause ?? null,
  }
}

/** Delay before the next probe: relaxed while connected, backing off while the bridge is down. */
export function nextDelayMs(state: TrayState, consecutiveFailures: number) {
  if (state === "unreachable" || state === "unauthorized") {
    return Math.min(60_000, 5_000 * 2 ** Math.max(0, Math.min(consecutiveFailures, 6) - 1))
  }
  return state === "ready" ? 5_000 : 10_000
}

// ---------------------------------------------------------------------------------------------
// Presentation
// ---------------------------------------------------------------------------------------------

export function iconFor(state: TrayState): TrayIcon {
  if (state === "ready") return "connected"
  return state === "no-city" || state === "loading" || state === "disabled" ? "no-city" : "offline"
}

export function formatSpeed(speed: number) {
  return `${Number(speed.toFixed(2))}×`
}

function shortCity(city: string | null, max = 48) {
  const name = (city ?? "").replace(/\s+/g, " ").trim()
  return name.length > max ? `${name.slice(0, max - 1)}…` : name || "Unnamed city"
}

/** Text of the (disabled) status line of the menu. */
export function statusLine(s: TraySnapshot): string {
  switch (s.state) {
    case "ready": {
      const run = s.paused ? "Paused" : s.speed !== null ? `${formatSpeed(s.speed)} speed` : "Running"
      return `${shortCity(s.city)} — ${run}${s.readOnly ? " (read-only)" : ""}`
    }
    case "no-city":
      return "Connected — no city loaded"
    case "loading":
      return "Connected — the game is loading"
    case "disabled":
      return "Bridge is turned off in the game"
    case "unauthorized":
      return "The bridge rejected the token"
    case "unreachable":
      return "Not connected to the game"
    default:
      return "Checking the connection…"
  }
}

/** Tooltip; Windows cuts it at 127 characters. */
export function tooltipFor(s: TraySnapshot): string {
  const head = "CS2MCP Companion"
  const text =
    s.state === "ready"
      ? `${head}\n${shortCity(s.city, 40)} — ${s.paused ? "paused" : s.speed !== null ? formatSpeed(s.speed) : "connected"}`
      : `${head}\n${statusLine(s)}`
  return text.length > 127 ? `${text.slice(0, 126)}…` : text
}

/** Pause, resume and speed work only on a loaded city and a bridge that is not read-only. */
export function canControl(s: TraySnapshot) {
  return s.state === "ready" && !s.readOnly && s.paused !== null && s.speed !== null
}

export interface MenuActions {
  open(): void
  togglePause(): void
  setSpeed(speed: number): void
  setStartWithWindows(enabled: boolean): void
  quit(): void
}

export interface MenuModel {
  /** Items other features contributed (see contributeToTrayMenu); shown below Speed. */
  extra?: MenuItemConstructorOptions[]
  snapshot: TraySnapshot
  /** The speed "Resume" returns to. */
  resumeSpeed: number
  /** null = no feature exposes it: the item is omitted. */
  startWithWindows: boolean | null
}

export function buildMenu({ snapshot, resumeSpeed, startWithWindows, extra = [] }: MenuModel, actions: MenuActions): MenuItemConstructorOptions[] {
  const control = canControl(snapshot)
  const paused = snapshot.paused === true
  const items: MenuItemConstructorOptions[] = [
    { label: "Open companion", click: actions.open },
    { type: "separator" },
    { label: statusLine(snapshot), enabled: false },
    {
      label: paused ? `Resume at ${formatSpeed(resumeSpeed)}` : "Pause",
      enabled: control,
      click: actions.togglePause,
    },
    {
      label: "Speed",
      enabled: control,
      submenu: MENU_SPEEDS.map((speed) => ({
        label: formatSpeed(speed),
        type: "radio" as const,
        checked: !paused && snapshot.speed !== null && Math.abs(snapshot.speed - speed) < 0.01,
        click: () => actions.setSpeed(speed),
      })),
    },
  ]
  if (extra.length > 0) items.push({ type: "separator" }, ...extra)
  if (startWithWindows !== null) {
    items.push(
      { type: "separator" },
      {
        label: "Start with Windows",
        type: "checkbox",
        checked: startWithWindows,
        click: (item) => actions.setStartWithWindows(item.checked),
      }
    )
  }
  items.push({ type: "separator" }, { label: "Quit", click: actions.quit })
  return items
}

// ---------------------------------------------------------------------------------------------
// Menu items from other features
// ---------------------------------------------------------------------------------------------

/** Builds the items a feature wants in the tray menu; called at every menu build, so read live state in it. */
export type TrayMenuContribution = () => MenuItemConstructorOptions[]

const contributions = new Set<TrayMenuContribution>()
let refreshMenu: (() => void) | null = null

/**
 * Adds items to the tray menu (below Speed, above Start with Windows), e.g. the overlay's
 * "Show overlay". Works whatever the feature order: the menu is rebuilt when a contribution is
 * added. Call refreshTrayMenu() when the items would change (a label, a checkbox); the menu is
 * only rebuilt when their labels/state differ. Returns the function that removes them again.
 */
export function contributeToTrayMenu(items: TrayMenuContribution): () => void {
  contributions.add(items)
  refreshMenu?.()
  return () => {
    contributions.delete(items)
    refreshMenu?.()
  }
}

/** Rebuilds the tray menu now if the contributed items changed. No-op without a tray. */
export function refreshTrayMenu() {
  refreshMenu?.()
}

// ---------------------------------------------------------------------------------------------
// Electron adapter
// ---------------------------------------------------------------------------------------------

export interface TrayHandlers {
  onClick(): void
  onDoubleClick(): void
}

/** What the feature needs from the OS tray. */
export interface TrayView {
  show(icon: TrayIcon, tooltip: string): void
  setMenu(template: MenuItemConstructorOptions[]): void
  balloon(title: string, content: string): void
  destroy(): void
}

export type TrayViewFactory = (ctx: DesktopContext, handlers: TrayHandlers) => Promise<TrayView>

export const createElectronTray: TrayViewFactory = async (ctx, handlers) => {
  const { Menu, Tray, nativeImage } = await import("electron")
  const images = new Map<TrayIcon, NativeImage>()
  const image = (icon: TrayIcon) => {
    let loaded = images.get(icon)
    if (!loaded) {
      // tray-<icon>.png, tray-<icon>@1.5x.png, tray-<icon>@2x.png: Electron picks by display scale.
      loaded = nativeImage.createFromPath(join(ctx.paths.assets, `tray-${icon}.png`))
      if (loaded.isEmpty()) loaded = nativeImage.createFromPath(ctx.paths.icon)
      images.set(icon, loaded)
    }
    return loaded
  }
  const tray = new Tray(image("offline"))
  tray.on("click", handlers.onClick)
  tray.on("double-click", handlers.onDoubleClick)
  return {
    show(icon, tooltip) {
      tray.setImage(image(icon))
      tray.setToolTip(tooltip)
    },
    setMenu: (template) => tray.setContextMenu(Menu.buildFromTemplate(template)),
    balloon(title, content) {
      // Windows only; elsewhere there is no balloon API and the hint is simply skipped.
      if (process.platform === "win32") tray.displayBalloon({ iconType: "info", title, content })
    },
    destroy: () => tray.destroy(),
  }
}

// ---------------------------------------------------------------------------------------------
// The feature
// ---------------------------------------------------------------------------------------------

/** Two clicks of a double click arrive as click, click, double-click: wait this long before toggling. */
const CLICK_SETTLE_MS = 300

const HINT_TITLE = "CS2MCP Companion is still running"
const HINT_TEXT =
  "Closing the window keeps the app in the system tray. Click the tray icon to open it again, or choose Quit from its menu to exit. You can change this under Settings."

export function createTray(createView: TrayViewFactory = createElectronTray): DesktopFeature {
  return defineFeature({
    id: "tray",
    setup(ctx) {
      const closeToTray = ctx.settings.define("tray.closeToTray", { schema: z.boolean(), default: true })
      const hintShown = ctx.settings.define("tray.hintShown", { schema: z.boolean(), default: false, expose: false })

      let view: TrayView | null = null
      let snapshot = INITIAL_SNAPSHOT
      let resumeSpeed = 1
      let failures = 0
      let shownKey = ""
      let timer: NodeJS.Timeout | undefined
      let clickTimer: NodeJS.Timeout | undefined
      let polling = false
      let pollAgain = false
      let stopped = false
      let sessionEnding = false

      // --- window behaviour -------------------------------------------------------------------

      function toggleWindow() {
        const win = ctx.getMainWindow()
        if (win && win.isVisible() && !win.isMinimized()) win.hide()
        else ctx.showMainWindow()
      }

      function announceOnce() {
        if (hintShown.get() || !view) return
        view.balloon(HINT_TITLE, HINT_TEXT)
        hintShown.set(true).catch((err: unknown) => ctx.log.warn("could not remember the tray hint", err))
      }

      ctx.onMainWindowCreated((win) => {
        win.on("session-end", () => {
          sessionEnding = true
        })
        win.on("close", (event) => {
          if (ctx.isQuitting() || sessionEnding || !view || !closeToTray.get()) return
          event.preventDefault()
          win.hide()
          announceOnce()
        })
      })
      // Hiding is not closing, so this only matters when a window really goes away (a crashed
      // renderer, or close-to-tray turned off): keep running only while a tray icon exists to come back from.
      ctx.onWindowAllClosed(() => (view && closeToTray.get() ? "keep-running" : "quit"))

      // --- menu and tray ----------------------------------------------------------------------

      function startWithWindows(): boolean | null {
        if (!ctx.settings.isDefined(START_WITH_WINDOWS_KEY)) return null
        const value = ctx.settings.get(START_WITH_WINDOWS_KEY)
        return typeof value === "boolean" ? value : null
      }

      const actions: MenuActions = {
        open: () => void ctx.showMainWindow(),
        togglePause: () =>
          void control(snapshot.paused ? { speed: resumeSpeed } : { paused: true }),
        setSpeed: (speed) => void control({ speed }),
        setStartWithWindows: (enabled) =>
          void ctx.settings
            .set(START_WITH_WINDOWS_KEY, enabled)
            .catch((err: unknown) => ctx.log.warn("could not change start with Windows", err)),
        quit: () => ctx.quit(),
      }

      function contributedItems(): MenuItemConstructorOptions[] {
        const items: MenuItemConstructorOptions[] = []
        for (const contribution of contributions) {
          try {
            items.push(...contribution())
          } catch (err) {
            ctx.log.warn("a tray menu contribution failed", err)
          }
        }
        return items
      }

      function render(force = false) {
        if (!view) return
        const startup = startWithWindows()
        const extra = contributedItems()
        // Functions (click handlers) drop out of the JSON: the key covers labels and state only.
        const key = JSON.stringify([snapshot.state, snapshot.city, snapshot.paused, snapshot.speed, snapshot.readOnly, resumeSpeed, startup, extra])
        if (!force && key === shownKey) return
        shownKey = key
        view.show(iconFor(snapshot.state), tooltipFor(snapshot))
        view.setMenu(buildMenu({ snapshot, resumeSpeed, startWithWindows: startup, extra }, actions))
      }

      // --- control ----------------------------------------------------------------------------

      /** A menu click: one /sim/control call through the proxy core's control allowlist. */
      async function control(change: { speed?: number; paused?: boolean }) {
        if (!canControl(snapshot)) return
        try {
          await ctx.bridge.control("/sim/control", change)
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          ctx.log.warn(`simulation control ${JSON.stringify(change)} failed: ${message}`)
          view?.balloon("Could not change the simulation", message)
        }
        pollNow()
      }

      // --- polling ----------------------------------------------------------------------------

      async function poll() {
        if (polling) {
          pollAgain = true
          return
        }
        polling = true
        try {
          const next = await probeBridge(ctx.bridge)
          if (next.state !== snapshot.state) {
            ctx.log.info(`bridge ${next.state}${next.city ? ` (${next.city})` : ""}${next.error ? `: ${next.error}` : ""}`)
          }
          failures = next.state === "unreachable" || next.state === "unauthorized" ? failures + 1 : 0
          snapshot = next
          if (next.state === "ready" && next.paused === false && next.speed !== null && next.speed > 0) {
            resumeSpeed = next.speed
          }
          render()
        } catch (err) {
          ctx.log.error("tray poll failed", err)
        } finally {
          polling = false
        }
        if (stopped) return
        clearTimeout(timer)
        timer = setTimeout(() => void poll(), pollAgain ? 0 : nextDelayMs(snapshot.state, failures))
        pollAgain = false
      }

      function pollNow() {
        clearTimeout(timer)
        void poll()
      }

      // --- routes and lifecycle ---------------------------------------------------------------

      ctx.routes.get("/desktop/tray", () => ({
        present: view !== null,
        closeToTray: closeToTray.get(),
        status: snapshot,
        controls: canControl(snapshot),
      }))

      ctx.onReady(async () => {
        try {
          view = await createView(ctx, {
            onClick() {
              clearTimeout(clickTimer)
              clickTimer = setTimeout(toggleWindow, CLICK_SETTLE_MS)
            },
            onDoubleClick() {
              clearTimeout(clickTimer)
              ctx.showMainWindow()
            },
          })
        } catch (err) {
          // No tray (e.g. a shell without a notification area): closing the window quits, as without this feature.
          ctx.log.error("could not create the tray icon; close-to-tray is off", err)
          return
        }
        refreshMenu = () => render()
        render(true)
        // The start-with-Windows feature may define its key after us, so subscribe once everything is set up.
        ctx.settings.onChange(START_WITH_WINDOWS_KEY, () => render(true))
        // A new bridge URL or token should show up at once, not after the next probe.
        ctx.settings.onChange("bridgeUrl", pollNow)
        ctx.settings.onChange("token", pollNow)
        void poll()
      })

      ctx.onBeforeQuit(() => {
        stopped = true
        refreshMenu = null
        clearTimeout(timer)
        clearTimeout(clickTimer)
        view?.destroy()
        view = null
      })
    },
  })
}

export default createTray()
