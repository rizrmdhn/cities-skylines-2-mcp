#!/usr/bin/env node
/**
 * A tiny stand-in for the CS2MCP bridge with a city ("Riverside"), so the desktop app can be run
 * and tested without the game. Answers GET /ping, /state, /city/overview, /city/demand,
 * /city/budget and /history, and POST /sim/control (pause / resume / speed 0..8, answered like
 * the real bridge and reflected in /state and /city/overview); any other path answers 503 with a
 * bridge-style error. Records every request.
 *
 * The simulation clock runs: `frameIndex` (and with it the game date, population, money,
 * happiness, demand, ...) advances with real time x the selected speed, and stands still while
 * paused, like the real game. Tests can set `stub.sim.frame`, `.cityName` and `.cityLoaded`
 * (false = no city: /state says cityLoaded false, /city/* answers 503 like the bridge).
 *
 * /history holds a realistic log (three AI sessions: a batch with a failed part, a failed zoning,
 * refused requests, positions on the map), timed relative to now so the newest session is "live".
 * Tests can replace it: `stub.setHistory(entriesNewestFirst)` (the bridge's order).
 *
 * For the map it also answers /camera, /city/gridmap (every layer, a smooth made-up field) and
 * /city/road-network (a street grid with a ring road and a diagonal avenue around the origin,
 * mixed traffic flow, some traffic lights and roundabouts).
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
  "/city/budget": {},
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

/** 262144 frames per game day, as the real bridge counts them. */
const FRAMES_PER_DAY = 262144
/** Simulated frames per real second at speed 1: one game day takes about a minute. */
const FRAMES_PER_SECOND = 4096
const START = Date.UTC(2026, 2, 14, 8, 30)

const pad = (n) => String(n).padStart(2, "0")

/** "2026-03-14 08:30" for a frame (the stub's game starts on that date). */
export function gameDateTime(frame) {
  const d = new Date(START + (frame / FRAMES_PER_DAY) * 86_400_000)
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`
}

/** City figures at a frame: a growing town with some wobble, all derived from the clock. */
export function cityAt(frame) {
  const day = frame / FRAMES_PER_DAY
  const wave = (period, phase = 0) => Math.sin((day / period) * 2 * Math.PI + phase)
  const demand = (period, phase) => Math.round(Math.min(255, Math.max(0, 128 + 120 * wave(period, phase))))
  return {
    population: Math.round(12345 + 900 * day),
    money: Math.round(1_500_000 + 38_000 * day + 90_000 * wave(9)),
    averageHappiness: Math.round(63 + 6 * wave(11)),
    averageHealth: Math.round(71 + 4 * wave(17, 1)),
    xp: Math.round(4200 + 180 * day),
    totalIncome: Math.round(84_000 + 3_200 * day),
    totalExpenses: Math.round(71_000 + 2_600 * day + 6_000 * wave(7)),
    demand: {
      residential: {
        householdDemand: 40,
        buildingDemand: { lowDensity: demand(13, 0), mediumDensity: demand(8, 2), highDensity: demand(21, 4) },
      },
      commercial: { companyDemand: 10, buildingDemand: demand(10, 1) },
      industrial: { companyDemand: 5, buildingDemand: demand(15, 3) },
      office: { companyDemand: 0, buildingDemand: demand(19, 5) },
    },
  }
}

/** The world is -7168..7168 m; the map shows it as a square and the grid is 32 x 32 cells. */
const WORLD_HALF = 7168
const GRID_SIZE = 32

/** A smooth field in 0..1 per layer, so each layer looks different on the map. */
function gridField(layer, x, z) {
  const seeds = { landValue: 0, groundPollution: 1, airPollution: 2, noisePollution: 3, groundWater: 4, groundWaterPollution: 5 }
  const k = seeds[layer] ?? 0
  const near = Math.exp(-((x - 300) ** 2 + (z + 200) ** 2) / (2 * 1800 ** 2))
  const wave = 0.5 + 0.5 * Math.sin((x + k * 900) / 1500 + Math.cos((z - k * 500) / 1100))
  return k === 0 || k === 3 ? near : 0.65 * wave + 0.35 * near
}

function gridmap(layer) {
  const cell = (WORLD_HALF * 2) / GRID_SIZE
  const values = []
  for (let row = 0; row < GRID_SIZE; row++) {
    for (let col = 0; col < GRID_SIZE; col++) {
      const x = -WORLD_HALF + (col + 0.5) * cell
      const z = -WORLD_HALF + (row + 0.5) * cell
      values.push(Math.round(gridField(layer, x, z) * 1000) / 10)
    }
  }
  return { layer, textureSize: GRID_SIZE, worldMin: -WORLD_HALF, worldMax: WORLD_HALF, cellSize: cell, unit: "stub units", values }
}

/** Street grid (150 m blocks), a ring road and a diagonal avenue: roads are [sx, sz, mx, mz, ex, ez, flow, flags]. */
function roadNetwork() {
  const roads = []
  const junctions = []
  const flow = (x, z) => Math.round(25 + 75 * (0.5 + 0.5 * Math.sin(x / 260) * Math.cos(z / 310)))
  const add = (ax, az, bx, bz, curve = 0) => {
    const mx = (ax + bx) / 2 - ((bz - az) * curve)
    const mz = (az + bz) / 2 + ((bx - ax) * curve)
    roads.push([ax, az, mx, mz, bx, bz, flow(mx, mz), 0])
  }
  const lines = [-900, -750, -600, -450, -300, -150, 0, 150, 300, 450, 600, 750, 900]
  for (const a of lines) {
    for (let i = 0; i < lines.length - 1; i++) {
      add(lines[i], a, lines[i + 1], a)
      add(a, lines[i], a, lines[i + 1])
    }
  }
  for (let i = 0; i < 36; i++) {
    const t0 = (i / 36) * Math.PI * 2
    const t1 = ((i + 1) / 36) * Math.PI * 2
    add(Math.cos(t0) * 1300, Math.sin(t0) * 1300, Math.cos(t1) * 1300, Math.sin(t1) * 1300, 0.01)
  }
  for (let d = -1300; d < 1300; d += 260) add(d, d * 0.6, d + 260, (d + 260) * 0.6)
  for (const x of lines) {
    for (const z of lines) {
      const n = Math.abs(x * 7 + z * 13) % 5
      if (n === 0) junctions.push([x, z, 1])
      else if (n === 1 && x % 300 === 0) junctions.push([x, z, 2])
    }
  }
  junctions.push([1300, 0, 4], [-1300, 0, 4])
  return { roadCount: roads.length, junctionCount: junctions.length, roads, junctions }
}

const CAMERA = {
  pivot: { x: 150, y: 35, z: -100 },
  position: { x: -180, y: 520, z: -820 },
  angle: { x: 25, y: 45 },
  zoom: 740,
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, { "Content-Type": "application/json", ...headers })
  res.end(JSON.stringify(body))
}

/**
 * Starts the stub on 127.0.0.1:`port` (0 = any free port). `cityName` renames its city (to tell
 * two stubs apart). `sim` is the simulation clock (selectedSpeed 0 = paused) that POST
 * /sim/control changes, with the rules of RequestHandlers.SimControl: speed is clamped to 0..8,
 * paused=true stops the clock, paused=false on a stopped clock runs it at 1.
 */
export function startStubBridge(port = 0, { cityName = CITY_NAME } = {}) {
  /** The change log, newest first. */
  let history = sampleHistory()
  /** @type {{ method: string, url: string, headers: import("node:http").IncomingHttpHeaders }[]} */
  const requests = []
  const sim = { selectedSpeed: 1, frame: 1_000_000, cityName, cityLoaded: true }
  let lastTick = Date.now()
  /** Moves the simulation clock to now (frames only advance while a city runs unpaused). */
  const tick = () => {
    const now = Date.now()
    if (sim.cityLoaded && sim.selectedSpeed > 0) {
      sim.frame += Math.round(((now - lastTick) / 1000) * FRAMES_PER_SECOND * sim.selectedSpeed)
    }
    lastTick = now
  }
  const server = createServer((req, res) => {
    requests.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers })
    const { pathname: path, searchParams } = new URL(req.url ?? "/", "http://stub.invalid")
    tick()

    if (path === "/sim/control") {
      if (req.method !== "POST") {
        return send(res, 405, { error: "/sim/control changes game state and requires POST" })
      }
      let changed = false
      if (searchParams.has("speed") && Number.isFinite(Number(searchParams.get("speed")))) {
        sim.selectedSpeed = Math.min(Math.max(Number(searchParams.get("speed")), 0), 8)
        changed = true
      }
      if (searchParams.has("paused")) {
        if (searchParams.get("paused") === "true") sim.selectedSpeed = 0
        else if (sim.selectedSpeed <= 0) sim.selectedSpeed = 1
        changed = true
      }
      if (!changed) return send(res, 400, { error: "provide ?speed=0..8 and/or ?paused=true|false" })
      return send(res, 200, { paused: sim.selectedSpeed <= 0, selectedSpeed: sim.selectedSpeed })
    }

    const limit = Number(searchParams.get("limit") ?? Infinity)
    let body =
      req.method !== "GET" ? undefined : path === "/history" ? historyPayload(history, limit) : FIXTURES[path]
    if (req.method === "GET" && path === "/camera") body = CAMERA
    else if (req.method === "GET" && path === "/city/gridmap") body = gridmap(searchParams.get("layer") ?? "landValue")
    else if (req.method === "GET" && path === "/city/road-network") body = roadNetwork()
    if (body && cityName !== CITY_NAME && "cityName" in body) body = { ...body, cityName }
    const paused = sim.selectedSpeed <= 0
    const city = cityAt(sim.frame)
    const game = gameDateTime(sim.frame)
    if (body && path === "/state") {
      body = sim.cityLoaded
        ? {
            ...body,
            cityName: sim.cityName,
            simulation: {
              ...body.simulation,
              paused,
              selectedSpeed: sim.selectedSpeed,
              effectiveSpeed: sim.selectedSpeed,
              frameIndex: sim.frame,
              gameDateTime: game,
            },
          }
        : { ...body, gameMode: "MainMenu", cityLoaded: false, cityName: null, simulation: null }
    } else if (body && path.startsWith("/city/") && !sim.cityLoaded) {
      return send(res, 503, { error: "no city is loaded" })
    } else if (body && path === "/city/overview") {
      body = {
        ...body,
        cityName: sim.cityName,
        population: city.population,
        populationWithMoveIn: city.population + 155,
        averageHappiness: city.averageHappiness,
        averageHealth: city.averageHealth,
        money: city.money,
        xp: city.xp,
        gameDateTime: game,
        simulationPaused: paused,
        simulationSpeed: sim.selectedSpeed,
      }
    } else if (body && path === "/city/demand") {
      body = city.demand
    } else if (body && path === "/city/budget") {
      body = {
        totalIncome: city.totalIncome,
        totalExpenses: city.totalExpenses,
        totalTaxIncome: Math.round(city.totalIncome * 0.8),
        balance: city.totalIncome - city.totalExpenses,
        moneyDelta: city.totalIncome - city.totalExpenses,
        income: {},
        expenses: {},
      }
    }
    send(res, body ? 200 : 503, body ?? { error: `${req.method} ${path} is not part of the stub bridge` })
  })
  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      const { port: actual } = /** @type {import("node:net").AddressInfo} */ (server.address())
      resolve({
        url: `http://127.0.0.1:${actual}`,
        requests,
        sim,
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
