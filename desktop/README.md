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
| `npm run icons` | regenerates `assets/icon.ico` / `icon.png` and the tray status icons `tray-*.png` from the favicon design (committed; rerun only when the favicon changes) |

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
| `src/features/save-file.ts` | built-in feature: `POST /api/desktop/save-file`, a native "Save as" dialog for files the page generated (PNG export) | lazily, only when saving |
| `src/features/settings-api.ts` | built-in feature: `GET/POST /api/desktop/settings` | no |
| `src/features/app-folders.ts` | built-in feature: opens the log / settings folder (settings page, About) | lazily, only when opening |
| `src/features/tray.ts` | tray icon, status tooltip, control menu, close-to-tray (see "System tray") | no (Electron loaded lazily) |
| `src/features/overlay.ts` | always-on-top mini overlay window, global hotkey, `/api/desktop/overlay*` (see "Overlay") | no (Electron loaded lazily) |
| `src/features/trends.ts` | trend recorder + `/api/desktop/trends*` (see "Trend history") | no |

Modules marked "no" must stay importable in plain Node: tests load them. Import Electron only with `import type` there.

### Window and renderer hardening

Every window (main and feature windows) gets `contextIsolation`, `sandbox`, no `nodeIntegration`, no `<webview>`, no preload, devtools only when not packaged. App-wide: navigation and redirects away from `app://cs2mcp` are cancelled in every frame (http(s) targets open in the system browser instead; other schemes are dropped and logged), `window.open` never creates a window, permission requests/checks are denied except `clipboard-sanitized-write` (the map's "copy prompt" button and the export card's "Copy image": `navigator.clipboard.write` of a PNG is a sanitized write, so no wider permission was added). HTML responses carry this CSP (`app-protocol.ts`):

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

| `POST /api/desktop/save-file` | body `{ "name": "Riverside-land-value-2026-03-14.png", "data": "<base64>" }` → `{ "status": "saved", "path": "<file>" }` after the user picked a place, or `{ "status": "cancelled" }` (feature `save-file`, below) |

A refused `POST /api/desktop/settings` also carries `issues`, one entry per rejected key, so a page can put each message next to its field: `{ "error": "bridgeUrl: must be an http:// or https:// URL", "status": 400, "kind": "companion", "issues": [{ "key": "bridgeUrl", "message": "must be an http:// or https:// URL" }] }` (`key: null` when the body as a whole is wrong; `ApiError.body` holds it on the web side).

The bridge proxy on `/api/<bridge route>`: GET on the read allowlist, plus the one control route `POST /api/sim/control?speed=0..8&paused=true|false` (pause / resume / speed buttons in the header, `web/src/components/sim-controls.tsx`); both lists live in `web/server/routes.ts`, which documents how to add a control route. `apiControl()` in `web/src/lib/api.ts` is the web side of it. Every other POST is refused with 405 before the bridge.

### Saving files (feature `save-file`, `web/src/lib/download.ts`)

Pages save generated files with `downloadBlob(blob, filename): Promise<{ status: "saved"; path?: string } | { status: "cancelled" }>` from `web/src/lib/download.ts`. In a browser it clicks a hidden `<a download>` on a Blob URL. In the desktop app (`/api/desktop/info` lists `save-file`) it sends the bytes as base64 JSON (the route registry takes JSON bodies only) to `POST /api/desktop/save-file`, and the main process shows `dialog.showSaveDialog` on the main window with the file name filled in, opening in the folder used last time (setting `save-file.lastFolder`, not exposed) or, the first time, in Pictures (Downloads for non-image types). Why not leave it to `<a download>`: the renderer has no preload, so the page could not learn whether the user saved or cancelled, and the default dialog would not be ours to shape (start folder, remembered folder, file-type filter). The page never chooses a path: directories in `name` are stripped, only `.png .jpg .webp .svg .csv .json .txt` are written (also checked on the name the user typed), one dialog at a time (409), at most 256 MB (413), a write failure is a 500 with the system's message. Failures reach the caller as `ApiError`, which the export card shows as an error toast. `CS2MCP_DESKTOP_SAVE_DIR=<folder>` skips the dialog and writes into that folder (for scripted runs); it does not update the remembered folder.

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

## System tray (`src/features/tray.ts`)

A tray icon that shows whether the companion reaches the game, plus a small menu and close-to-tray. It is created in `onReady`, so it works when the app was launched with `--hidden` (`ctx.launch.hidden`): there is no main window yet and "Open companion" (or a double click) creates it. If the tray cannot be created the error is logged and the app behaves as before (closing the window quits).

**Icon and tooltip.** Three variants of the app icon with a status dot, generated by `scripts/make-icons.mjs` into `assets/tray-<name>.png` (16 px) plus `@1.5x` (24) and `@2x` (32) that Electron picks by display scale: `connected` (city loaded, green dot), `no-city` (amber: connected without a city, game loading, bridge turned off in the game) and `offline` (greyed, red dot: bridge unreachable or token rejected). The tooltip carries the city name and speed (`Riverside — 2×` / `paused`) or the reason. The status uses the vocabulary of `web/src/lib/connection.ts` (`ready`, `no-city`, `loading`, `disabled`, `unauthorized`, `unreachable`).

**Polling.** `GET /ping`, then `GET /state` only when the bridge is up and enabled, through `ctx.bridge`: every 5 s while a city is loaded, every 10 s otherwise; while the bridge is down 5 s doubling to 60 s (reset by the first answer). A change of bridge URL or token and every menu action probe at once. Nothing but those two routes is read (no `/city/*`).

**Menu.** Open companion; a disabled status line (`Riverside — 2× speed`, `Not connected to the game`, …); Pause / "Resume at 2×" (the last running speed); Speed ▸ 1× 2× 4× 8× (radio, the current one checked); "Start with Windows" (only when a boolean setting `startup.openAtLogin` is defined by another feature, see below; clicking it sets that setting); Quit (`ctx.quit()`). Pause and Speed are disabled while the bridge reports read-only mode, no city is loaded or the bridge is not connected; a failed control call is logged and shown as a balloon.

**How the tray sends control requests.** `ctx.bridge` gained `control(path, params)`, next to `get`. It calls the same `proxyBridgeRequest` the renderer's `/api` calls use, with method POST: only a path in `CONTROL_ROUTES` (`/sim/control`) is forwarded, every parameter is validated by `validateControlParams` (`speed` 0 to 8, `paused` true/false, unknown or repeated parameters refused), anything else is a `BridgeError` 405/400 before the bridge is contacted, and the bridge itself still refuses it in read-only mode. The allowlist in `web/server/routes.ts` is unchanged (adding a control route there is still the only way to make another one reachable, for the renderer and the main process alike). There is no raw `fetch` to the bridge. `control` changes the running game: call it only from an explicit user action, never from a timer. The tray sends `{ paused: true }`, `{ speed: <last running speed> }` to resume, or `{ speed: 1|2|4|8 }`.

**Close to tray.** Setting `tray.closeToTray` (boolean, default `true`). On: the main window's `close` is cancelled and the window is hidden; the app keeps running (the `onWindowAllClosed` decider answers `keep-running` while a tray icon exists). The first time, a Windows balloon says the app is still in the tray; `tray.hintShown` (not exposed) remembers it. Off: closing the window quits, as without the feature. Quitting (tray menu, `ctx.quit()`, `app.quit()`, Windows logoff or shutdown) is never blocked: the handler lets the window close once `ctx.isQuitting()` is true or the window got `session-end`. A left click on the tray icon shows the window, or hides it when it is visible and not minimized (handled after 300 ms so a double click does not flicker); a double click opens it.

**What it exposes to other features.**
- Closing is handled: a feature does not need its own `close` handler or `onWindowAllClosed` decider to survive a closed window. For a hidden start the game-detection / start-with-Windows feature only has to launch with `--hidden`; the tray is already there.
- `GET /api/desktop/tray` → `{ "present": true, "closeToTray": true, "status": { "state": "ready", "city": "Riverside", "readOnly": false, "paused": false, "speed": 2, "forcedPause": null, "error": null, "checkedAt": 1731400000000 }, "controls": true }` (`present: false` before `onReady` or when no tray could be created).
- **Start with Windows contract:** the checkbox appears when `ctx.settings.isDefined("startup.openAtLogin")` and its value is a boolean (checked at every menu build and on `onChange`, so feature order does not matter). A feature that implements start with Windows should define exactly that key (`z.boolean()`) and apply the change itself in an `onChange` listener; the tray only reads and sets the setting. Without such a feature the item is omitted.
- **Tray menu items:** `contributeToTrayMenu(() => MenuItemConstructorOptions[])` adds items below Speed (a separator is added before them); the callback runs at every menu build, so read live state in it, and call `refreshTrayMenu()` when it would change (the menu is rebuilt only if the labels / state differ). It returns an unsubscribe function. Order of features does not matter. The overlay uses it for "Show overlay".
- Exports for tests and reuse: `probeBridge(bridge)`, `buildMenu`, `tooltipFor`, `statusLine`, `iconFor`, `nextDelayMs`, `createTray(viewFactory)` (inject a fake `TrayView`; the default factory loads Electron lazily).

Settings (also in `GET/POST /api/desktop/settings`): `tray.closeToTray`; the System tray card of the Settings page has the switch (`web/src/features/settings/sections/tray.tsx`).

## The map in the desktop app

The map page (`/map`) works the same in the browser companion and here; two things use desktop features. **Export image** (`web/src/features/map/export-card.tsx`, `export-image.ts`, geometry in `web/src/lib/map-export.ts`) renders the map again at 1×, 2× or 4× through the same `drawMap` as the screen (this view, the built-up area or the whole map; light/dark caption strip or transparent without one) and saves it with `downloadBlob` (native dialog, above) or copies it with `navigator.clipboard.write`. **Follow game camera** polls `/camera` every second while on (every 5 s otherwise, and not at all while the window is hidden), glides the map to the camera's look-at point, and switches itself off when the map is panned or zoomed by hand (a "Follow camera" button on the map turns it back on). The stub bridge (`scripts/stub-bridge.mjs`) answers `/camera`, `/city/gridmap` and `/city/road-network` with made-up data so both can be tried without the game.

## Overlay (`src/features/overlay.ts`, page `/overlay`)

A small always-on-top window with the city at a glance, so a player on one monitor can watch the city without leaving the game: city name and game date, money with a trend arrow (the direction of its last change), population, the residential / commercial / industrial demand bars, the number of warning icons, the latest AI action (one line) and pause / speed buttons (`SimControls`, the same component and `useSimulationControl` hook as the header). When the bridge is offline or no city is loaded it shows the reason instead (same vocabulary as the header badge). It polls like the dashboard (overview and AI history 5 s, demand and warnings 15 s, `/ping` 3 s, `/state` 5 s).

**Window.** `ctx.createWindow({ route: "/overlay", alwaysOnTop: true, frame: false, skipTaskbar: true, focusable: false, … })`, default 340 × 210, resizable from 300 × 190 to 640 × 420, at the `"screen-saver"` always-on-top level (re-asserted at every show). Choices to know:
- **No focus.** `focusable: false`: clicking its buttons does not take the keyboard focus from the game. This matters because the game pauses itself while it is not focused (the header shows that as "Game in background"), which would defeat the pause and speed buttons.
- **Not transparent.** Transparent frameless windows cannot be resized on Windows, so the whole window is made translucent with `setOpacity(overlay.opacity / 100)`. The page draws a solid themed background (light / dark like the rest of the app) and a 5 px non-draggable frame around its content: the rest of the surface drags the window (`-webkit-app-region: drag`; buttons opt out with `no-drag`), the frame is where the resize handles are.
- **Created on show, destroyed on hide** (close button, hotkey, `hide` route). A hidden window would otherwise count as an open window and keep the app alive after the main window closed. Consequence: with close-to-tray off, closing the main window while the overlay is open leaves the app running with the overlay and the tray icon; use Quit in the tray menu.
- **Exclusive fullscreen.** An always-on-top window cannot be drawn over a game in *exclusive* fullscreen (a Windows limit). It shows over windowed and borderless-windowed games: set Cities: Skylines II to "Borderless Windowed" / "Fullscreen Windowed". The settings card says so.
- **Position and size** are saved 750 ms after the last move / resize and on close (`overlay.bounds`, not exposed). On show they are restored with `placeOverlay`: the size is limited to the allowed range and to the display, the position is pulled fully inside the display it overlaps most, and a position that is no longer on any display (unplugged monitor) falls back to the top right of the primary display (16 px margin, also the first placement).
- **Click-through** (`overlay.clickThrough`) is all or nothing: `setIgnoreMouseEvents(true)` for the whole window. An "ignore the mouse unless a modifier is held" mode was not built: the main process cannot read modifier keys while the window is unfocused, and the renderer may not talk to it except through `fetch`, so it could not be made reliable. While click-through is on, the overlay cannot be moved and its buttons do not work; turn it off in Settings.

**Hotkey.** `overlay.hotkey`, default `CommandOrControl+Shift+O`, an Electron accelerator (`null` = no hotkey). `globalShortcut.register` runs in `onReady` and again whenever `overlay.hotkey` or `overlay.enabled` changes (the old accelerator is unregistered first; only our own accelerator is ever unregistered, in `onBeforeQuit`, so other features' shortcuts are untouched). The schema validates the *format* (modifiers + one key; needs a modifier unless it is a function key; `isValidAccelerator`). Whether the OS grants it is only known at registration, and **a failure never throws**: it is logged and reported as `hotkeyError` in `GET /api/desktop/overlay` (`"<accelerator> is already used by another application. Choose another shortcut."`, or `"… is not a shortcut this system accepts. Choose another one."` when Electron rejects it), `hotkeyRegistered` is false, and the Overlay settings card shows the message under the shortcut row. The header button and the tray item work either way.

| route | answer |
| --- | --- |
| `GET /api/desktop/overlay` | `{ "present": true, "enabled": true, "open": false, "hotkey": "CommandOrControl+Shift+O", "hotkeyRegistered": true, "hotkeyError": null, "opacity": 90, "clickThrough": false }` (`present: false` before `onReady` or when Electron's shortcut / screen modules could not be loaded) |
| `POST /api/desktop/overlay/toggle`, `/show`, `/hide` | the same status after the action; the body is ignored. `toggle` and `show` answer 409 while `overlay.enabled` is off and 503 before the app is ready; `hide` always works |

Settings (also in `GET/POST /api/desktop/settings`): `overlay.enabled` (boolean, default true: when off the hotkey is released, the overlay is closed and the header button disappears and the tray item is disabled), `overlay.hotkey` (string or null), `overlay.opacity` (integer percent, 30 to 100, default 90), `overlay.clickThrough` (boolean, default false); `overlay.bounds` is not exposed. The Overlay card of the Settings page (`web/src/features/settings/sections/overlay.tsx`) edits the four, with a `HotkeyRow` and the registration message.

**Entry points.** A header button (`web/src/features/overlay/overlay-button.tsx`, picture-in-picture icon, `aria-pressed` while open, tooltip with the shortcut) shown only in the desktop app when the feature is present and enabled; it calls `/toggle` and re-reads the status every 3 s because the hotkey and the tray change it too. The page itself is `web/src/features/overlay/overlay-view.tsx` on the file route `web/src/routes/overlay.tsx`; the root layout (`__root.tsx`, `BARE_ROUTES`) renders it without header or connection alerts. Add another full-window page the same way: a route, plus its path in `BARE_ROUTES`. In a plain browser `/overlay` is just the same page; it then has no close button.

**Tray.** The overlay adds "Show overlay" / "Hide overlay" (with the shortcut shown next to it) to the tray menu through `contributeToTrayMenu` (see "System tray"); it is disabled while the overlay is off. No tray feature, no item.

Exports for tests and reuse: `createOverlay(platformFactory)` (inject a fake `OverlayPlatform` for `register` / `unregister` / `workAreas` / `primaryWorkArea`; the default loads Electron lazily), `isValidAccelerator`, `placeOverlay`, `OVERLAY_*` constants.

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
interface BridgeClient {
  get<T>(path: string, params?: Record<string, string | number | boolean | undefined>): Promise<T>
  control<T>(path: string, params: Record<string, string | number | boolean | undefined>): Promise<T>   // POST on CONTROL_ROUTES only, validated by the proxy core; for explicit user actions
}
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

- **Tray / close to tray**: done, see "System tray". The recipe it follows: `ctx.onWindowAllClosed(() => "keep-running")` and hide instead of closing:
  `ctx.onMainWindowCreated((win) => win.on("close", (e) => { if (!ctx.isQuitting()) { e.preventDefault(); win.hide() } }))`. Tray "Open" → `ctx.showMainWindow()`, "Quit" → `ctx.quit()`. Icon: `ctx.paths.icon` (or files you add under `assets/`, copied to `dist/assets`).
- **Overlay window**: done, see "Overlay". The recipe it started from: `ctx.createWindow({ route: "/overlay", width: 360, height: 220, alwaysOnTop: true, frame: false, skipTaskbar: true })`. The page is a normal TanStack route in `web/src/routes/` (the SPA fallback serves it). Global hotkey: `globalShortcut.register` in `onReady`, `globalShortcut.unregisterAll()` in `onBeforeQuit`.
- **Background polling / notifications / trend recorder**: `ctx.bridge.get(...)` from a timer started in `onReady`; it works with no window open. Only the allowlisted read-only routes are reachable (`ctx.bridge.get` is GET only; `ctx.bridge.control` sends a control POST through the same allowlist, for explicit user actions only). Files go under `ctx.paths.userData`. Windows toast notifications use the AppUserModelID set by the core.
- **Start with Windows / hidden start**: `app.setLoginItemSettings({ openAtLogin, args: ["--hidden"] })`; with `--hidden` the main window is not created (`ctx.launch.hidden`), so pair it with the tray. In dev, the login item would start bare `electron.exe`: only enable it when `ctx.isPackaged`. Define the boolean setting `startup.openAtLogin` and the tray menu shows a "Start with Windows" checkbox for it.
- **Settings page**: exists (see "The settings page and adding a settings section"); give your feature a section there instead of a page of your own.
- **Packaging / auto-update**: package `dist/**` and `package.json` (`main` is `dist/main.cjs`); icon `assets/icon.ico`; app id `com.cs2mcp.companion`, product name from `productName`. Nothing else is needed at runtime. Keep `desktop/package.json` `version` equal to `web/package.json` (a test enforces it).

## Testing

- `npm test` (in `desktop/`): settings store, route registry, config precedence, lifecycle, the `app://` handler (static, CSP, proxy, Origin check, settings routes), `ctx.bridge`, version parity, and the README feature example. No Electron needed.
- `npm run smoke`: builds, starts `scripts/stub-bridge.mjs` on a free port, launches Electron with `CS2_BRIDGE_URL` pointing at it, a throwaway profile and `--remote-debugging-port`, then drives the window over the DevTools protocol: dashboard shows the stub city, no Node in the renderer, CSP blocks inline scripts, `/api/desktop/info`, `POST /api/build/road` refused before the bridge, a real click on the 8× button reaches the stub as `POST /sim/control?speed=8` and shows in the UI (invalid control calls refused before the bridge), the trend recorder saved samples from the stub and the Trends page draws them, no token in `/api/desktop/settings`, settings POST/validation, `window.open` denied, navigation blocked, single instance, clean quit, saved window state. Options: `--screenshot <file.png>`, `--verbose`. It never contacts a real bridge. Then `scripts/smoke-settings.mjs` starts a second app (own profile seeded with stub A's URL, no environment overrides) and drives the real settings page: the header's Settings item, the saved URL and its source, changing the URL to stub B and setting a token through the form, the whole app switching to B, B receiving the token, and no response body, page text or log containing it; `--settings-screenshots <dir>` saves PNGs of the page (wide/narrow, light/dark). Add a check there when your feature has visible end-to-end behaviour.
