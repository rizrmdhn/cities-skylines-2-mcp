/**
 * Electron entry point (bundled to dist/main.cjs). Glue only: the logic lives in Electron-free
 * modules (settings, routes, app-protocol, context) and in features (src/features/).
 */
import { join, resolve } from "node:path"

import { app, Menu, protocol, safeStorage, session } from "electron"
import { z } from "zod"

import { APP_SCHEME, createAppHandler } from "./app-protocol.ts"
import { createBridgeClient } from "./bridge.ts"
import { defineCoreSettings, publicBridgeConfig, readRepoDotenv, resolveBridgeConfig } from "./config.ts"
import { createDesktopContext, setupFeatures, type DesktopFeature, type DesktopPaths, type Lifecycle } from "./context.ts"
import { registerCoreRoutes } from "./core-routes.ts"
import * as registeredFeatures from "./features/index.ts"
import { createFileSink, createLogger } from "./logger.ts"
import { createRouteRegistry } from "./routes.ts"
import { installSecurity } from "./security.ts"
import { openSettingsStore, type SecretCodec, type WindowState } from "./settings.ts"
import { unpackedPath } from "./unpacked-path.ts"
import { createWindowHost } from "./windows.ts"

const APP_NAME = "CS2MCP Companion"
const APP_ID = "com.cs2mcp.companion"

const features: DesktopFeature[] = Object.values(registeredFeatures)

const windowStateSchema = z
  .object({
    x: z.number().int().optional(),
    y: z.number().int().optional(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    maximized: z.boolean(),
  })
  .nullable()

const safeStorageCodec: SecretCodec = {
  isAvailable: () => safeStorage.isAsyncEncryptionAvailable(),
  encrypt: (plain) => safeStorage.encryptStringAsync(plain),
  decrypt: (data) => safeStorage.decryptStringAsync(data),
}

async function start() {
  // Hooks that must exist before ready, filled in once the context is up.
  let lifecycle: Lifecycle | undefined
  let showMain: (() => void) | undefined
  app.on("second-instance", () => showMain?.())

  await app.whenReady()

  // Installed, dist/ is inside app.asar: Node reads it from there (the renderer files), but files
  // handed to the OS by path (the window icon) are unpacked next to it.
  const distDir = __dirname
  const unpackedDir = app.isPackaged ? unpackedPath(distDir) : distDir
  const userData = app.getPath("userData")
  const paths: DesktopPaths = {
    userData,
    logs: join(userData, "logs"),
    renderer: join(distDir, "renderer"),
    assets: join(unpackedDir, "assets"),
    icon: join(unpackedDir, "assets", process.platform === "win32" ? "icon.ico" : "icon.png"),
  }
  const log = createLogger(createFileSink({ file: join(paths.logs, "main.log"), echo: !app.isPackaged }))
  process.on("uncaughtException", (err) => log.error("uncaught exception", err))
  process.on("unhandledRejection", (err) => log.error("unhandled rejection", err))

  const settings = await openSettingsStore({
    file: join(userData, "settings.json"),
    codec: safeStorageCodec,
    log: log.child("settings"),
  })
  const core = defineCoreSettings(settings)
  const windowState = settings.define<WindowState | null>("window.main", {
    schema: windowStateSchema,
    default: null,
    expose: false,
  })

  // The repo's .env files only make sense next to the repo, never in an installed app.
  const dotenv = app.isPackaged ? {} : readRepoDotenv(resolve(app.getAppPath(), ".."))
  const bridgeConfig = () =>
    resolveBridgeConfig({
      env: process.env,
      settings: { bridgeUrl: core.bridgeUrl.get(), token: core.token.get() },
      dotenv,
    })
  const proxyOptions = () => {
    const { bridgeUrl, token } = bridgeConfig()
    return { bridgeUrl, token }
  }

  const routes = createRouteRegistry({ log: log.child("routes") })
  const windows = createWindowHost({ isPackaged: app.isPackaged, icon: paths.icon, windowState, log })
  const created = createDesktopContext({
    version: app.getVersion(),
    isPackaged: app.isPackaged,
    platform: process.platform,
    paths,
    argv: process.argv,
    settings,
    routes,
    bridge: createBridgeClient(proxyOptions),
    log,
    bridgeConfig: () => publicBridgeConfig(bridgeConfig()),
    windows,
    requestQuit: () => app.quit(),
  })
  const { ctx } = created
  lifecycle = created.lifecycle

  const config = ctx.bridgeConfig()
  log.info(
    `CS2MCP Companion ${ctx.version} starting (packaged: ${ctx.isPackaged}, userData: ${userData}, ` +
      `bridge: ${config.bridgeUrl} from ${config.bridgeUrlSource}, token: ${config.tokenSet ? `set from ${config.tokenSource}` : "none"})`
  )

  let featureIds: string[] = []
  registerCoreRoutes(ctx, () => featureIds)
  featureIds = await setupFeatures(ctx, features)
  log.info(`features: ${featureIds.join(", ") || "(none)"}`)

  installSecurity(session.defaultSession, log.child("security"))
  protocol.handle(
    APP_SCHEME,
    createAppHandler({ rendererDir: paths.renderer, routes, proxyOptions, log: log.child("protocol") })
  )
  Menu.setApplicationMenu(
    app.isPackaged
      ? null
      : Menu.buildFromTemplate([
          {
            label: "View",
            submenu: [
              { role: "reload" },
              { role: "forceReload" },
              { role: "toggleDevTools" },
              { type: "separator" },
              { role: "resetZoom" },
              { role: "zoomIn" },
              { role: "zoomOut" },
            ],
          },
          { label: "Window", submenu: [{ role: "minimize" }, { role: "close" }, { role: "quit" }] },
        ])
  )

  app.on("window-all-closed", () => {
    if (lifecycle?.shouldQuitWhenAllClosed()) app.quit()
  })
  let quitHooksDone = false
  let quitHooksRunning = false
  app.on("before-quit", (event) => {
    if (quitHooksDone || !lifecycle) return
    event.preventDefault()
    if (quitHooksRunning) return
    quitHooksRunning = true
    void lifecycle.runBeforeQuit().finally(() => {
      quitHooksDone = true
      app.quit()
    })
  })
  // Windows save their state while closing; let those writes land before the process ends.
  let flushed = false
  app.on("will-quit", (event) => {
    if (flushed) return
    event.preventDefault()
    void settings.flush().finally(() => {
      flushed = true
      log.info("quit")
      app.quit()
    })
  })

  showMain = () => ctx.showMainWindow()
  if (!ctx.launch.hidden) ctx.showMainWindow()
  await lifecycle.runReady()
}

// Tests and the smoke script run with their own profile, so they never touch the user's settings
// and never collide with a running instance (the single-instance lock lives in userData).
const userDataOverride = process.env.CS2MCP_DESKTOP_USER_DATA?.trim()
if (userDataOverride) app.setPath("userData", resolve(userDataOverride))
app.setName(APP_NAME)
if (process.platform === "win32") app.setAppUserModelId(APP_ID)

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: APP_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, codeCache: true },
    },
  ])
  for (const feature of features) feature.beforeReady?.()
  start().catch((err: unknown) => {
    console.error("CS2MCP Companion failed to start:", err)
    app.exit(1)
  })
}
