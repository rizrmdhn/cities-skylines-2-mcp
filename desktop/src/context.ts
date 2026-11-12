/**
 * The contract between the core and features. A feature is one file in src/features/ that
 * default-exports defineFeature({ id, setup(ctx) }) and is listed by one line in
 * src/features/index.ts. Everything a feature may touch is on DesktopContext.
 *
 * This module is Electron-free at runtime (type imports only), so features that use nothing but
 * the context can be tested in Node with createTestContext (src/testing.ts).
 */
import type { BrowserWindow, BrowserWindowConstructorOptions, WebPreferences } from "electron"

import type { BridgeClient } from "./bridge.ts"
import type { PublicBridgeConfig } from "./config.ts"
import type { Logger } from "./logger.ts"
import type { RouteRegistry } from "./routes.ts"
import type { SettingsStore, Unsubscribe } from "./settings.ts"

export interface DesktopPaths {
  /** Electron userData: settings.json and logs/ live here. */
  userData: string
  /** Folder of the log files (main.log). */
  logs: string
  /** The built web app served on app://cs2mcp (dist/renderer). */
  renderer: string
  /** Icons and other static files of the desktop app (dist/assets). */
  assets: string
  /** Window/taskbar icon: icon.ico on Windows, icon.png elsewhere. */
  icon: string
}

/** Options for an extra window; webPreferences are fixed by the core (hardened). */
export interface AppWindowOptions extends Omit<BrowserWindowConstructorOptions, "webPreferences"> {
  /** Page of the web app to load, e.g. "/overlay" -> app://cs2mcp/overlay. Default "/". */
  route?: string
  /** The only webPreferences a feature may set. */
  webPreferences?: Pick<WebPreferences, "backgroundThrottling" | "zoomFactor" | "spellcheck">
  /** Show the window once its first paint is ready (default true). */
  showWhenReady?: boolean
}

export type LifecycleHook = () => void | Promise<void>

/** Asked when the last window closed: "keep-running" from any decider keeps the app alive. */
export type WindowAllClosedDecider = () => "quit" | "keep-running"

export interface DesktopContext {
  /** App version (desktop/package.json, kept equal to web/package.json). */
  readonly version: string
  readonly isPackaged: boolean
  readonly platform: NodeJS.Platform
  readonly paths: DesktopPaths
  /** Command line of this launch; `hidden` is true when started with --hidden (e.g. at login). */
  readonly launch: { readonly argv: readonly string[]; readonly hidden: boolean }

  /** Persistent typed settings (settings.ts). */
  readonly settings: SettingsStore
  /** Register GET/POST handlers for /api/desktop/* (routes.ts). */
  readonly routes: RouteRegistry
  /** Allowlisted, read-only bridge access from the main process (bridge.ts). */
  readonly bridge: BridgeClient
  /** Logs to <userData>/logs/main.log; a feature's ctx.log is scoped to its id. */
  readonly log: Logger
  /** The bridge URL and token state in effect now (never the token itself). */
  bridgeConfig(): PublicBridgeConfig

  /** The main window, or null before it is created and after it was closed. */
  getMainWindow(): BrowserWindow | null
  /** Creates the main window if needed, then restores, shows and focuses it. */
  showMainWindow(): BrowserWindow
  /** A new hardened window loading app://cs2mcp<route>. */
  createWindow(options?: AppWindowOptions): BrowserWindow
  /** Called for every main window created from now on (it is recreated after being closed). */
  onMainWindowCreated(listener: (window: BrowserWindow) => void): Unsubscribe

  /** Runs once every feature is set up and the main window exists (unless launched hidden). */
  onReady(hook: LifecycleHook): void
  /** Runs when the app quits; quitting waits for async hooks (5 s at most). */
  onBeforeQuit(hook: LifecycleHook): void
  /**
   * Decides what happens when the last window closes. By default the app quits; a tray feature
   * registers () => "keep-running".
   */
  onWindowAllClosed(decide: WindowAllClosedDecider): Unsubscribe
  /** True once quitting started: let windows close instead of hiding them. */
  isQuitting(): boolean
  /** Quits the app (runs the before-quit hooks). */
  quit(): void
}

export interface DesktopFeature {
  /** Unique, kebab-case; listed by GET /api/desktop/info. Namespace for its settings: "<id>.<name>". */
  id: string
  /**
   * Optional, runs synchronously before the app is ready (command-line switches, protocol
   * registration). Nothing on the context exists yet.
   */
  beforeReady?(): void
  /** Runs after the app is ready and before the main window is created. Register routes, settings and hooks here. */
  setup(ctx: DesktopContext): void | Promise<void>
}

/** Identity helper that types a feature: export default defineFeature({ id, setup }) */
export function defineFeature(feature: DesktopFeature): DesktopFeature {
  return feature
}

/** The Electron-specific parts the core plugs in (windows.ts in the app, fakes in tests). */
export interface WindowHost {
  getMainWindow(): BrowserWindow | null
  showMainWindow(): BrowserWindow
  createWindow(options?: AppWindowOptions): BrowserWindow
  onMainWindowCreated(listener: (window: BrowserWindow) => void): Unsubscribe
}

export interface ContextDeps {
  version: string
  isPackaged: boolean
  platform: NodeJS.Platform
  paths: DesktopPaths
  argv: readonly string[]
  settings: SettingsStore
  routes: RouteRegistry
  bridge: BridgeClient
  log: Logger
  bridgeConfig: () => PublicBridgeConfig
  windows: WindowHost
  /** Starts quitting (app.quit in the app). */
  requestQuit: () => void
}

/** Lifecycle driven by main.ts (or a test). */
export interface Lifecycle {
  runReady(): Promise<void>
  /** Marks the app as quitting and runs the before-quit hooks (bounded by `timeoutMs`). */
  runBeforeQuit(timeoutMs?: number): Promise<void>
  /** Whether the app should quit now that the last window closed. */
  shouldQuitWhenAllClosed(): boolean
}

const BEFORE_QUIT_TIMEOUT_MS = 5_000

export function createDesktopContext(deps: ContextDeps): { ctx: DesktopContext; lifecycle: Lifecycle } {
  const readyHooks: LifecycleHook[] = []
  const quitHooks: LifecycleHook[] = []
  const deciders = new Set<WindowAllClosedDecider>()
  let quitting = false

  async function runHooks(hooks: LifecycleHook[], what: string) {
    await Promise.all(
      hooks.map(async (hook) => {
        try {
          await hook()
        } catch (err) {
          deps.log.error(`${what} hook failed`, err)
        }
      })
    )
  }

  const ctx: DesktopContext = {
    version: deps.version,
    isPackaged: deps.isPackaged,
    platform: deps.platform,
    paths: deps.paths,
    launch: { argv: deps.argv, hidden: deps.argv.includes("--hidden") },
    settings: deps.settings,
    routes: deps.routes,
    bridge: deps.bridge,
    log: deps.log,
    bridgeConfig: deps.bridgeConfig,
    getMainWindow: () => deps.windows.getMainWindow(),
    showMainWindow: () => deps.windows.showMainWindow(),
    createWindow: (options) => deps.windows.createWindow(options),
    onMainWindowCreated: (listener) => deps.windows.onMainWindowCreated(listener),
    onReady: (hook) => void readyHooks.push(hook),
    onBeforeQuit: (hook) => void quitHooks.push(hook),
    onWindowAllClosed(decide) {
      deciders.add(decide)
      return () => deciders.delete(decide)
    },
    isQuitting: () => quitting,
    quit() {
      quitting = true
      deps.requestQuit()
    },
  }

  const lifecycle: Lifecycle = {
    runReady: () => runHooks(readyHooks, "ready"),
    async runBeforeQuit(timeoutMs = BEFORE_QUIT_TIMEOUT_MS) {
      quitting = true
      let timer: NodeJS.Timeout | undefined
      const timeout = new Promise<void>((resolveTimeout) => {
        timer = setTimeout(() => {
          deps.log.warn(`before-quit hooks still running after ${timeoutMs} ms; quitting anyway`)
          resolveTimeout()
        }, timeoutMs)
      })
      await Promise.race([runHooks(quitHooks, "before-quit"), timeout])
      clearTimeout(timer)
    },
    shouldQuitWhenAllClosed() {
      for (const decide of deciders) {
        try {
          if (decide() === "keep-running") return false
        } catch (err) {
          deps.log.error("window-all-closed decider failed", err)
        }
      }
      return true
    },
  }

  return { ctx, lifecycle }
}

/** The context a feature receives: the shared one with its log scoped to the feature id. */
export function scopeContext(ctx: DesktopContext, featureId: string): DesktopContext {
  return { ...ctx, log: ctx.log.child(featureId) }
}

const FEATURE_ID = /^[a-z][a-z0-9-]*$/

/**
 * Sets up every feature in order, isolating failures: a feature that throws is logged and left
 * out of the info route's list; the others still start. Returns the ids that started.
 */
export async function setupFeatures(ctx: DesktopContext, features: readonly DesktopFeature[]) {
  const started: string[] = []
  const seen = new Set<string>()
  for (const feature of features) {
    if (!FEATURE_ID.test(feature.id)) throw new Error(`feature id "${feature.id}" must be kebab-case`)
    if (seen.has(feature.id)) throw new Error(`feature id "${feature.id}" is registered twice`)
    seen.add(feature.id)
    try {
      await feature.setup(scopeContext(ctx, feature.id))
      started.push(feature.id)
    } catch (err) {
      ctx.log.error(`feature "${feature.id}" failed to start`, err)
    }
  }
  return started
}
