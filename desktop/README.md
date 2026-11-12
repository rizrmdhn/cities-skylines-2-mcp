# CS2MCP Companion — desktop app

A native Electron shell around the web companion (`web/`). It shows the same React app, but in its own window instead of a browser tab, and without an HTTP port: the window loads `app://cs2mcp/`, and the main process answers every request itself. Desktop-only features (tray, overlay, notifications, …) plug into one small context object.

## Run and build

From the repo root (Node ≥ 22.12, Windows is the target platform):

```powershell
npm run setup          # once: installs mcp-server/, web/ and desktop/ (also downloads Electron)
npm run desktop        # build web + desktop, then launch
npm run desktop:build  # build only  -> desktop/dist/
npm run desktop:start  # launch the last build
npm run desktop:smoke  # build, then the end-to-end smoke test (below)
npm test               # web typecheck + tests, desktop typecheck + tests
```

Inside `desktop/`:

| script | does |
| --- | --- |
| `npm run dev` | builds `web/`, builds the desktop app, launches it (no HMR; restart to see changes; `node scripts/build.mjs --watch` rebuilds the main process on save) |
| `npm run build` | `scripts/build.mjs`: bundles `src/main.ts` to `dist/main.cjs` with esbuild, copies `web/dist` to `dist/renderer` and `assets/` to `dist/assets`. Needs `web/dist` (build the web app first). |
| `npm start` | `electron .` |
| `npm test` / `npm run typecheck` | vitest (Node, no Electron) / `tsc` |
| `npm run smoke` | build + `scripts/smoke.mjs` |
| `npm run icons` | regenerates `assets/icon.ico` / `icon.png` from the favicon design (committed; rerun only when the favicon changes) |

To see it work without the game: `node scripts/stub-bridge.mjs` prints a URL; start the app with `CS2_BRIDGE_URL=<that url>`.

Logs: `%APPDATA%\CS2MCP Companion\logs\main.log` (settings in `settings.json` next to `logs\`). `CS2MCP_DESKTOP_USER_DATA=<dir>` uses another profile folder (tests and the smoke script do this, so they never touch your settings or collide with a running app).

## Architecture

```
renderer (web/ React app, unchanged)        main process (desktop/src)
 fetch("app://cs2mcp/...") ───────────────▶ protocol.handle("app")  = app-protocol.ts createAppHandler
                                             ├─ /api/desktop/*  → routes.ts registry → core + feature handlers
                                             ├─ /api/*          → web/server/proxy.ts  proxyBridgeRequest ─▶ bridge :8642
                                             └─ everything else → web/server/static-files.ts resolveStaticFile → dist/renderer
```

- **One implementation** of the bridge allowlist and of static-file lookup: `web/server/proxy.ts` and `web/server/static-files.ts` are transport-agnostic (plain data in/out). The browser companion's HTTP server and the Vite dev server use them through `web/server/handler.ts` / `static.ts`; the desktop app imports the same source files (bundled by esbuild).
- `web/src/lib/api.ts` builds URLs from `window.location.origin`, so on `app://cs2mcp` the React app calls the main process with no change.
- At runtime the app reads only `dist/` (`main.cjs`, `renderer/`, `assets/`), resolved from `__dirname`. The repo's `.env` files are read only when `app.isPackaged` is false. All npm packages are `devDependencies` because esbuild bundles them; keep it that way (a native module would have to be a `dependency` and left `external`).

| file | role | loads Electron? |
| --- | --- | --- |
| `src/main.ts` | entry: app name/id, single-instance lock, scheme registration, wiring, quit sequence, dev menu | yes |
| `src/windows.ts` | hardened `BrowserWindow` factory, main window + remembered bounds | yes |
| `src/security.ts` | navigation/new-window/permission guards for every webContents | yes |
| `src/context.ts` | `DesktopContext`, `DesktopFeature`, `defineFeature`, lifecycle, `setupFeatures` | types only |
| `src/app-protocol.ts` | `Request → Response` handler for `app://`, CSP, `appUrl()` | no |
| `src/routes.ts` | `/api/desktop/*` registry, `RouteError` | no |
| `src/settings.ts` | settings store | no |
| `src/config.ts` | bridge URL/token precedence, core settings, schemas | no |
| `src/bridge.ts` | `ctx.bridge` client, `BridgeError` | no |
| `src/logger.ts` | file logger | no |
| `src/core-routes.ts` | `GET /api/desktop/info` | no |
| `src/testing.ts` | `createTestContext()` for Node tests | no |
| `src/features/index.ts` | **the registration list** | — |
| `src/features/settings-api.ts` | built-in feature: `GET/POST /api/desktop/settings` | no |

Modules marked "no" must stay importable in plain Node: tests load them. Import Electron only with `import type` there.

### Window and renderer hardening

Every window (main and feature windows) gets `contextIsolation`, `sandbox`, no `nodeIntegration`, no `<webview>`, no preload, devtools only when not packaged. App-wide: navigation and redirects away from `app://cs2mcp` are cancelled in every frame (http(s) targets open in the system browser instead; other schemes are dropped and logged), `window.open` never creates a window, permission requests/checks are denied except `clipboard-sanitized-write` (the map's "copy prompt" button). HTML responses carry this CSP (`app-protocol.ts`):

```
default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:;
font-src 'self' data:; connect-src 'self'; worker-src 'self' blob:; object-src 'none'; base-uri 'none';
form-action 'none'; frame-src 'none'; frame-ancestors 'none'
```

`/api/*` requests with an `Origin` other than `app://cs2mcp` are refused (403). The renderer talks to the main process **only through `fetch`**; do not add a preload or IPC.

Other behaviour: single instance (a second launch focuses the existing window and exits), main window bounds and maximized state remembered (`window.main` setting, minimum 900 × 600), app name "CS2MCP Companion", AppUserModelID `com.cs2mcp.companion`, icon `assets/icon.ico`, no menu when packaged (dev: View → reload / devtools / zoom).

## Configuration

The bridge URL and token are resolved per value, first match wins, on **every** request (a change applies to the next call, no restart):

1. process environment: `CS2_BRIDGE_URL`, `CS2MCP_TOKEN`
2. the settings store: `bridgeUrl`, `token` (set through `POST /api/desktop/settings`)
3. only when not packaged: `web/.env`, then `mcp-server/.env` (the files the browser companion reads; parsed, never loaded into `process.env`)
4. defaults: `http://127.0.0.1:8642`, no token

Empty values count as unset. The token is added to bridge requests in the main process and is never sent to the renderer or written to the log.

## The `/api/desktop/*` contract

The renderer calls `fetch("/api/desktop/<name>")` — GET for reads, POST with a JSON body for actions. Answers are JSON (`Cache-Control: no-store`). Failures always have the bridge proxy's error body with `kind: "companion"`:

```json
{ "error": "bridgeUrl: must be an http:// or https:// URL", "status": 400, "kind": "companion" }
```

404 = unknown route (this is also what the **browser** companion answers for every `/api/desktop/*` path, which is how the web app knows it is not in the desktop app), 405 = wrong method (with `Allow`), 400 = invalid body/validation, 500 = handler crashed (details only in the log).

| route | answer |
| --- | --- |
| `GET /api/desktop/info` | `{ "desktop": true, "version": "0.11.0", "platform": "win32", "packaged": false, "features": ["settings-api"] }` — `features` lists the ids of features that started |
| `GET /api/desktop/settings` | every exposed setting, secrets as `<key>Set`: `{ "bridgeUrl": null, "tokenSet": false, "effective": { "bridgeUrl": "http://127.0.0.1:8642", "bridgeUrlSource": "default", "tokenSet": false, "tokenSource": "default" }, "secretsEncrypted": true, "<feature>.<key>": … }` (`*Source` is `env` / `settings` / `dotenv` / `default`) |
| `POST /api/desktop/settings` | body: partial `{ "<key>": value }`. Each key is validated by its schema; unknown or unexposed keys are refused; all-or-nothing. `""` or `null` clears `bridgeUrl`/`token`. Answers like the GET. |

The bridge proxy on `/api/<bridge route>` is unchanged: GET only, the allowlist in `web/server/routes.ts`.

### Web side (`web/src/lib/`)

```ts
// api.ts
apiGet<T>(path: string, params?: QueryParams, signal?: AbortSignal): Promise<T>   // "/city/overview", "/desktop/info"
apiPost<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T>        // "/desktop/settings"; throws ApiError
class ApiError extends Error { status: number; kind: "unreachable" | "bridge" | "companion" }

// desktop.ts
useDesktop(): { isDesktop: boolean; info: DesktopInfo | undefined; isPending: boolean }   // asked once, never polls
desktopInfoQuery()                       // queryOptions; resolves DesktopInfo | null (null = browser companion)
fetchDesktopInfo(signal?): Promise<DesktopInfo | null>
desktopQueryKeys = { info: ["desktop","info"], settings: ["desktop","settings"] }
type DesktopInfo, DesktopSettings, ConfigSource
```

Tests (`web/src/test/server.ts`): by default every `/api/desktop/*` request answers the browser companion's 404, so `useDesktop()` reports `isDesktop: false`. Call `enableDesktopMode(partialInfo?)` in a test to be "in the desktop app", and `server.use(http.get("*/api/desktop/x", …))` for your route.

## Adding a feature

A feature is **one file** `src/features/<id>.ts` plus **one line** in `src/features/index.ts`. Do not edit other shared files; if you believe you must, the context is missing something — add it in a separate, minimal commit.

Rules:
- `id`: kebab-case, unique. Routes: `/desktop/<id>` or `/desktop/<id>/<action>` (lowercase, digits, `-`). Settings keys: `<id>.<name>`.
- `setup(ctx)` runs after `app` is ready and before the main window exists. Register routes, settings and hooks there; start timers/windows in `ctx.onReady`, stop them in `ctx.onBeforeQuit`.
- Use `ctx.log` (scoped to your id), never `console`. Never return or log the token.
- A feature that throws in `setup` is logged and left out of `info.features`; the app still starts.
- Prefer keeping Electron imports out of the logic you test; inject or split them (see Recipes).

**1. `src/features/city-watch.ts`** (this exact code is exercised by `test/example-feature.test.ts`):

```ts
import { z } from "zod"

import { BridgeError } from "../bridge.ts"
import { defineFeature } from "../context.ts"
import { RouteError } from "../routes.ts"

interface Overview {
  cityName: string
  population: number
}

export default defineFeature({
  id: "city-watch",
  setup(ctx) {
    // Namespaced, validated, persisted; shows up in GET /api/desktop/settings.
    const interval = ctx.settings.define("city-watch.intervalSeconds", {
      schema: z.number().int().min(5).max(3600),
      default: 60,
    })
    let last: Overview | null = null
    let timer: NodeJS.Timeout | undefined

    async function poll() {
      try {
        last = await ctx.bridge.get<Overview>("/city/overview")
      } catch (err) {
        if (!(err instanceof BridgeError)) throw err
        ctx.log.debug(`overview unavailable: ${err.message}`)
      }
    }
    function schedule() {
      clearInterval(timer)
      timer = setInterval(() => void poll(), interval.get() * 1000)
    }

    ctx.routes.get("/desktop/city-watch", () => ({ last, intervalSeconds: interval.get() }))
    ctx.routes.post("/desktop/city-watch/refresh", async () => {
      await poll()
      if (!last) throw new RouteError(503, "no city data yet")
      return last
    })

    interval.onChange(schedule)
    ctx.onReady(() => {
      schedule()
      void poll()
    })
    ctx.onBeforeQuit(() => clearInterval(timer))
  },
})
```

**2. Register it** — one line in `src/features/index.ts`, alphabetical:

```ts
export { default as cityWatch } from "./city-watch.ts"
```

**3. Call it from the web app** (only when in the desktop app; no visible change in the browser companion):

```ts
import { useQuery } from "@tanstack/react-query"
import { apiGet, apiPost } from "@/lib/api"
import { useDesktop } from "@/lib/desktop"

export function useCityWatch() {
  const { isDesktop } = useDesktop()
  return useQuery({
    queryKey: ["desktop", "city-watch"],
    queryFn: ({ signal }) => apiGet<{ last: { cityName: string } | null }>("/desktop/city-watch", {}, signal),
    enabled: isDesktop,
  })
}
// action: await apiPost("/desktop/city-watch/refresh")
```

**4. Test it** — `test/city-watch.test.ts`, plain Node, real store/routes/proxy:

```ts
import { describe, expect, it } from "vitest"

import cityWatch from "../src/features/city-watch.ts"
import { createTestContext } from "../src/testing.ts"

describe("city-watch", () => {
  it("polls the bridge on demand", async () => {
    const t = await createTestContext({
      features: [cityWatch],
      bridgeFetch: async () => Response.json({ cityName: "Riverside", population: 12345 }),
    })
    const res = await t.request("POST", "/api/desktop/city-watch/refresh")
    expect(res).toMatchObject({ status: 200, body: { cityName: "Riverside" } })
  })
})
```

`createTestContext(options)` → `{ ctx, lifecycle, core, logs, featureIds, fetch(path, init?), request(method, path, body?) }`. Options: `features`, `bridgeFetch` (default: bridge unreachable; only allowlisted GETs reach it), `env`, `dotenv`, `settingsFile`, `codec`, `rendererDir`, `argv`, `version`, `isPackaged`, `windows` (fakes for `getMainWindow`/`showMainWindow`/`createWindow`/`onMainWindowCreated`; by default creating a window throws). Drive hooks with `t.lifecycle.runReady()`, `runBeforeQuit()`, `shouldQuitWhenAllClosed()`. Web-side tests go in `web/src/test/` with `enableDesktopMode()`.

## `DesktopContext` reference (`src/context.ts`)

```ts
interface DesktopFeature {
  id: string
  beforeReady?(): void                                  // sync, before app ready (command-line switches); no ctx yet
  setup(ctx: DesktopContext): void | Promise<void>
}
defineFeature(feature: DesktopFeature): DesktopFeature

interface DesktopContext {
  readonly version: string                              // app version (= web/package.json version)
  readonly isPackaged: boolean
  readonly platform: NodeJS.Platform
  readonly paths: { userData; logs; renderer; assets; icon: string }   // icon: .ico on Windows, .png elsewhere
  readonly launch: { argv: readonly string[]; hidden: boolean }        // hidden = started with --hidden
  readonly settings: SettingsStore
  readonly routes: RouteRegistry
  readonly bridge: BridgeClient
  readonly log: Logger                                  // debug/info/warn/error(message, ...details), child(scope)
  bridgeConfig(): { bridgeUrl: string; bridgeUrlSource: ConfigSource; tokenSet: boolean; tokenSource: ConfigSource }

  getMainWindow(): BrowserWindow | null                 // null before creation / after close / when launched hidden
  showMainWindow(): BrowserWindow                       // create if needed, restore, show, focus
  createWindow(options?: AppWindowOptions): BrowserWindow
  onMainWindowCreated(listener: (window: BrowserWindow) => void): Unsubscribe   // fires for every (re)created main window

  onReady(hook: () => void | Promise<void>): void       // after all setups and after the main window was created
  onBeforeQuit(hook: () => void | Promise<void>): void  // quit waits for these (max 5 s total)
  onWindowAllClosed(decide: () => "quit" | "keep-running"): Unsubscribe   // any "keep-running" keeps the app alive
  isQuitting(): boolean                                 // true once quitting started
  quit(): void
}

// AppWindowOptions = BrowserWindowConstructorOptions without webPreferences, plus
//   route?: string            page of the web app, default "/"  -> app://cs2mcp/<route>
//   webPreferences?: { backgroundThrottling?, zoomFactor?, spellcheck? }   (the rest is fixed/hardened)
//   showWhenReady?: boolean   default true; pass show: false to keep it hidden

// routes.ts
interface RouteRegistry {
  get(path: string, handler: RouteHandler): void        // path "/desktop/..." (without /api)
  post(path: string, handler: RouteHandler): void
  list(): { method: "GET" | "POST"; path: string }[]
}
type RouteHandler = (req: DesktopRequest) => unknown    // JSON value or promise; undefined answers {"ok":true}
interface DesktopRequest { method; path; query: URLSearchParams; body: unknown; parse<T>(schema: z.ZodType<T>): T }  // parse failure -> 400
class RouteError extends Error { constructor(status: number, message: string) }   // -> {error, status, kind:"companion"}
// A thrown SettingsValidationError or ZodError also answers 400; anything else 500.

// settings.ts
interface SettingsStore {
  define<T>(key: string, def: { schema: z.ZodType<T>; default: T; secret?: boolean; expose?: boolean }): Setting<T>
  get(key): value;  set(key, value): Promise<void>;  onChange(key, (value, previous) => void): Unsubscribe
  isDefined(key): boolean;  toPublic(): Record<string, unknown>;  update(patch: unknown): Promise<void>
  readonly secretsEncrypted: boolean;  flush(): Promise<void>
}
interface Setting<T> { key; get(): T; set(value: unknown): Promise<void>; reset(): Promise<void>; onChange(listener): Unsubscribe }

// bridge.ts
interface BridgeClient { get<T>(path: string, params?: Record<string, string | number | boolean | undefined>): Promise<T> }
class BridgeError extends Error { status: number; kind: "unreachable" | "bridge" | "companion" }
```

Settings store details: JSON at `<userData>/settings.json` (`{ "version": 1, "values": { … } }`), written atomically (temp file + rename, writes serialized), a corrupt file is moved aside as `settings.json.corrupt-<time>` and defaults are used, stored values that fail their schema fall back to the default, keys nobody defines are preserved. `set()` applies in memory and notifies listeners synchronously, then persists (await it to know it hit the disk). `secret: true` values (schema must yield `string | null`) are encrypted with Electron `safeStorage` (async API) and appear to the renderer only as `<key>Set: boolean`; without an OS keystore they are stored as plain text and `secretsEncrypted` is false. `expose: false` keeps a key out of the settings routes. To type `store.get("<id>.<key>")` add `declare module "../settings.ts" { interface SettingValues { "<id>.<key>": T } }` in your feature; the handle from `define()` is already typed. Core keys: `bridgeUrl`, `token` (secret), `window.main` (not exposed).

## Recipes for the planned features

- **Tray / close to tray**: `ctx.onWindowAllClosed(() => "keep-running")` and hide instead of closing:
  `ctx.onMainWindowCreated((win) => win.on("close", (e) => { if (!ctx.isQuitting()) { e.preventDefault(); win.hide() } }))`. Tray "Open" → `ctx.showMainWindow()`, "Quit" → `ctx.quit()`. Icon: `ctx.paths.icon` (or files you add under `assets/`, copied to `dist/assets`).
- **Overlay window**: `ctx.createWindow({ route: "/overlay", width: 360, height: 220, alwaysOnTop: true, frame: false, skipTaskbar: true })`. The page is a normal TanStack route in `web/src/routes/` (the SPA fallback serves it). Global hotkey: `globalShortcut.register` in `onReady`, `globalShortcut.unregisterAll()` in `onBeforeQuit`.
- **Background polling / notifications / trend recorder**: `ctx.bridge.get(...)` from a timer started in `onReady`; it works with no window open. Only the allowlisted read-only routes are reachable. Files go under `ctx.paths.userData`. Windows toast notifications use the AppUserModelID set by the core.
- **Start with Windows / hidden start**: `app.setLoginItemSettings({ openAtLogin, args: ["--hidden"] })`; with `--hidden` the main window is not created (`ctx.launch.hidden`), so pair it with the tray. In dev, the login item would start bare `electron.exe`: only enable it when `ctx.isPackaged`.
- **Settings page**: a web route that reads `GET /api/desktop/settings` and writes with `apiPost("/desktop/settings", patch)`; `useDesktop()` decides whether to show it. Feature settings appear there automatically under their namespaced keys.
- **Packaging / auto-update**: package `dist/**` and `package.json` (`main` is `dist/main.cjs`); icon `assets/icon.ico`; app id `com.cs2mcp.companion`, product name from `productName`. Nothing else is needed at runtime. Keep `desktop/package.json` `version` equal to `web/package.json` (a test enforces it).

## Testing

- `npm test` (in `desktop/`): settings store, route registry, config precedence, lifecycle, the `app://` handler (static, CSP, proxy, Origin check, settings routes), `ctx.bridge`, version parity, and the README feature example. No Electron needed.
- `npm run smoke`: builds, starts `scripts/stub-bridge.mjs` on a free port, launches Electron with `CS2_BRIDGE_URL` pointing at it, a throwaway profile and `--remote-debugging-port`, then drives the window over the DevTools protocol: dashboard shows the stub city, no Node in the renderer, CSP blocks inline scripts, `/api/desktop/info`, `POST /api/build/road` refused before the bridge, no token in `/api/desktop/settings`, settings POST/validation, `window.open` denied, navigation blocked, single instance, clean quit, saved window state. Options: `--screenshot <file.png>`, `--verbose`. It never contacts a real bridge. Add a check there when your feature has visible end-to-end behaviour.
