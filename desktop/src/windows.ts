/**
 * Window creation for the core and features: every window is hardened the same way and loads a
 * page of the web app from app://cs2mcp. The main window remembers its bounds and maximized
 * state in the "window.main" setting.
 */
import { BrowserWindow, nativeTheme, screen, type Rectangle, type WebPreferences } from "electron"

import { appUrl } from "./app-protocol.ts"
import type { AppWindowOptions, WindowHost } from "./context.ts"
import type { Logger } from "./logger.ts"
import type { Setting, WindowState } from "./settings.ts"

export const MAIN_WINDOW_DEFAULT = { width: 1280, height: 860 }
export const MAIN_WINDOW_MIN = { width: 900, height: 600 }

export interface WindowHostOptions {
  isPackaged: boolean
  icon: string
  windowState: Setting<WindowState | null>
  log: Logger
}

function hardened(isPackaged: boolean, extra: AppWindowOptions["webPreferences"] = {}): WebPreferences {
  return {
    ...extra,
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
    nodeIntegrationInWorker: false,
    nodeIntegrationInSubFrames: false,
    webviewTag: false,
    webSecurity: true,
    allowRunningInsecureContent: false,
    navigateOnDragDrop: false,
    safeDialogs: true,
    devTools: !isPackaged,
  }
}

/** Background matching the app theme, so a window never flashes white before its first paint. */
function background() {
  return nativeTheme.shouldUseDarkColors ? "#0a0a0a" : "#ffffff"
}

/** Saved bounds if at least a 120 x 80 corner of them is on a connected display. */
function restoredBounds(saved: WindowState | null): Partial<Rectangle> {
  if (!saved) return MAIN_WINDOW_DEFAULT
  const size = {
    width: Math.max(MAIN_WINDOW_MIN.width, saved.width),
    height: Math.max(MAIN_WINDOW_MIN.height, saved.height),
  }
  if (saved.x === undefined || saved.y === undefined) return size
  const bounds = { x: saved.x, y: saved.y, ...size }
  const visible = screen.getAllDisplays().some(({ workArea: area }) => {
    const width = Math.min(bounds.x + bounds.width, area.x + area.width) - Math.max(bounds.x, area.x)
    const height = Math.min(bounds.y + bounds.height, area.y + area.height) - Math.max(bounds.y, area.y)
    return width >= 120 && height >= 80
  })
  return visible ? bounds : size
}

export function createWindowHost({ isPackaged, icon, windowState, log }: WindowHostOptions): WindowHost {
  let main: BrowserWindow | null = null
  /** The main window should be visible once it painted (it may still be loading). */
  let wantShown = false
  let painted = false
  let pendingMaximize = false
  const createdListeners = new Set<(window: BrowserWindow) => void>()

  function createWindow(options: AppWindowOptions = {}): BrowserWindow {
    const { route = "/", webPreferences, showWhenReady = true, ...rest } = options
    const window = new BrowserWindow({
      icon,
      backgroundColor: background(),
      ...rest,
      show: false,
      webPreferences: hardened(isPackaged, webPreferences),
    })
    if (showWhenReady && rest.show !== false) window.once("ready-to-show", () => window.show())
    window.loadURL(appUrl(route)).catch((err: unknown) => log.error(`could not load ${route}`, err))
    return window
  }

  function reveal(window: BrowserWindow) {
    if (pendingMaximize) {
      pendingMaximize = false
      window.maximize()
    } else if (window.isMinimized()) {
      window.restore()
    }
    window.show()
    window.focus()
  }

  function saveState(window: BrowserWindow) {
    if (window.isDestroyed() || window.isMinimized()) return
    const { x, y, width, height } = window.getNormalBounds()
    windowState
      .set({ x, y, width, height, maximized: window.isMaximized() })
      .catch((err: unknown) => log.warn("could not save the window state", err))
  }

  function createMainWindow(): BrowserWindow {
    const saved = windowState.get()
    const window = createWindow({
      ...restoredBounds(saved),
      minWidth: MAIN_WINDOW_MIN.width,
      minHeight: MAIN_WINDOW_MIN.height,
      title: "CS2MCP Companion",
      showWhenReady: false,
    })
    main = window
    painted = false
    pendingMaximize = saved?.maximized ?? false

    window.once("ready-to-show", () => {
      painted = true
      if (wantShown) reveal(window)
    })
    let timer: NodeJS.Timeout | undefined
    const saveSoon = () => {
      clearTimeout(timer)
      timer = setTimeout(() => saveState(window), 750)
    }
    for (const event of ["resize", "move", "maximize", "unmaximize"] as const) {
      window.on(event as "resize", saveSoon)
    }
    window.on("close", () => {
      clearTimeout(timer)
      saveState(window)
    })
    window.on("closed", () => {
      if (main === window) main = null
      wantShown = false
    })

    for (const listener of createdListeners) {
      try {
        listener(window)
      } catch (err) {
        log.error("a main-window listener failed", err)
      }
    }
    return window
  }

  return {
    getMainWindow: () => (main && !main.isDestroyed() ? main : null),
    showMainWindow() {
      wantShown = true
      const window = main && !main.isDestroyed() ? main : createMainWindow()
      if (painted) reveal(window)
      return window
    },
    createWindow,
    onMainWindowCreated(listener) {
      createdListeners.add(listener)
      return () => createdListeners.delete(listener)
    },
  }
}
