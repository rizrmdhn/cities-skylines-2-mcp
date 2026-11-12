#!/usr/bin/env node
/**
 * A tiny stand-in for the CS2MCP bridge with a fixed city ("Riverside"), so the desktop app can
 * be run and tested without the game. Answers GET /ping, /state, /city/overview, /city/demand and
 * /history; any other path answers 503 with a bridge-style error. Records every request.
 *
 * /history holds a realistic log (three AI sessions: a batch with a failed part, a failed zoning,
 * refused requests, positions on the map), timed relative to now so the newest session is "live".
 * Tests can replace it: `stub.setHistory(entriesNewestFirst)` (the bridge's order).
 *
 *   node scripts/stub-bridge.mjs [port]     run it on its own (default port: any free one)
 *   import { startStubBridge } from "./stub-bridge.mjs"
 */
import { createServer } from "node:http"
import { readFileSync } from "node:fs"
import { pathToFileURL } from "node:url"

const VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version

export const CITY_NAME = "Riverside"

const FIXTURES = {
  "/ping": {
    ok: true,
    mod: "CS2MCP",
    version: VERSION,
    gameMode: "Game",
    isLoading: false,
    bridgeEnabled: true,
    readOnly: false,
  },
  "/state": {
    gameMode: "Game",
    isLoading: false,
    cityLoaded: true,
    cityName: CITY_NAME,
    simulation: {
      paused: false,
      selectedSpeed: 1,
      effectiveSpeed: 1,
      gameDateTime: "2026-03-14 08:30",
      forcedPause: null,
    },
  },
  "/city/overview": {
    cityName: CITY_NAME,
    population: 12345,
    populationWithMoveIn: 12500,
    averageHappiness: 63,
    averageHealth: 71,
    money: 1_500_000,
    xp: 4200,
    gameDateTime: "2026-03-14 08:30",
    simulationPaused: false,
    simulationSpeed: 1,
  },
  // A land-value layer and a few roads around the places the sample history builds at, for the map.
  "/city/gridmap": {
    layer: "landValue",
    textureSize: 16,
    worldMin: -7168,
    worldMax: 7168,
    cellSize: 896,
    unit: "land value per cell",
    values: Array.from({ length: 256 }, (_, i) => {
      const x = (i % 16) - 8
      const z = Math.floor(i / 16) - 8
      return Math.max(0, Math.round(100 - Math.hypot(x + 0.5, z + 0.5) * 9))
    }),
  },
  "/city/road-network": {
    roadCount: 6,
    junctionCount: 2,
    roads: [
      [-600, -200, -400, -200, -200, -200, 80, 0],
      [-200, -200, -50, -200, 100, -200, 55, 0],
      [100, -200, 100, -25, 100, 150, 25, 0],
      [100, 150, 300, 150, 500, 150, 70, 0],
      [-400, -400, -400, -150, -400, 100, 90, 0],
      [-120, 220, -10, 185, 100, 150, 60, 0],
    ],
    junctions: [
      [-200, -200, 0],
      [100, 150, 1],
    ],
  },
  "/city/demand": {
    residential: { householdDemand: 40, buildingDemand: { lowDensity: 200, mediumDensity: 120, highDensity: 30 } },
    commercial: { companyDemand: 10, buildingDemand: 90 },
    industrial: { companyDemand: 5, buildingDemand: 140 },
    office: { companyDemand: 0, buildingDemand: 12 },
  },
}

/**
 * The bridge's change log the way BridgeSystem.Session.cs writes it: ids count up in completion
 * order, `timeUtc` is when the operation started, a batch's parts come before the batch entry.
 * Newest first. `now` is the newest session's last request.
 */
export function sampleHistory(now = Date.now()) {
  /** @type {any[]} */
  const log = []
  let id = 0
  const min = 60_000
  const iso = (/** @type {number} */ ms) => new Date(Math.floor(ms / 1000) * 1000).toISOString().replace(/\.\d+Z$/, "Z")
  const game = (/** @type {number} */ ms) => {
    const date = new Date(Date.UTC(2026, 2, 14, 8, 0) + (ms - (now - 200 * min)) * 20)
    return date.toISOString().slice(0, 16).replace("T", " ")
  }
  /** @param {number} at @param {string} path @param {Record<string,string>} query @param {object} [extra] */
  const add = (at, path, query, extra = {}) =>
    log.push(
      /** @type {any} */ ({
        id: ++id,
        timeUtc: iso(at),
        gameTime: game(at),
        path,
        query,
        status: 200,
        ok: true,
        batchChild: false,
        moneyDelta: 0,
        result: '{"ok":true}',
        ...extra,
      })
    )

  // Session 1, about three hours ago.
  let t = now - 190 * min
  add(t, "/city/taxes/set", { area: "residential", rate: "11" })
  add((t += 2 * min), "/build/road", { prefab: "Medium Road", x1: "-600", z1: "-200", x2: "-200", z2: "-200" }, { moneyDelta: -18000, result: '{"built":true,"segments":2}' })
  add((t += 90_000), "/build/zone", { cx: "-400", cz: "-100", zone: "Residential", radius: "120" }, { moneyDelta: -2000, result: '{"zoned":148}' })
  add((t += 3 * min), "/build/zone", { cx: "5200", cz: "5200", zone: "Industrial", radius: "80" }, { ok: false, status: 400, result: '{"error":"area is not zonable"}' })
  add((t += 2 * min), "/build/place", { prefab: "ElementarySchool01", x: "-350", z: "-60" }, { moneyDelta: -48000, result: '{"placed":true,"building":{"index":901,"version":1}}' })

  // Session 2, about 45 minutes ago: a batch with a refused part, a tax change in between.
  t = now - 48 * min
  const batchStart = t
  add((t += 5000), "/build/road/connect", { prefab: "Small Road", x1: "-200", z1: "-200", x2: "100", z2: "-200" }, { batchChild: true, moneyDelta: -9000 })
  add((t += 6000), "/build/road/connect", { prefab: "Small Road", x1: "100", z1: "-200", x2: "100", z2: "150" }, { batchChild: true, moneyDelta: -7000 })
  add((t += 4000), "/city/taxes/set", { area: "commercial", rate: "10" })
  add((t += 5000), "/build/road/connect", { prefab: "Small Road", x1: "100", z1: "150", x2: "500", z2: "150" }, { batchChild: true, ok: false, status: 400, result: '{"error":"segment overlaps a building"}' })
  add(batchStart, "/build/batch", {}, { moneyDelta: -16000, result: '{"ok":false,"total":3,"ran":3,"succeeded":2,"failed":1}' })
  add((t += 4 * min), "/build/place", { prefab: "Park01", x: "180", z: "-120" }, { moneyDelta: -5000 })
  add((t += 2 * min), "/build/place", { prefab: "FireStation01", x: "300", z: "80" }, { moneyDelta: -32000 })
  add((t += 90_000), "/build/demolish", { x: "420", z: "260" }, { ok: false, status: 404, result: '{"error":"nothing to demolish at this position"}' })

  // Session 3, the last few minutes.
  t = now - 7 * min
  add(t, "/build/place", { prefab: "PoliceStation01", x: "-120", z: "220" }, { moneyDelta: -41000 })
  add((t += 80_000), "/build/road", { prefab: "Small Road", x1: "-120", z1: "220", x2: "100", z2: "150" }, { moneyDelta: -6000 })
  add((t += 2 * min), "/city/taxes/set", { area: "residential", rate: "9" })
  add((t += 90_000), "/build/place", { prefab: "Park01", x: "-60", z: "260" }, { moneyDelta: -5000 })

  return log.reverse()
}

/** @param {readonly { moneyDelta: number }[]} log newest first @param {number} limit */
function historyPayload(log, limit) {
  const spent = log.reduce((sum, entry) => sum + Math.max(0, -entry.moneyDelta), 0)
  const entries = log.slice(0, limit)
  return {
    sessionSpent: spent,
    spendingLimit: 400000,
    spendingLimitRemaining: Math.max(0, 400000 - spent),
    spendingLimitSource: "game options",
    batchRunning: false,
    total: log.length,
    returned: entries.length,
    entries,
  }
}

/** Starts the stub on 127.0.0.1:`port` (0 = any free port). */
export function startStubBridge(port = 0) {
  /** The change log, newest first. */
  let history = sampleHistory()
  /** @type {{ method: string, url: string, headers: import("node:http").IncomingHttpHeaders }[]} */
  const requests = []
  const server = createServer((req, res) => {
    requests.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers })
    const url = new URL(req.url ?? "/", "http://stub.invalid")
    const path = url.pathname
    const limit = Number(url.searchParams.get("limit") ?? Infinity)
    const body =
      req.method !== "GET" ? undefined : path === "/history" ? historyPayload(history, limit) : FIXTURES[path]
    res.writeHead(body ? 200 : 503, { "Content-Type": "application/json" })
    res.end(JSON.stringify(body ?? { error: `${req.method} ${path} is not part of the stub bridge` }))
  })
  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      const { port: actual } = /** @type {import("node:net").AddressInfo} */ (server.address())
      resolve({
        url: `http://127.0.0.1:${actual}`,
        requests,
        /** Replaces the /history log (entries newest first, like the bridge). */
        setHistory: (/** @type {any[]} */ entries) => {
          history = entries
        },
        close: () => new Promise((done) => server.close(() => done(undefined))),
      })
    })
  })
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const stub = await startStubBridge(Number(process.argv[2] ?? 0))
  console.log(`stub bridge on ${stub.url} (Ctrl+C to stop); run the app with CS2_BRIDGE_URL=${stub.url}`)
}
