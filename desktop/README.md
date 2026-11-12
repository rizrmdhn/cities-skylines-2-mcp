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

To see it work without the game: `node scripts/stub-bridge.mjs` prints a URL; start the app with `CS2_BRIDGE_URL=<that url>`. The stub runs a simulation clock (frame, game date and the city figures advance with real time x the selected speed and stand still while paused; `stub.sim.frame` / `.cityName` / `.cityLoaded` can be set by tests), so the Trends page fills with moving data.

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
| `src/features/app-folders.ts` | built-in feature: opens the log / settings folder (settings page, About) | lazily, only when opening |
| `src/features/trends.ts` | trend recorder + `/api/desktop/trends*` (see "Trend history") | no |

Modules marked "no" must stay importable in plain Node: tests load them. Import Electron only with `import type` there.

### Window and renderer hardening

Every window (main and feature windows) gets `contextIsolation`, `sandbox`, no `nodeIntegration`, no `<webview>`, no preload, devtools only when not packaged. App-wide: navigation and redirects away from `app://cs2mcp` are cancelled in every frame (http(s) targets open in the system browser instead; other schemes are dropped and logged), `window.open` never creates a window, permission requests/checks are denied except `clipboard-sanitized-write` (the map's "copy prompt" button). HTML responses carry this CSP (`app-protocol.ts`):

```
default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:;
font-src 'self' data:; connect-src 'self'; worker-src 'self' blob:; object-src 'none'; base-uri 'none';
form-action 'none'; frame-src 'none'; frame-ancestors 'none'
```

`/api/*` requests with an `Origin` other than `app://cs2mcp` are refused (403). (Unlike the browser companion the app does not *require* an Origin on the control POST: Electron sends none on same-origin `app://` requests. Nothing but the app's own locked-down windows can reach the handler.) The renderer talks to the main process **only through `fetch`**; do not add a preload or IPC.

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
| `GET /api/desktop/app-folders` | `{ "logs": "<path>", "settings": "<path>" }`, the fixed folders (feature `app-folders`) |
| `POST /api/desktop/app-folders/open-logs`, `.../open-settings` | opens that folder in the file manager; takes no path (the body is ignored); 500 with the shell's message when it cannot |

A refused `POST /api/desktop/settings` also carries `issues`, one entry per rejected key, so a page can put each message next to its field: `{ "error": "bridgeUrl: must be an http:// or https:// URL", "status": 400, "kind": "companion", "issues": [{ "key": "bridgeUrl", "message": "must be an http:// or https:// URL" }] }` (`key: null` when the body as a whole is wrong; `ApiError.body` holds it on the web side).

The bridge proxy on `/api/<bridge route>`: GET on the read allowlist, plus the one control route `POST /api/sim/control?speed=0..8&paused=true|false` (pause / resume / speed buttons in the header, `web/src/components/sim-controls.tsx`); both lists live in `web/server/routes.ts`, which documents how to add a control route. `apiControl()` in `web/src/lib/api.ts` is the web side of it. Every other POST is refused with 405 before the bridge.

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

## Trend history (`src/features/trends.ts`, page `/trends`)

The bridge only knows the present, so the main process records how the city develops and the **Trends** page (`web/src/features/trends/`, nav item only inside the desktop app; the browser companion shows an "available in the desktop app" note) charts it. Recording runs in the background whether or not a window is open.

**Recorder.** One tick every `trends.intervalSeconds` (default 60, 10 to 3600). Each tick asks `GET /state` (cheap). Only when a city is loaded, not loading, not paused and the simulation frame moved since the newest stored sample does it also ask `/city/overview`, `/city/demand` and `/city/budget`, one after the other (the bridge answers on the game's main thread): 4 requests per sample, 1 per tick otherwise. No city: one `/state` every 30 s at most. Bridge unreachable or failing: the pause doubles per failure up to 5 minutes (never shorter than the interval) and the recording stretch is closed. A paused game records nothing, so a pause never produces duplicate samples (money spent while paused shows with the first sample after resuming).

**Metrics.** `population`, `money`, `happiness` and `health` (the averages), `xp` from `/city/overview`; the six `buildingDemand` values (residential low/medium/high, commercial, industrial, office) from `/city/demand`; `income` and `expenses` (the game's monthly rates, updated hourly) from `/city/budget`, which is why that read-only route is on the allowlist in `web/server/routes.ts`. A route a bridge does not have just leaves its metrics out.

**Time axes.** Every sample stores the wall-clock time `t` and the game clock: the simulation `frameIndex` from `/state` (262144 frames per game day; it stands still while paused, and also during forced pauses) and the game date string. Charts offer *Game time* (default; position = frame, so 8x play and pauses do not distort it) and *Real time*. **Older saves:** a "run" is one uninterrupted recording stretch; a new run starts after an app start, an outage, a switch of city, or when game time goes backwards, which is checked against the previous *poll* as well as the newest stored sample (a save loaded paused and then run at 8x can pass the old frame before the next sample). On the game axis a run that starts earlier in game time hides the abandoned future of the runs before it (those samples stay on disk and on the real-time axis); lines are broken between runs.

**City identity and its limit.** The bridge only exposes the city *name*, so a series is keyed by the name (`<slug>-<hash of the exact name>`). Renaming a city starts a new series; two different saves with the same name share one series (their game times interleave as separate runs). Nothing better is available from `/state` or `/city/overview`.

**Storage.** `<userData>/trends/<city key>.jsonl`, append-only, line 1 `{"trends":1,"city":"<name>"}`, then one JSON object per sample with short keys: `t` (ms), `s` (run), `f` (frame), `g` (game date), `pop money hap hlt xp inc exp dRl dRm dRh dC dI dO`. A sample is one `appendFile` of one full line, so a crash leaves at most one torn last line, which is skipped on load (the next append starts on a fresh line). Unreadable lines are skipped and the file is rewritten (temp file + rename); a file with nothing readable is moved aside as `*.corrupt-<time>`. **Bounded:** samples older than `trends.retentionDays` (default 365, 0 = keep) are dropped, and a city holds at most 10 000 samples (about 2 MB): past that the older half is thinned 2:1 repeatedly, keeping the first and last sample of every run, so old history gets sparser but never unbounded.

| route | answer |
| --- | --- |
| `GET /api/desktop/trends` | recorder status: `state` (`recording`, `paused`, `no-city`, `unreachable`, `error`, `disabled`, `starting`), `city`, `lastSampleAt`, `sessionSamples`, `nextPollAt`, `error`, `consecutiveFailures`, the settings `enabled` / `intervalSeconds` / `retentionDays`, `maxSamplesPerCity`, `bytes` on disk |
| `GET /api/desktop/trends/cities` | `{ cities: [{ key, name, samples, firstAt, lastAt, firstGame, lastGame }] }`, newest first |
| `GET /api/desktop/trends/series?city=<key>&axis=game or real&from=&to=&last=&points=` | `{ city, metrics, framesPerDay, axis, extent, from, to, samples, points }`. Range in axis units (frames or ms); `last` = the newest N units. `points` (default 600, 0 = every sample) reduces the range to equal buckets of mean values; each point has `x`, `t`, `frame`, `game`, `run`, `gap` and one field per metric (`null` = not recorded). 404 for a city without data |
| `POST /api/desktop/trends/clear` | body `{ "city": "<key>" }` or `{ "all": true }`; answers `{ cleared }` |

Settings (also in `GET/POST /api/desktop/settings`, so a settings page picks them up): `trends.enabled`, `trends.intervalSeconds`, `trends.retentionDays`. The Trends page edits the first two itself and has the confirmed "Clear data" action and the CSV export (a Blob and a temporary `<a download>`; it does not use a shared desktop download path).

**Charts: hand-written SVG, no dependency.** shadcn's chart component means Recharts; a minimal Recharts line chart bundles to about 375 KB (113 KB gzip) before the shadcn wrapper, for seven small line charts. `web/src/features/trends/trend-chart.tsx` draws them directly: gaps between runs, game-date tick labels, theme-aware colours through Tailwind `text-*` classes, hover and keyboard (arrow keys) cursor with tooltip. Inline SVG needs nothing from the CSP.

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

## The settings page and adding a settings section

`/settings` (web: `src/routes/settings.tsx`, `src/features/settings/`) exists only in the desktop app: the header shows its nav item only when `useDesktop().isDesktop`, and in the browser companion the route shows a short "available in the desktop app" empty state without asking for any settings. It stacks cards in this order: **Connection** (bridge URL and write-only token, explicit Save, "Test connection" through the proxy, env-wins explanation, "Reset to default"), **Appearance** (theme), the **sections of the desktop features** (below), **About** (versions, platform, packaged or dev, active features, "Open log folder" / "Open settings folder" via the `app-folders` feature, which opens fixed paths only). Saving the bridge URL or token takes effect at once: the app drops every cached bridge answer (`resetBridgeQueries`) and runs the connection test.

### Adding a settings section

A feature that has settings adds **one file** `web/src/features/settings/sections/<id>.tsx` and **one line** in `web/src/features/settings/sections/index.ts` (alphabetical, export name = camelCase id). The page renders the section only when `GET /api/desktop/info` lists `<id>` in `features` (so a feature that failed to start shows nothing). Toggles, selects and typed-in values save **immediately** (no Save button); the keys are the namespaced settings the feature defined with `ctx.settings.define("<id>.<name>", …)` in the main process.

**1. Main process** (`src/features/city-watch.ts`, next to `city-watch.intervalSeconds` above): define the keys the section edits. The schema is the single source of truth: a refused value comes back as a 400 whose message is shown next to the field.

```ts
ctx.settings.define("city-watch.enabled", { schema: z.boolean(), default: true })
```

**2. The section** `web/src/features/settings/sections/city-watch.tsx` (verbatim in `web/src/test/city-watch-section.example.tsx`, which `tsc` checks against the real API; `desktop/test/settings-section-readme.test.ts` keeps this README in step with it):

```tsx
import { EyeIcon } from "lucide-react"

import { FieldGroup } from "@/components/ui/field"
import { defineSettingsSection } from "@/features/settings/define-section"
import { NumberRow, SwitchRow } from "@/features/settings/fields"
import { useSetting } from "@/features/settings/use-settings"

function CityWatchSettings() {
  // The fallback gives the type and is what the row shows until the settings have loaded.
  const enabled = useSetting("city-watch.enabled", true)
  const interval = useSetting("city-watch.intervalSeconds", 60)
  return (
    <FieldGroup>
      <SwitchRow setting={enabled} label="Watch the city" description="Poll the bridge in the background." />
      <NumberRow
        setting={interval}
        label="Check every"
        description="How often the city is polled."
        min={5}
        max={3600}
        unit="seconds"
        disabled={!enabled.value}
      />
    </FieldGroup>
  )
}

export default defineSettingsSection({
  id: "city-watch", // the desktop feature's id
  title: "City watch",
  description: "Background polling of the city.",
  icon: EyeIcon,
  component: CityWatchSettings,
})
```

**3. Register it**, one line in `web/src/features/settings/sections/index.ts` (replace the `export {}` placeholder the first time):

```ts
export { default as cityWatch } from "./city-watch"
```

The page adds the card (title, description, icon, anchor `/settings#city-watch`; a section that throws shows an error card and leaves the page alone). Import only from `@/features/settings/define-section`, `fields` and `use-settings`; never from `registry.ts` (it imports every section).

**API** (all in `web/src/features/settings/`):

```ts
// define-section.ts
defineSettingsSection(section: SettingsSectionDefinition): SettingsSectionDefinition   // throws unless id is kebab-case
interface SettingsSectionDefinition { id: string; title: string; description?: string; icon?: LucideIcon; component: ComponentType }
// registry.ts (used by the page; tests can vi.mock("@/features/settings/sections"))
registeredSettingsSections(): SettingsSectionDefinition[]
activeSettingsSections(features: readonly string[], sections?: readonly SettingsSectionDefinition[]): SettingsSectionDefinition[]

// use-settings.ts
useSetting<T>(key: string, fallback: T): SettingField<T>
interface SettingField<T> {
  key: string
  value: T                    // optimistic while a save is in flight; `fallback` until loaded
  available: boolean          // false until loaded, and when no feature defines the key (rows disable themselves)
  save(value: T): Promise<boolean>   // POST { [key]: value }; resolves false when refused
  status: "idle" | "saving" | "saved" | "error"
  error: string | undefined   // the 400 body's message for this key
  clearError(): void
}
useSaveSettings(): { save(patch: Record<string, unknown>): Promise<boolean>; saving: boolean; saved: boolean;
                     issues: { key: string | null; message: string }[]; errorFor(key: string): string | undefined; clearError(): void }
useDesktopSettings()          // useQuery of GET /api/desktop/settings, only in the desktop app
settingIssues(error: unknown): { key: string | null; message: string }[]   // per-key issues of a failed save

// fields.tsx: every row takes `setting`, `label`, optional `description` and `disabled`
SwitchRow({ setting: SettingField<boolean>, … })                               // saves when toggled
SelectRow<T extends string>({ setting: SettingField<T>, options: { value: T; label: string }[], … })   // saves when picked
NumberRow({ setting: SettingField<number>, min?, max?, step?, unit?, … })      // saves on Enter / blur; Escape reverts; checks the range first
TextRow({ setting: SettingField<string | null>, placeholder?, validate?(value): string | undefined, … })  // empty saves null
HotkeyRow({ setting: SettingField<string | null>, … })                         // records a key combination as an Electron accelerator ("CommandOrControl+Shift+O"); null clears
Hotkey({ accelerator })  SaveIndicator({ status })
```

Behaviour you get for free: optimistic update with rollback of just that key when the save is refused, `Saving…` / `Saved` next to the label, the per-field message (`role="alert"`, linked with `aria-describedby`, `aria-invalid`), keyboard operation, narrow layouts. A value type that can be cleared must allow `null` in the main-process schema (`z.string().nullable()`). For a hotkey, `HotkeyRow` only captures the accelerator; registering it (and reporting "already used by another application") is the feature's job: a schema cannot know whether the OS accepts it, so validate the format in the schema (a `.refine`) and report conflicts in the feature's own status instead.

**Testing a section** (web side, `web/src/test/settings-sections.test.tsx` is the model): `vi.mock("@/features/settings/sections", …)` with your section, `mockDesktopSettings({ values: {"city-watch.enabled": true}, features: ["city-watch"], validate: {"city-watch.intervalSeconds": (v) => … message or undefined} })` from `web/src/test/desktop-settings.ts` (an in-memory stand-in for `GET/POST /api/desktop/settings` with the real 400 shape, `posts` and `responses` for assertions, and desktop mode switched on), then `renderApp("/settings")`.

## Recipes for the planned features

- **Tray / close to tray**: `ctx.onWindowAllClosed(() => "keep-running")` and hide instead of closing:
  `ctx.onMainWindowCreated((win) => win.on("close", (e) => { if (!ctx.isQuitting()) { e.preventDefault(); win.hide() } }))`. Tray "Open" → `ctx.showMainWindow()`, "Quit" → `ctx.quit()`. Icon: `ctx.paths.icon` (or files you add under `assets/`, copied to `dist/assets`).
- **Overlay window**: `ctx.createWindow({ route: "/overlay", width: 360, height: 220, alwaysOnTop: true, frame: false, skipTaskbar: true })`. The page is a normal TanStack route in `web/src/routes/` (the SPA fallback serves it). Global hotkey: `globalShortcut.register` in `onReady`, `globalShortcut.unregisterAll()` in `onBeforeQuit`.
- **Background polling / notifications / trend recorder**: `ctx.bridge.get(...)` from a timer started in `onReady`; it works with no window open. Only the allowlisted read-only routes are reachable (`ctx.bridge` is GET only; the control POST exists only for the renderer). Files go under `ctx.paths.userData`. Windows toast notifications use the AppUserModelID set by the core.
- **Start with Windows / hidden start**: `app.setLoginItemSettings({ openAtLogin, args: ["--hidden"] })`; with `--hidden` the main window is not created (`ctx.launch.hidden`), so pair it with the tray. In dev, the login item would start bare `electron.exe`: only enable it when `ctx.isPackaged`.
- **Settings page**: exists (see "The settings page and adding a settings section"); give your feature a section there instead of a page of your own.
- **Packaging / auto-update**: package `dist/**` and `package.json` (`main` is `dist/main.cjs`); icon `assets/icon.ico`; app id `com.cs2mcp.companion`, product name from `productName`. Nothing else is needed at runtime. Keep `desktop/package.json` `version` equal to `web/package.json` (a test enforces it).

## Testing

- `npm test` (in `desktop/`): settings store, route registry, config precedence, lifecycle, the `app://` handler (static, CSP, proxy, Origin check, settings routes), `ctx.bridge`, version parity, and the README feature example. No Electron needed.
- `npm run smoke`: builds, starts `scripts/stub-bridge.mjs` on a free port, launches Electron with `CS2_BRIDGE_URL` pointing at it, a throwaway profile and `--remote-debugging-port`, then drives the window over the DevTools protocol: dashboard shows the stub city, no Node in the renderer, CSP blocks inline scripts, `/api/desktop/info`, `POST /api/build/road` refused before the bridge, a real click on the 8× button reaches the stub as `POST /sim/control?speed=8` and shows in the UI (invalid control calls refused before the bridge), the trend recorder saved samples from the stub and the Trends page draws them, no token in `/api/desktop/settings`, settings POST/validation, `window.open` denied, navigation blocked, single instance, clean quit, saved window state. Options: `--screenshot <file.png>`, `--verbose`. It never contacts a real bridge. Then `scripts/smoke-settings.mjs` starts a second app (own profile seeded with stub A's URL, no environment overrides) and drives the real settings page: the header's Settings item, the saved URL and its source, changing the URL to stub B and setting a token through the form, the whole app switching to B, B receiving the token, and no response body, page text or log containing it; `--settings-screenshots <dir>` saves PNGs of the page (wide/narrow, light/dark). Add a check there when your feature has visible end-to-end behaviour.
