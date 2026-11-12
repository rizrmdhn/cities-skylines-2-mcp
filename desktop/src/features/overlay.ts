/**
 * Always-on-top mini overlay: a small frameless window (page: /overlay) with the city at a glance,
 * toggled by a global hotkey, so a player on one monitor can look at the city without leaving the game.
 *
 *   - The window sits at the "screen-saver" always-on-top level, does not take the keyboard focus
 *     (focusable: false: clicking its pause / speed buttons does not pull focus away from the game,
 *     which would pause it) and is not in the taskbar. It is created when shown and destroyed when
 *     hidden, so a hidden overlay never keeps the app alive. Position and size are remembered
 *     (overlay.bounds) and clamped to a connected display when it is shown again.
 *   - It shows over borderless-windowed and windowed games. An always-on-top window cannot be drawn
 *     over an exclusive-fullscreen game: that is a Windows limit, not something to configure.
 *   - The global hotkey (overlay.hotkey, default Ctrl+Shift+O) is registered in onReady and again
 *     whenever the hotkey or overlay.enabled changes. A shortcut another application already owns,
 *     or one the system rejects, never throws: the reason is reported as hotkeyError by the route.
 *     Only our own accelerator is unregistered on quit (other features may own shortcuts too).
 *   - With the tray feature present, the tray menu gets "Show overlay" / "Hide overlay".
 *
 *   GET  /api/desktop/overlay         { present, enabled, open, hotkey, hotkeyRegistered, hotkeyError, opacity, clickThrough }
 *   POST /api/desktop/overlay/toggle  the same, after toggling   (409 while overlay.enabled is off)
 *   POST /api/desktop/overlay/show    the same, after showing    (409 while overlay.enabled is off)
 *   POST /api/desktop/overlay/hide    the same, after hiding
 *
 * The Electron parts (globalShortcut, screen) are behind OverlayPlatform so the logic stays Node-testable.
 */
import type { BrowserWindow, MenuItemConstructorOptions, Rectangle } from "electron"
import { z } from "zod"

import { defineFeature, type DesktopContext, type DesktopFeature } from "../context.ts"
import { RouteError } from "../routes.ts"
import { contributeToTrayMenu, refreshTrayMenu } from "./tray.ts"

export const OVERLAY_DEFAULT_HOTKEY = "CommandOrControl+Shift+O"
/** Default / smallest / largest window size; the page is laid out for the default. */
export const OVERLAY_SIZE = { width: 340, height: 210 }
export const OVERLAY_MIN_SIZE = { width: 300, height: 190 }
export const OVERLAY_MAX_SIZE = { width: 640, height: 420 }
/** Distance from the screen corner of the first placement (top right of the primary display). */
const MARGIN = 16

export interface OverlayBounds {
  x: number
  y: number
  width: number
  height: number
}

declare module "../settings.ts" {
  interface SettingValues {
    "overlay.enabled": boolean
    "overlay.hotkey": string | null
    "overlay.opacity": number
    "overlay.clickThrough": boolean
    "overlay.bounds": OverlayBounds | null
  }
}

// ---------------------------------------------------------------------------------------------
// Hotkey format
// ---------------------------------------------------------------------------------------------

const MODIFIERS = new Set([
  "command",
  "cmd",
  "control",
  "ctrl",
  "commandorcontrol",
  "cmdorctrl",
  "alt",
  "option",
  "altgr",
  "shift",
  "super",
  "meta",
])

const NAMED_KEYS = new Set([
  "plus",
  "space",
  "tab",
  "capslock",
  "numlock",
  "scrolllock",
  "backspace",
  "delete",
  "insert",
  "return",
  "enter",
  "up",
  "down",
  "left",
  "right",
  "home",
  "end",
  "pageup",
  "pagedown",
  "escape",
  "esc",
  "printscreen",
  "numdec",
  "numadd",
  "numsub",
  "nummult",
  "numdiv",
])

function isKey(part: string) {
  const key = part.toLowerCase()
  return (
    /^[a-z0-9]$/.test(key) ||
    /^[-=[\]\\;',./`]$/.test(key) ||
    /^f([1-9]|1[0-9]|2[0-4])$/.test(key) ||
    /^num[0-9]$/.test(key) ||
    NAMED_KEYS.has(key)
  )
}

/**
 * Whether a string is an Electron accelerator this feature accepts: zero or more modifiers and
 * one key, joined with "+" ("CommandOrControl+Shift+O", "Alt+F9", "F10"). A conservative subset
 * of what Electron parses; it needs a modifier unless the key is a function key, so a hotkey
 * never swallows plain typing in the game. Whether the OS grants it is decided at registration.
 */
export function isValidAccelerator(value: string): boolean {
  const parts = value.split("+")
  const key = parts.pop() ?? ""
  if (!isKey(key)) return false
  const seen = new Set<string>()
  for (const part of parts) {
    const modifier = part.toLowerCase()
    if (!MODIFIERS.has(modifier) || seen.has(modifier)) return false
    seen.add(modifier)
  }
  return parts.length > 0 || /^f\d+$/i.test(key)
}

// ---------------------------------------------------------------------------------------------
// Placement
// ---------------------------------------------------------------------------------------------

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max)

function overlap(a: Rectangle, b: Rectangle) {
  const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)
  const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)
  return { width, height, area: width > 0 && height > 0 ? width * height : 0 }
}

/**
 * Where the overlay goes: the saved size (limited to the allowed range and to the display), at
 * the saved position pulled fully inside the display it overlaps most. Without a saved position,
 * or when it is no longer on any display (a monitor was unplugged), the top right of the primary
 * display.
 */
export function placeOverlay(
  saved: OverlayBounds | null,
  workAreas: readonly Rectangle[],
  primary: Rectangle
): Rectangle {
  const wanted = {
    width: clamp(saved?.width ?? OVERLAY_SIZE.width, OVERLAY_MIN_SIZE.width, OVERLAY_MAX_SIZE.width),
    height: clamp(saved?.height ?? OVERLAY_SIZE.height, OVERLAY_MIN_SIZE.height, OVERLAY_MAX_SIZE.height),
  }

  let area = primary
  let onDisplay = false
  if (saved) {
    const rect = { ...wanted, x: saved.x, y: saved.y }
    let best = 0
    for (const candidate of workAreas) {
      const { area: size, width, height } = overlap(rect, candidate)
      // At least a 40 x 30 corner must be on the display for the position to count as visible.
      if (size > best && width >= 40 && height >= 30) {
        best = size
        area = candidate
        onDisplay = true
      }
    }
  }

  const width = Math.min(wanted.width, area.width)
  const height = Math.min(wanted.height, area.height)
  if (saved && onDisplay) {
    return {
      width,
      height,
      x: clamp(saved.x, area.x, area.x + area.width - width),
      y: clamp(saved.y, area.y, area.y + area.height - height),
    }
  }
  return { width, height, x: area.x + area.width - width - MARGIN, y: area.y + MARGIN }
}

// ---------------------------------------------------------------------------------------------
// Electron adapter
// ---------------------------------------------------------------------------------------------

/** What the feature needs from Electron outside the window itself. Only used after the app is ready. */
export interface OverlayPlatform {
  /** false = another application owns the shortcut; throws for an accelerator it cannot parse. */
  register(accelerator: string, callback: () => void): boolean
  unregister(accelerator: string): void
  /** The usable area (without the taskbar) of every connected display. */
  workAreas(): Rectangle[]
  primaryWorkArea(): Rectangle
}

export type OverlayPlatformFactory = () => Promise<OverlayPlatform>

export const createElectronPlatform: OverlayPlatformFactory = async () => {
  const { globalShortcut, screen } = await import("electron")
  return {
    register: (accelerator, callback) => globalShortcut.register(accelerator, callback),
    unregister: (accelerator) => globalShortcut.unregister(accelerator),
    workAreas: () => screen.getAllDisplays().map((display) => display.workArea),
    primaryWorkArea: () => screen.getPrimaryDisplay().workArea,
  }
}

// ---------------------------------------------------------------------------------------------
// The feature
// ---------------------------------------------------------------------------------------------

/** GET /api/desktop/overlay */
export interface OverlayStatus {
  /** false until the app is ready (or when Electron's shortcut/screen modules could not be loaded). */
  present: boolean
  enabled: boolean
  /** The overlay window exists (shown, or about to be). */
  open: boolean
  hotkey: string | null
  hotkeyRegistered: boolean
  /** Why the hotkey is not active, e.g. "already used by another application"; null when fine or off. */
  hotkeyError: string | null
  /** Percent, 30 to 100. */
  opacity: number
  clickThrough: boolean
}

/** Position and size are saved this long after the last move or resize. */
const SAVE_DELAY_MS = 750

export function createOverlay(createPlatform: OverlayPlatformFactory = createElectronPlatform): DesktopFeature {
  return defineFeature({
    id: "overlay",
    setup(ctx: DesktopContext) {
      const enabled = ctx.settings.define("overlay.enabled", { schema: z.boolean(), default: true })
      const hotkey = ctx.settings.define("overlay.hotkey", {
        schema: z
          .string()
          .refine(isValidAccelerator, "must be a key combination such as CommandOrControl+Shift+O")
          .nullable(),
        default: OVERLAY_DEFAULT_HOTKEY,
      })
      const opacity = ctx.settings.define("overlay.opacity", { schema: z.number().int().min(30).max(100), default: 90 })
      const clickThrough = ctx.settings.define("overlay.clickThrough", { schema: z.boolean(), default: false })
      const bounds = ctx.settings.define("overlay.bounds", {
        schema: z
          .object({
            x: z.number().int(),
            y: z.number().int(),
            width: z.number().int().positive(),
            height: z.number().int().positive(),
          })
          .nullable(),
        default: null,
        expose: false,
      })

      let platform: OverlayPlatform | null = null
      let overlay: BrowserWindow | null = null
      /** The accelerator we hold; null = none. */
      let registered: string | null = null
      let hotkeyError: string | null = null
      let saveTimer: NodeJS.Timeout | undefined

      const isOpen = () => overlay !== null && !overlay.isDestroyed()

      function status(): OverlayStatus {
        return {
          present: platform !== null,
          enabled: enabled.get(),
          open: isOpen(),
          hotkey: hotkey.get(),
          hotkeyRegistered: registered !== null,
          hotkeyError,
          opacity: opacity.get(),
          clickThrough: clickThrough.get(),
        }
      }

      // --- window -----------------------------------------------------------------------------

      function saveBounds(window: BrowserWindow) {
        clearTimeout(saveTimer)
        if (window.isDestroyed()) return
        const { x, y, width, height } = window.getBounds()
        bounds.set({ x, y, width, height }).catch((err: unknown) => ctx.log.warn("could not save the overlay position", err))
      }

      /** Keeps it above the game: the topmost level can be taken over by a window that just went fullscreen. */
      function raise(window: BrowserWindow) {
        window.setAlwaysOnTop(true, "screen-saver")
        if (!window.isVisible()) window.showInactive()
        window.moveTop()
      }

      function show(): OverlayStatus {
        if (!platform) throw new RouteError(503, "the overlay is not ready yet")
        if (!enabled.get()) throw new RouteError(409, "the overlay is turned off (setting overlay.enabled)")
        if (overlay && !overlay.isDestroyed()) {
          raise(overlay)
          return status()
        }

        const window = ctx.createWindow({
          route: "/overlay",
          ...placeOverlay(bounds.get(), platform.workAreas(), platform.primaryWorkArea()),
          minWidth: OVERLAY_MIN_SIZE.width,
          minHeight: OVERLAY_MIN_SIZE.height,
          maxWidth: OVERLAY_MAX_SIZE.width,
          maxHeight: OVERLAY_MAX_SIZE.height,
          title: "CS2MCP overlay",
          alwaysOnTop: true,
          frame: false,
          skipTaskbar: true,
          // Clicking the overlay must not take the focus from the game (it pauses while unfocused).
          focusable: false,
          resizable: true,
          minimizable: false,
          maximizable: false,
          fullscreenable: false,
          // Not transparent: transparent frameless windows cannot be resized on Windows. The
          // whole window is made translucent with overlay.opacity instead.
          showWhenReady: false,
          // The page keeps polling while another window covers or surrounds it.
          webPreferences: { backgroundThrottling: false },
        })
        overlay = window
        window.setAlwaysOnTop(true, "screen-saver")
        window.setOpacity(opacity.get() / 100)
        if (clickThrough.get()) window.setIgnoreMouseEvents(true)
        window.once("ready-to-show", () => {
          if (!window.isDestroyed()) raise(window)
        })
        const saveSoon = () => {
          clearTimeout(saveTimer)
          saveTimer = setTimeout(() => saveBounds(window), SAVE_DELAY_MS)
        }
        window.on("move", saveSoon)
        window.on("resize", saveSoon)
        window.on("close", () => saveBounds(window))
        window.on("closed", () => {
          clearTimeout(saveTimer)
          if (overlay === window) overlay = null
          refreshTrayMenu()
        })
        ctx.log.info("overlay shown")
        refreshTrayMenu()
        return status()
      }

      function hide(): OverlayStatus {
        const window = overlay
        overlay = null
        if (window && !window.isDestroyed()) {
          window.close()
          ctx.log.info("overlay hidden")
        }
        refreshTrayMenu()
        return status()
      }

      function toggle(): OverlayStatus {
        return isOpen() ? hide() : show()
      }

      // --- hotkey -----------------------------------------------------------------------------

      function onHotkey() {
        try {
          toggle()
        } catch (err) {
          ctx.log.warn(`overlay hotkey: ${err instanceof Error ? err.message : String(err)}`)
        }
      }

      function applyHotkey() {
        hotkeyError = null
        if (!platform) return
        const wanted = enabled.get() ? hotkey.get() : null
        if (registered !== null && registered !== wanted) {
          platform.unregister(registered)
          registered = null
        }
        if (wanted === null || registered === wanted) return
        try {
          if (platform.register(wanted, onHotkey)) registered = wanted
          else hotkeyError = `${wanted} is already used by another application. Choose another shortcut.`
        } catch (err) {
          hotkeyError = `${wanted} is not a shortcut this system accepts. Choose another one.`
          ctx.log.warn(`could not register ${wanted}`, err)
        }
        if (hotkeyError) ctx.log.warn(`overlay hotkey: ${hotkeyError}`)
        else ctx.log.info(`overlay hotkey ${wanted} registered`)
      }

      // --- settings ---------------------------------------------------------------------------

      enabled.onChange((on) => {
        if (!on) hide()
        applyHotkey()
        refreshTrayMenu()
      })
      hotkey.onChange(() => {
        applyHotkey()
        refreshTrayMenu()
      })
      opacity.onChange((percent) => {
        if (overlay && !overlay.isDestroyed()) overlay.setOpacity(percent / 100)
      })
      clickThrough.onChange((on) => {
        if (overlay && !overlay.isDestroyed()) overlay.setIgnoreMouseEvents(on)
      })

      // --- tray -------------------------------------------------------------------------------

      const removeTrayItems = contributeToTrayMenu((): MenuItemConstructorOptions[] => {
        const item: MenuItemConstructorOptions = {
          label: isOpen() ? "Hide overlay" : "Show overlay",
          enabled: platform !== null && enabled.get(),
          click: onHotkey,
        }
        // Shows the shortcut next to the item without registering it a second time.
        if (registered !== null && isValidAccelerator(registered)) {
          item.accelerator = registered
          item.registerAccelerator = false
        }
        return [item]
      })

      // --- routes and lifecycle ---------------------------------------------------------------

      ctx.routes.get("/desktop/overlay", () => status())
      ctx.routes.post("/desktop/overlay/toggle", () => toggle())
      ctx.routes.post("/desktop/overlay/show", () => show())
      ctx.routes.post("/desktop/overlay/hide", () => hide())

      ctx.onReady(async () => {
        try {
          platform = await createPlatform()
        } catch (err) {
          ctx.log.error("the overlay is unavailable", err)
          hotkeyError = "The overlay could not be set up (see the log)."
          return
        }
        applyHotkey()
        refreshTrayMenu()
      })

      ctx.onBeforeQuit(() => {
        clearTimeout(saveTimer)
        removeTrayItems()
        if (platform && registered !== null) platform.unregister(registered)
        registered = null
        const window = overlay
        overlay = null
        if (window && !window.isDestroyed()) window.close()
      })
    },
  })
}

export default createOverlay()
