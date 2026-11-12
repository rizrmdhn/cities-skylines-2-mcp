/** A fake game for the trends tests: a bridge whose answers follow a few mutable fields. */
import { BridgeError, type BridgeClient } from "../src/bridge.ts"

const FRAMES_PER_DAY = 262144
const START = Date.UTC(2026, 2, 14, 8, 30)
const pad = (n: number) => String(n).padStart(2, "0")

export function gameDate(frame: number): string {
  const d = new Date(START + (frame / FRAMES_PER_DAY) * 86_400_000)
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`
}

export interface FakeGame {
  /** false: the bridge is unreachable */
  up: boolean
  /** false: no city (main menu) */
  loaded: boolean
  loading: boolean
  city: string
  paused: boolean
  frame: number
  population: number
  money: number
  /** answer 404 for /city/budget (an older bridge) */
  noBudget: boolean
  /** every bridge path asked, in order */
  requests: string[]
  /** Moves the simulation (a day is 262144 frames). */
  advance(frames?: number): void
}

export function fakeGame(init: Partial<FakeGame> = {}): FakeGame {
  const game: FakeGame = {
    up: true,
    loaded: true,
    loading: false,
    city: "Riverside",
    paused: false,
    frame: 1_000_000,
    population: 1000,
    money: 500_000,
    noBudget: false,
    requests: [],
    advance(frames = 26_214) {
      game.frame += frames
      game.population += 10
      game.money += 1000
    },
    ...init,
  }
  return game
}

export function fakeBridge(game: FakeGame): BridgeClient {
  const fail = (status: number, kind: "unreachable" | "bridge", error: string): never => {
    throw new BridgeError({ error, status, kind })
  }
  return {
    async get<T>(path: string) {
      game.requests.push(path)
      if (!game.up) fail(502, "unreachable", "Cannot reach the CS2MCP bridge")
      const answer = ((): unknown => {
        switch (path) {
          case "/state":
            return {
              gameMode: game.loaded ? "Game" : "MainMenu",
              isLoading: game.loading,
              cityLoaded: game.loaded,
              cityName: game.loaded ? game.city : null,
              simulation: game.loaded
                ? {
                    paused: game.paused,
                    selectedSpeed: game.paused ? 0 : 1,
                    frameIndex: game.frame,
                    gameDateTime: gameDate(game.frame),
                    forcedPause: null,
                  }
                : null,
            }
          case "/city/overview":
            if (!game.loaded) return fail(503, "bridge", "no city is loaded")
            return {
              cityName: game.city,
              population: game.population,
              averageHappiness: 63,
              averageHealth: 71,
              money: game.money,
              xp: 4200,
              gameDateTime: gameDate(game.frame),
            }
          case "/city/demand":
            return {
              residential: { buildingDemand: { lowDensity: 200, mediumDensity: 120, highDensity: 30 } },
              commercial: { buildingDemand: 90 },
              industrial: { buildingDemand: 140 },
              office: { buildingDemand: 12 },
            }
          case "/city/budget":
            if (game.noBudget) return fail(404, "bridge", "unknown endpoint")
            return { totalIncome: 80_000, totalExpenses: 60_000 }
          default:
            return fail(404, "bridge", `unknown endpoint ${path}`)
        }
      })()
      return answer as T
    },
    async control() {
      return fail(405, "bridge", "the recorder never sends control requests")
    },
  }
}

/** A bridge `fetch` for createTestContext, answering the same payloads. */
export function fakeBridgeFetch(game: FakeGame): typeof fetch {
  const bridge = fakeBridge(game)
  return (async (input: RequestInfo | URL) => {
    const path = new URL(String(input instanceof Request ? input.url : input)).pathname
    try {
      return Response.json(await bridge.get(path))
    } catch (err) {
      if (!(err instanceof BridgeError)) throw err
      if (err.kind === "unreachable") throw new TypeError("fetch failed")
      return Response.json({ error: err.message }, { status: err.status })
    }
  }) as typeof fetch
}
