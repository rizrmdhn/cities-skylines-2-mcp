/** The trends feature through the real route registry, settings store and app:// handler. */
import { mkdtempSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import settingsApi from "../src/features/settings-api.ts"
import { cityKey, createTrendsFeature, createTrendStore, METRICS } from "../src/features/trends.ts"
import { createTestContext, type TestContext } from "../src/testing.ts"
import { fakeBridgeFetch, fakeGame, type FakeGame } from "./trends-fixtures.ts"

let dir: string
let game: FakeGame
let t: TestContext

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cs2mcp-trends-routes-"))
  game = fakeGame()
})
afterEach(async () => {
  await t?.lifecycle.runBeforeQuit()
  rmSync(dir, { recursive: true, force: true })
})

interface Status {
  state: string
  city: { key: string; name: string } | null
  enabled: boolean
  intervalSeconds: number
  retentionDays: number
  sessionSamples: number
  consecutiveFailures: number
  lastSampleAt: number | null
  bytes: number
  error: string | null
}

const status = async () => (await t.request<Status>("GET", "/api/desktop/trends")).body

async function start(options: { run?: boolean } = {}) {
  t = await createTestContext({
    features: [settingsApi, createTrendsFeature({ dir })],
    bridgeFetch: fakeBridgeFetch(game),
  })
  if (options.run !== false) {
    await t.lifecycle.runReady()
    await vi.waitFor(async () => expect((await status()).sessionSamples).toBeGreaterThanOrEqual(1))
  }
  return t
}

/** Writes `count` samples of another city straight into the store. */
async function seed(count: number, city = "Riverside") {
  const store = createTrendStore({ dir, log: t.ctx.log, now: Date.now, retentionDays: () => 0 })
  const key = await store.open(city)
  for (let i = 0; i < count; i++) {
    await store.append(key, city, {
      t: 1_800_000_000_000 + i * 60_000,
      frame: 2_000_000 + i * 26_214,
      game: `2026-04-${String(1 + Math.floor(i / 10)).padStart(2, "0")} 08:00`,
      run: 0,
      values: { population: 1000 + i, money: 1e6 + i * 100 },
    })
  }
  return key
}

describe("trends feature", () => {
  it("registers its settings with their limits and shows them in /api/desktop/settings", async () => {
    await start({ run: false })
    const settings = (await t.request<Record<string, unknown>>("GET", "/api/desktop/settings")).body
    expect(settings).toMatchObject({ "trends.enabled": true, "trends.intervalSeconds": 60, "trends.retentionDays": 365 })
    expect((await t.request("POST", "/api/desktop/settings", { "trends.intervalSeconds": 5 })).status).toBe(400)
    expect((await t.request("POST", "/api/desktop/settings", { "trends.retentionDays": -1 })).status).toBe(400)
    expect((await t.request("POST", "/api/desktop/settings", { "trends.enabled": "yes" })).status).toBe(400)
    const ok = await t.request<Record<string, unknown>>("POST", "/api/desktop/settings", {
      "trends.intervalSeconds": 120,
      "trends.retentionDays": 30,
    })
    expect(ok.body).toMatchObject({ "trends.intervalSeconds": 120, "trends.retentionDays": 30 })
  })

  it("is listed as a started feature and its routes are registered", async () => {
    await start({ run: false })
    expect(t.featureIds).toContain("trends")
    expect(t.ctx.routes.list().map((r) => `${r.method} ${r.path}`)).toEqual(
      expect.arrayContaining([
        "GET /desktop/trends",
        "GET /desktop/trends/cities",
        "GET /desktop/trends/series",
        "POST /desktop/trends/clear",
      ])
    )
  })

  it("GET /desktop/trends reports the recorder: state, city, settings, storage", async () => {
    await start()
    const body = await status()
    expect(body).toMatchObject({
      state: "recording",
      city: { key: cityKey("Riverside"), name: "Riverside" },
      enabled: true,
      intervalSeconds: 60,
      retentionDays: 365,
      sessionSamples: 1,
      error: null,
    })
    expect(body.lastSampleAt).toEqual(expect.any(Number))
    expect(body.bytes).toBeGreaterThan(0)
    expect(JSON.stringify(body)).not.toContain("token")
  })

  it("lists cities with data and reads a series with the metric names and frames per day", async () => {
    await start()
    const key = cityKey("Riverside")
    await seed(5, "Lakeside")
    const cities = (await t.request<{ cities: { key: string; name: string; samples: number }[] }>("GET", "/api/desktop/trends/cities")).body.cities
    expect(cities.map((c) => c.name).sort()).toEqual(["Lakeside", "Riverside"])
    expect(cities.find((c) => c.name === "Lakeside")?.samples).toBe(5)

    const series = (
      await t.request<{
        city: { key: string; name: string }
        metrics: string[]
        framesPerDay: number
        axis: string
        points: { population: number | null; gap: boolean }[]
      }>("GET", `/api/desktop/trends/series?city=${key}&axis=real&points=0`)
    ).body
    expect(series.city).toEqual({ key, name: "Riverside" })
    expect(series.metrics).toEqual(METRICS)
    expect(series.framesPerDay).toBe(262144)
    expect(series.axis).toBe("real")
    expect(series.points).toHaveLength(1)
    expect(series.points[0]).toMatchObject({ population: 1000, gap: false })
  })

  it("reads a series by range and resolution", async () => {
    await start({ run: false })
    const key = await seed(300)
    const q = (query: string) =>
      t.request<{ points: unknown[]; samples: number }>("GET", `/api/desktop/trends/series?city=${key}&${query}`)
    expect((await q("axis=real&points=50")).body.points.length).toBeLessThanOrEqual(50)
    expect((await q("axis=real&points=0")).body.points).toHaveLength(300)
    expect((await q("axis=real&points=0&last=3600000")).body.points).toHaveLength(61)
    expect((await q(`axis=game&points=0&from=${2_000_000 + 100 * 26_214}`)).body.points).toHaveLength(200)
    // the default: game axis, up to 600 points
    expect((await q("")).body.points).toHaveLength(300)
  })

  it("refuses bad series queries and answers 404 for a city without data", async () => {
    await start({ run: false })
    const bad = ["", "city=../../settings", "city=UPPER", `city=${"a".repeat(80)}`, "city=ok&axis=sideways", "city=ok&points=999999", "city=ok&last=-1"]
    for (const query of bad) {
      expect((await t.request("GET", `/api/desktop/trends/series?${query}`)).status, query).toBe(400)
    }
    const res = await t.request<{ kind: string }>("GET", "/api/desktop/trends/series?city=nothing-00000000")
    expect(res).toMatchObject({ status: 404, body: { kind: "companion" } })
  })

  it("clears one city, or all, and keeps recording afterwards", async () => {
    await start()
    const riverside = cityKey("Riverside")
    const lakeside = await seed(3, "Lakeside")
    expect((await t.request("POST", "/api/desktop/trends/clear", { city: lakeside })).body).toEqual({ cleared: 1 })
    expect((await t.request("POST", "/api/desktop/trends/clear", { city: lakeside })).body).toEqual({ cleared: 0 })
    expect(readdirSync(dir)).toEqual([`${riverside}.jsonl`])

    expect((await t.request("POST", "/api/desktop/trends/clear", { all: true })).body).toEqual({ cleared: 1 })
    expect(readdirSync(dir)).toEqual([])
    expect((await t.request<{ cities: unknown[] }>("GET", "/api/desktop/trends/cities")).body.cities).toEqual([])

    // the next poll starts a new series in a new file
    game.advance()
    await t.ctx.settings.set("trends.intervalSeconds", 10) // restarts the recorder: it polls at once
    await vi.waitFor(async () => {
      const cities = (await t.request<{ cities: unknown[] }>("GET", "/api/desktop/trends/cities")).body.cities
      expect(cities).toHaveLength(1)
    })
  })

  it("validates the clear body", async () => {
    await start({ run: false })
    const bad = [{}, { all: false }, { city: "../x" }, { city: "ok-1", all: true }, { city: 5 }]
    for (const body of bad) {
      expect((await t.request("POST", "/api/desktop/trends/clear", body)).status, JSON.stringify(body)).toBe(400)
    }
    expect((await t.request("GET", "/api/desktop/trends/clear")).status).toBe(405)
  })

  it("stops asking the bridge when recording is switched off and resumes when it is switched on", async () => {
    await start()
    await t.request("POST", "/api/desktop/settings", { "trends.enabled": false })
    expect(await status()).toMatchObject({ state: "disabled", enabled: false, city: null })
    const asked = game.requests.length
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(game.requests.length).toBe(asked)

    game.advance()
    await t.request("POST", "/api/desktop/settings", { "trends.enabled": true })
    await vi.waitFor(async () => expect(await status()).toMatchObject({ state: "recording", sessionSamples: 2 }))
  })

  it("reports an unreachable bridge in the status, and stops polling on quit", async () => {
    game.up = false
    await start({ run: false })
    await t.lifecycle.runReady()
    await vi.waitFor(async () => expect(await status()).toMatchObject({ state: "unreachable", consecutiveFailures: 1 }))
    await t.lifecycle.runBeforeQuit()
    const asked = game.requests.length
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(game.requests.length).toBe(asked)
  })
})
