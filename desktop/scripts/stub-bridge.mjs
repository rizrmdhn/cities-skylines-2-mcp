#!/usr/bin/env node
/**
 * A tiny stand-in for the CS2MCP bridge with a fixed city ("Riverside"), so the desktop app can
 * be run and tested without the game. Answers GET /ping, /state, /city/overview, /city/demand and
 * /history; any other path answers 503 with a bridge-style error. Records every request.
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

/** Starts the stub on 127.0.0.1:`port` (0 = any free port). */
export function startStubBridge(port = 0) {
  /** @type {{ method: string, url: string, headers: import("node:http").IncomingHttpHeaders }[]} */
  const requests = []
  const server = createServer((req, res) => {
    requests.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers })
    const path = new URL(req.url ?? "/", "http://stub.invalid").pathname
    const body = req.method === "GET" ? FIXTURES[path] : undefined
    res.writeHead(body ? 200 : 503, { "Content-Type": "application/json" })
    res.end(JSON.stringify(body ?? { error: `${req.method} ${path} is not part of the stub bridge` }))
  })
  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      const { port: actual } = /** @type {import("node:net").AddressInfo} */ (server.address())
      resolve({
        url: `http://127.0.0.1:${actual}`,
        requests,
        close: () => new Promise((done) => server.close(() => done(undefined))),
      })
    })
  })
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const stub = await startStubBridge(Number(process.argv[2] ?? 0))
  console.log(`stub bridge on ${stub.url} (Ctrl+C to stop); run the app with CS2_BRIDGE_URL=${stub.url}`)
}
