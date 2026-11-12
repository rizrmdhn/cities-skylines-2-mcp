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
  "/city/demand": {
    residential: { householdDemand: 40, buildingDemand: { lowDensity: 200, mediumDensity: 120, highDensity: 30 } },
    commercial: { companyDemand: 10, buildingDemand: 90 },
    industrial: { companyDemand: 5, buildingDemand: 140 },
    office: { companyDemand: 0, buildingDemand: 12 },
  },
  "/city/budget": {},
  "/history": {
    sessionSpent: 0,
    spendingLimit: 100000,
    spendingLimitRemaining: 100000,
    spendingLimitSource: "game options",
    batchRunning: false,
    total: 0,
    returned: 0,
    entries: [],
  },
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

function send(res, status, body, headers = {}) {
  res.writeHead(status, { "Content-Type": "application/json", ...headers })
  res.end(JSON.stringify(body))
}

/**
 * Starts the stub on 127.0.0.1:`port` (0 = any free port). `sim` is the simulation clock
 * (selectedSpeed 0 = paused) that POST /sim/control changes, with the rules of
 * RequestHandlers.SimControl: speed is clamped to 0..8, paused=true stops the clock, paused=false
 * on a stopped clock runs it at 1.
 */
export function startStubBridge(port = 0) {
  /** @type {{ method: string, url: string, headers: import("node:http").IncomingHttpHeaders }[]} */
  const requests = []
  const sim = { selectedSpeed: 1, frame: 1_000_000, cityName: CITY_NAME, cityLoaded: true }
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

    let body = req.method === "GET" ? FIXTURES[path] : undefined
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
        close: () => new Promise((done) => server.close(() => done(undefined))),
      })
    })
  })
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const stub = await startStubBridge(Number(process.argv[2] ?? 0))
  console.log(`stub bridge on ${stub.url} (Ctrl+C to stop); run the app with CS2_BRIDGE_URL=${stub.url}`)
}
