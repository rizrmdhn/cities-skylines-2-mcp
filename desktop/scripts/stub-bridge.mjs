#!/usr/bin/env node
/**
 * A tiny stand-in for the CS2MCP bridge with a fixed city ("Riverside"), so the desktop app can
 * be run and tested without the game. Answers GET /ping, /state, /city/overview, /city/demand and
 * /history, and POST /sim/control (pause / resume / speed 0..8, answered like the real bridge and
 * reflected in /state and /city/overview); any other path answers 503 with a bridge-style error.
 * Records every request.
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
  /** @type {{ method: string, url: string, headers: import("node:http").IncomingHttpHeaders }[]} */
  const requests = []
  const sim = { selectedSpeed: 1 }
  const server = createServer((req, res) => {
    requests.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers })
    const { pathname: path, searchParams } = new URL(req.url ?? "/", "http://stub.invalid")

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
    if (body && cityName !== CITY_NAME && "cityName" in body) body = { ...body, cityName }
    const paused = sim.selectedSpeed <= 0
    if (body && path === "/state") {
      body = {
        ...body,
        simulation: { ...body.simulation, paused, selectedSpeed: sim.selectedSpeed, effectiveSpeed: sim.selectedSpeed },
      }
    } else if (body && path === "/city/overview") {
      body = { ...body, simulationPaused: paused, simulationSpeed: sim.selectedSpeed }
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
