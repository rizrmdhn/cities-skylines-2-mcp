/**
 * A real DesktopContext without Electron, for feature tests in Node (vitest):
 *
 *   const t = await createTestContext({ features: [myFeature] })
 *   const res = await t.request("GET", "/api/desktop/my-feature/status")
 *
 * Settings, routes, the bridge client, the app:// handler and the lifecycle are the production
 * implementations; only windows are stubbed (pass `windows` to provide your own fakes).
 */
import type { BrowserWindow } from "electron"

import { createAppHandler } from "./app-protocol.ts"
import { createBridgeClient } from "./bridge.ts"
import { defineCoreSettings, publicBridgeConfig, resolveBridgeConfig, type CoreSettings } from "./config.ts"
import {
  createDesktopContext,
  setupFeatures,
  type DesktopContext,
  type DesktopFeature,
  type Lifecycle,
  type WindowHost,
} from "./context.ts"
import { registerCoreRoutes } from "./core-routes.ts"
import { createLogger, createMemorySink } from "./logger.ts"
import { createRouteRegistry } from "./routes.ts"
import { openSettingsStore, type SecretCodec } from "./settings.ts"

export interface TestContextOptions {
  /** Features to set up (as main.ts does with src/features/index.ts). */
  features?: DesktopFeature[]
  /**
   * Answers every bridge request, from ctx.bridge and from proxied /api/* calls, after the
   * allowlist. Default: the bridge is unreachable.
   */
  bridgeFetch?: typeof fetch
  /** Environment layer of the bridge config (default: empty, process.env is not read). */
  env?: Record<string, string | undefined>
  /** .env layer of the bridge config. */
  dotenv?: Record<string, string>
  /** Persist settings to this file (default: in memory). */
  settingsFile?: string
  /** Secret codec (default: none, secrets stored as plain text). */
  codec?: SecretCodec
  /** Built web app for static requests (default: a folder that does not exist -> 503). */
  rendererDir?: string
  argv?: string[]
  version?: string
  isPackaged?: boolean
  /** Window fakes; by default getMainWindow() is null and creating a window throws. */
  windows?: Partial<WindowHost>
}

export interface TestContext {
  ctx: DesktopContext
  lifecycle: Lifecycle
  core: CoreSettings
  /** Every log line written so far. */
  logs: string[]
  /** Ids of the features that started. */
  featureIds: string[]
  /** The app:// handler, as the renderer's fetch reaches it; `path` like "/api/desktop/info". */
  fetch(path: string, init?: RequestInit): Promise<Response>
  /** fetch with a JSON body (POST) and a parsed JSON answer. */
  request<T = unknown>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T; headers: Headers }>
}

const unreachable = (async () => {
  throw new TypeError("fetch failed")
}) as typeof fetch

function noWindows(): never {
  throw new Error("no windows in tests: pass `windows` to createTestContext")
}

export async function createTestContext(options: TestContextOptions = {}): Promise<TestContext> {
  const sink = createMemorySink()
  const log = createLogger(sink)
  const settings = await openSettingsStore({ file: options.settingsFile, codec: options.codec, log })
  const core = defineCoreSettings(settings)
  const routes = createRouteRegistry({ log })
  const bridgeConfig = () =>
    resolveBridgeConfig({
      env: options.env ?? {},
      settings: { bridgeUrl: core.bridgeUrl.get(), token: core.token.get() },
      dotenv: options.dotenv ?? {},
    })
  const proxyOptions = () => {
    const { bridgeUrl, token } = bridgeConfig()
    return { bridgeUrl, token, fetch: options.bridgeFetch ?? unreachable }
  }
  const windows: WindowHost = {
    getMainWindow: (): BrowserWindow | null => null,
    showMainWindow: noWindows,
    createWindow: noWindows,
    onMainWindowCreated: () => () => {},
    ...options.windows,
  }
  const rendererDir = options.rendererDir ?? "/nonexistent-renderer"

  const { ctx, lifecycle } = createDesktopContext({
    version: options.version ?? "0.0.0-test",
    isPackaged: options.isPackaged ?? false,
    platform: process.platform,
    paths: {
      userData: "/test/userData",
      logs: "/test/userData/logs",
      renderer: rendererDir,
      assets: "/test/assets",
      icon: "/test/assets/icon.ico",
    },
    argv: options.argv ?? [],
    settings,
    routes,
    bridge: createBridgeClient(proxyOptions),
    log,
    bridgeConfig: () => publicBridgeConfig(bridgeConfig()),
    windows,
    requestQuit: () => {},
  })

  let featureIds: string[] = []
  registerCoreRoutes(ctx, () => featureIds)
  featureIds = await setupFeatures(ctx, options.features ?? [])

  const handler = createAppHandler({ rendererDir, routes, proxyOptions, log })
  const fetchApp = (path: string, init?: RequestInit) =>
    handler(new Request(`app://cs2mcp${path}`, init))

  return {
    ctx,
    lifecycle,
    core,
    logs: sink.lines,
    featureIds,
    fetch: fetchApp,
    async request<T>(method: string, path: string, body?: unknown) {
      const response = await fetchApp(path, {
        method,
        headers: body === undefined ? {} : { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      return { status: response.status, body: (await response.json()) as T, headers: response.headers }
    },
  }
}
