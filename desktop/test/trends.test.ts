/**
 * The trend recorder and store, in plain Node: a fake game answers the bridge, files go to a
 * throwaway folder, wall-clock time is faked where it matters.
 */
import { appendFileSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { createLogger } from "../src/logger.ts"
import {
  buildSeries,
  cityKey,
  createRecorder,
  createTrendStore,
  FRAMES_PER_GAME_DAY,
  gameMinutes,
  gameX,
  IDLE_CHECK_MS,
  isBackwards,
  MAX_BACKOFF_MS,
  METRICS,
  thin,
  type Sample,
  type TrendStore,
} from "../src/features/trends.ts"
import { fakeBridge, fakeGame, gameDate, type FakeGame } from "./trends-fixtures.ts"

const logLines: string[] = []
const log = createLogger((_level, line) => logLines.push(line))

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cs2mcp-trends-"))
  logLines.length = 0
})
afterEach(() => {
  vi.useRealTimers()
  rmSync(dir, { recursive: true, force: true })
})

function sample(t: number, frame: number | null, run = 0, values: Sample["values"] = { population: t }): Sample {
  return { t, frame, game: frame === null ? null : gameDate(frame), run, values }
}

function openStore(options: Partial<Parameters<typeof createTrendStore>[0]> = {}): TrendStore {
  return createTrendStore({ dir, log, now: Date.now, retentionDays: () => 0, ...options })
}

function harness(game: FakeGame, extra: { intervalSeconds?: number; enabled?: () => boolean; store?: TrendStore } = {}) {
  const store = extra.store ?? openStore()
  const recorder = createRecorder({
    bridge: fakeBridge(game),
    store,
    log,
    now: Date.now,
    enabled: extra.enabled ?? (() => true),
    intervalSeconds: () => extra.intervalSeconds ?? 60,
  })
  return { store, recorder }
}

describe("city keys and game time", () => {
  it("keys a city by a readable slug plus a hash of the exact name", () => {
    expect(cityKey("Riverside")).toMatch(/^riverside-[0-9a-f]{8}$/)
    expect(cityKey("Riverside")).toBe(cityKey("Riverside"))
    // Same slug, different cities: the hash keeps their files apart.
    expect(cityKey("New York!")).not.toBe(cityKey("New York?"))
    expect(cityKey("Riverside")).not.toBe(cityKey("riverside"))
    // Anything a player can type becomes a safe file name.
    for (const name of ["../../etc/passwd", "C:\\x", "日本語の街", "", "a".repeat(300)]) {
      expect(cityKey(name)).toMatch(/^[a-z0-9-]{1,64}$/)
    }
  })

  it("orders samples by frame, or by the game date when a bridge sends no frame", () => {
    expect(gameMinutes("2026-03-14 08:30")).toBe(gameMinutes("2026-03-14T08:30"))
    expect(gameMinutes("garbage")).toBeNull()
    expect(gameX({ frame: 500, game: null })).toBe(500)
    expect(gameX({ frame: null, game: "2026-03-14 08:30" })).not.toBeNull()
    expect(gameX({ frame: null, game: null })).toBeNull()
    expect(isBackwards({ frame: 10, game: null }, { frame: 9, game: null })).toBe(true)
    expect(isBackwards({ frame: 10, game: null }, { frame: 10, game: null })).toBe(false)
    expect(isBackwards({ frame: null, game: "2026-03-14 08:30" }, { frame: null, game: "2026-03-13 23:00" })).toBe(true)
  })
})

describe("store", () => {
  it("keeps one file per city and survives a restart", async () => {
    const store = openStore()
    const a = await store.open("Riverside")
    const b = await store.open("Lakeside")
    await store.append(a, "Riverside", sample(1000, 100))
    await store.append(a, "Riverside", sample(2000, 200))
    await store.append(b, "Lakeside", sample(1500, 50))
    expect(readdirSync(dir).sort()).toEqual([`${b}.jsonl`, `${a}.jsonl`].sort())

    const again = openStore()
    expect((await again.list()).map((c) => [c.name, c.samples])).toEqual([
      ["Riverside", 2],
      ["Lakeside", 1],
    ])
    expect((await again.samples(a))?.map((s) => s.values.population)).toEqual([1000, 2000])
    expect(await again.samples(b)).toHaveLength(1)
  })

  it("writes short keys and skips metrics the bridge did not send", async () => {
    const store = openStore()
    const key = await store.open("Riverside")
    await store.append(key, "Riverside", { t: 5, frame: 7, game: "2026-03-14 08:30", run: 0, values: { population: 12, money: -3 } })
    const lines = readFileSync(join(dir, `${key}.jsonl`), "utf8").trim().split("\n")
    expect(JSON.parse(lines[0])).toEqual({ trends: 1, city: "Riverside" })
    expect(JSON.parse(lines[1])).toEqual({ t: 5, s: 0, f: 7, g: "2026-03-14 08:30", pop: 12, money: -3 })
  })

  it("skips a torn last line and starts the next sample on a fresh line", async () => {
    const first = openStore()
    const key = await first.open("Riverside")
    await first.append(key, "Riverside", sample(1000, 100))
    await first.append(key, "Riverside", sample(2000, 200))
    appendFileSync(join(dir, `${key}.jsonl`), '{"t":3000,"s":0,"f":3', "utf8") // crash mid-append

    const store = openStore()
    expect((await store.samples(key))?.map((s) => s.t)).toEqual([1000, 2000])
    expect(logLines.join("\n")).toContain("skipped 1 unreadable line")
    await store.append(key, "Riverside", sample(4000, 400))
    const reread = openStore()
    expect((await reread.samples(key))?.map((s) => s.t)).toEqual([1000, 2000, 4000])
  })

  it("moves a file that holds nothing readable aside and starts over", async () => {
    const key = cityKey("Riverside")
    writeFileSync(join(dir, `${key}.jsonl`), "\u0000\u0000not json at all\n{{{{\n", "utf8")
    const store = openStore({ now: () => 777 })
    expect(await store.list()).toEqual([])
    expect(readdirSync(dir)).toEqual([`${key}.jsonl.corrupt-777`])
    expect(logLines.join("\n")).toContain("no readable data")
    // and recording into that city works
    const opened = await store.open("Riverside")
    await store.append(opened, "Riverside", sample(1, 1))
    expect(await store.samples(opened)).toHaveLength(1)
  })

  it("repairs a file with a damaged line in the middle on load", async () => {
    const first = openStore()
    const key = await first.open("Riverside")
    await first.append(key, "Riverside", sample(1000, 100))
    const file = join(dir, `${key}.jsonl`)
    appendFileSync(file, "garbage\n", "utf8")
    appendFileSync(file, JSON.stringify({ t: 3000, s: 0, f: 300, pop: 3 }) + "\n", "utf8")
    const store = openStore()
    expect((await store.samples(key))?.map((s) => s.t)).toEqual([1000, 3000])
    await store.flush()
    expect(readFileSync(file, "utf8")).not.toContain("garbage")
  })

  it("drops samples older than the retention period; appends allow a day of slack, a reload is strict", async () => {
    const day = 86_400_000
    const t0 = Date.UTC(2026, 0, 1)
    let now = t0
    const store = openStore({ now: () => now, retentionDays: () => 30 })
    const key = await store.open("Riverside")
    await store.append(key, "Riverside", sample(now, 1))
    now = t0 + 30.5 * day // A is just past the limit, within the slack: kept for now
    await store.append(key, "Riverside", sample(now, 2))
    expect((await store.samples(key))?.map((s) => s.frame)).toEqual([1, 2])
    // a fresh start applies the limit exactly
    expect((await openStore({ now: () => now, retentionDays: () => 30 }).samples(key))?.map((s) => s.frame)).toEqual([2])

    now = t0 + 40 * day // beyond the slack: the next append drops A and rewrites the file
    await store.append(key, "Riverside", sample(now, 3))
    expect((await store.samples(key))?.map((s) => s.frame)).toEqual([2, 3])
    expect(readFileSync(join(dir, `${key}.jsonl`), "utf8").trim().split("\n")).toHaveLength(3) // header + 2

    // retention 0 keeps everything
    now = t0 + 400 * day
    expect(await openStore({ now: () => now, retentionDays: () => 0 }).list()).toHaveLength(1)
    // everything expired: the city disappears from the list
    expect(await openStore({ now: () => now, retentionDays: () => 30 }).list()).toEqual([])
  })

  it("caps a city at maxSamples by thinning the older half, keeping the newest samples", async () => {
    const store = openStore({ maxSamples: 40 })
    const key = await store.open("Riverside")
    for (let i = 0; i < 100; i++) await store.append(key, "Riverside", sample(1000 + i, i * 10))
    const kept = (await store.samples(key))!
    expect(kept.length).toBeLessThanOrEqual(40)
    expect(kept.length).toBeGreaterThan(15)
    expect(kept.at(-1)?.t).toBe(1099) // newest sample untouched
    expect(kept[0].t).toBe(1000) // oldest kept as the start of the history
    const ts = kept.map((s) => s.t)
    expect(ts).toEqual([...ts].sort((a, b) => a - b))
    // the newer half is still dense; the older part is sparse
    const gaps = ts.slice(1).map((t, i) => t - ts[i])
    expect(Math.max(...gaps.slice(-10))).toBe(1)
    expect(Math.max(...gaps.slice(0, 5))).toBeGreaterThan(1)
    // the file on disk has the same shape and is small
    const reloaded = openStore({ maxSamples: 40 })
    expect((await reloaded.samples(key))?.length).toBe(kept.length)
  })

  it("thin keeps the first and last sample of every run", () => {
    const samples = [
      ...Array.from({ length: 30 }, (_, i) => sample(i, i, 0)),
      ...Array.from({ length: 30 }, (_, i) => sample(100 + i, i, 1)),
    ]
    const thinned = thin(samples, 20)
    expect(thinned.length).toBeLessThanOrEqual(30)
    const byRun = (run: number) => thinned.filter((s) => s.run === run)
    expect(byRun(0)[0].t).toBe(0)
    expect(byRun(0).at(-1)?.t).toBe(29)
    expect(byRun(1)[0].t).toBe(100)
    expect(byRun(1).at(-1)?.t).toBe(129)
  })

  it("clears one city or all of them, and can record into a cleared city again", async () => {
    const store = openStore()
    const a = await store.open("Riverside")
    const b = await store.open("Lakeside")
    await store.append(a, "Riverside", sample(1, 1))
    await store.append(b, "Lakeside", sample(2, 2))
    expect(await store.clear(a)).toBe(true)
    expect(await store.clear(a)).toBe(false)
    expect((await store.list()).map((c) => c.name)).toEqual(["Lakeside"])
    // an append that was already on its way when the data was cleared recreates the series
    await store.append(a, "Riverside", sample(3, 3, 5))
    expect(await store.samples(a)).toHaveLength(1)
    expect(await store.clearAll()).toBe(2)
    expect(await store.list()).toEqual([])
    expect(readdirSync(dir)).toEqual([])
    expect(await store.bytes()).toBe(0)
  })
})

describe("recorder", () => {
  it("records overview, demand and budget as one sample with both clocks", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(new Date("2026-11-12T10:00:00Z"))
    const game = fakeGame()
    const { recorder, store } = harness(game)
    const delay = await recorder.pollNow()
    expect(delay).toBe(60_000)
    expect(game.requests).toEqual(["/state", "/city/overview", "/city/demand", "/city/budget"])
    const key = cityKey("Riverside")
    const [s] = (await store.samples(key))!
    expect(s).toMatchObject({
      t: Date.parse("2026-11-12T10:00:00Z"),
      frame: 1_000_000,
      game: gameDate(1_000_000),
      run: 0,
      values: {
        population: 1000,
        money: 500_000,
        happiness: 63,
        health: 71,
        xp: 4200,
        income: 80_000,
        expenses: 60_000,
        demandResidentialLow: 200,
        demandResidentialMedium: 120,
        demandResidentialHigh: 30,
        demandCommercial: 90,
        demandIndustrial: 140,
        demandOffice: 12,
      },
    })
    expect(Object.keys(s.values).sort()).toEqual([...METRICS].sort())
    expect(recorder.status()).toMatchObject({ state: "recording", sessionSamples: 1, city: { name: "Riverside" } })
  })

  it("still records when a read route is missing (an older bridge has no /city/budget)", async () => {
    const game = fakeGame({ noBudget: true })
    const { recorder, store } = harness(game)
    await recorder.pollNow()
    const [s] = (await store.samples(cityKey("Riverside")))!
    expect(s.values.population).toBe(1000)
    expect(s.values.income).toBeUndefined()
    expect(recorder.status().state).toBe("recording")
  })

  it("does not record while paused: one cheap request, no sample, and none for an unchanged frame", async () => {
    const game = fakeGame()
    const { recorder, store } = harness(game)
    await recorder.pollNow()
    game.requests.length = 0

    game.paused = true
    game.advance() // the player builds while paused: the frame stays, so does the sample count
    game.frame -= 26_214
    await recorder.pollNow()
    expect(game.requests).toEqual(["/state"])
    expect(recorder.status().state).toBe("paused")

    // a forced pause (popup, window unfocused) is not "paused" for the bridge, but the frame stands still
    game.paused = false
    game.requests.length = 0
    await recorder.pollNow()
    expect(game.requests).toEqual(["/state"])
    expect(await store.samples(cityKey("Riverside"))).toHaveLength(1)

    game.advance()
    await recorder.pollNow()
    expect(await store.samples(cityKey("Riverside"))).toHaveLength(2)
  })

  it("never records a city that was loaded paused until the game runs", async () => {
    const game = fakeGame({ paused: true })
    const { recorder, store } = harness(game)
    await recorder.pollNow()
    expect(await store.list()).toEqual([])
    expect(recorder.status()).toMatchObject({ state: "paused", city: { name: "Riverside" }, sessionSamples: 0 })
  })

  it("asks only /state while no city is loaded and checks no more often than IDLE_CHECK_MS", async () => {
    const game = fakeGame({ loaded: false })
    const { recorder } = harness(game, { intervalSeconds: 10 })
    expect(await recorder.pollNow()).toBe(IDLE_CHECK_MS)
    expect(game.requests).toEqual(["/state"])
    expect(recorder.status()).toMatchObject({ state: "no-city", city: null })
    game.loaded = true
    game.loading = true // still loading: also no sampling
    expect(await recorder.pollNow()).toBe(IDLE_CHECK_MS)
    expect(game.requests).toEqual(["/state", "/state"])
    // with a long interval the interval wins
    const slow = harness(game, { intervalSeconds: 300 })
    expect(await slow.recorder.pollNow()).toBe(300_000)
  })

  it("starts a new run when game time goes backwards (an older save), draws only the current timeline", async () => {
    const game = fakeGame()
    const { recorder, store } = harness(game)
    for (let i = 0; i < 4; i++) {
      await recorder.pollNow()
      game.advance()
    }
    // load an older save: the frame jumps back
    game.frame = 1_000_000 + 2 * 26_214
    game.population = 5000
    await recorder.pollNow()
    game.advance()
    await recorder.pollNow()

    const samples = (await store.samples(cityKey("Riverside")))!
    expect(samples.map((s) => s.run)).toEqual([0, 0, 0, 0, 1, 1])
    const game_ = buildSeries(samples, "game", {}, 0)
    // the abandoned future (frames after the older save's start) is not drawn: no backwards line
    const xs = game_.points.map((p) => p.x)
    expect(xs).toEqual([...xs].sort((a, b) => a - b))
    expect(game_.points.map((p) => p.run)).toEqual([0, 0, 1, 1])
    expect(game_.points.map((p) => p.population)).toEqual([1000, 1010, 5000, 5010])
    expect(game_.points.map((p) => p.gap)).toEqual([false, false, true, false])
    // the real-time axis keeps everything, in recording order
    const real = buildSeries(samples, "real", {}, 0)
    expect(real.points.map((p) => p.population)).toEqual([1000, 1010, 1020, 1030, 5000, 5010])
  })

  it("notices an older save that loaded paused and then ran past the newest sample", async () => {
    const game = fakeGame()
    const { recorder, store } = harness(game)
    await recorder.pollNow()
    game.advance(100_000)
    await recorder.pollNow() // newest sample at frame 1_100_000
    // load an older save, paused: seen by a poll (nothing recorded)
    game.frame = 900_000
    game.paused = true
    await recorder.pollNow()
    // the player runs at 8x: by the next poll the game is already past the newest stored frame
    game.paused = false
    game.frame = 1_150_000
    await recorder.pollNow()
    const samples = (await store.samples(cityKey("Riverside")))!
    expect(samples.map((s) => s.run)).toEqual([0, 0, 1])
  })

  it("keeps cities apart, and a switch of city starts a new run", async () => {
    const game = fakeGame()
    const { recorder, store } = harness(game)
    await recorder.pollNow()
    game.city = "Lakeside"
    game.advance()
    await recorder.pollNow()
    game.advance()
    await recorder.pollNow()
    game.city = "Riverside"
    game.frame = 2_000_000
    await recorder.pollNow()
    expect((await store.list()).map((c) => [c.name, c.samples]).sort()).toEqual([
      ["Lakeside", 2],
      ["Riverside", 2],
    ])
    const riverside = (await store.samples(cityKey("Riverside")))!
    expect(riverside.map((s) => s.run)).toEqual([0, 1]) // came back later: a new stretch
  })

  it("backs off while the bridge is down, caps the wait, and starts a new run when it is back", async () => {
    const game = fakeGame()
    const { recorder, store } = harness(game, { intervalSeconds: 60 })
    await recorder.pollNow()
    game.up = false
    const delays: number[] = []
    for (let i = 0; i < 6; i++) delays.push(await recorder.pollNow())
    expect(delays).toEqual([120_000, 240_000, MAX_BACKOFF_MS, MAX_BACKOFF_MS, MAX_BACKOFF_MS, MAX_BACKOFF_MS])
    expect(recorder.status()).toMatchObject({ state: "unreachable", consecutiveFailures: 6 })
    expect(recorder.status().error).toBeTruthy()

    game.up = true
    game.advance()
    expect(await recorder.pollNow()).toBe(60_000)
    expect(recorder.status()).toMatchObject({ state: "recording", consecutiveFailures: 0, error: null })
    expect((await store.samples(cityKey("Riverside")))!.map((s) => s.run)).toEqual([0, 1])
  })

  it("never backs off to less than a long interval", async () => {
    const game = fakeGame({ up: false })
    const { recorder } = harness(game, { intervalSeconds: 900 })
    expect(await recorder.pollNow()).toBe(900_000)
  })

  it("asks nothing while recording is off", async () => {
    const game = fakeGame()
    let enabled = false
    const { recorder, store } = harness(game, { enabled: () => enabled })
    await recorder.pollNow()
    expect(game.requests).toEqual([])
    expect(recorder.status().state).toBe("disabled")
    enabled = true
    await recorder.pollNow()
    expect(await store.list()).toHaveLength(1)
  })

  it("polls on a timer, stops on stop() and restarts on restart()", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
    const game = fakeGame()
    const { recorder, store } = harness(game, { intervalSeconds: 60 })
    recorder.start()
    await recorder.idle()
    expect(game.requests.filter((p) => p === "/state")).toHaveLength(1)
    expect(recorder.status().nextPollAt).toBe(Date.now() + 60_000)

    game.advance()
    await vi.advanceTimersByTimeAsync(59_000)
    expect(game.requests.filter((p) => p === "/state")).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1_000)
    await recorder.idle()
    expect(game.requests.filter((p) => p === "/state")).toHaveLength(2)
    expect(await store.samples(cityKey("Riverside"))).toHaveLength(2)

    recorder.restart() // a setting changed: polls at once
    await recorder.idle()
    expect(game.requests.filter((p) => p === "/state")).toHaveLength(3)

    recorder.stop()
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    await recorder.idle()
    expect(game.requests.filter((p) => p === "/state")).toHaveLength(3)
    expect(recorder.status().nextPollAt).toBeNull()
  })
})

describe("buildSeries", () => {
  const run = (start: number, count: number, step = 100, runId = 0) =>
    Array.from({ length: count }, (_, i) => sample(start + i * 1000, (start + i) * step, runId, { population: i }))

  it("reduces a long series to the requested number of points, keeping the time order and the mean", () => {
    const samples = run(0, 1000)
    const series = buildSeries(samples, "game", {}, 50)
    expect(series.samples).toBe(1000)
    expect(series.points.length).toBeLessThanOrEqual(50)
    expect(series.points.length).toBeGreaterThan(40)
    const xs = series.points.map((p) => p.x)
    expect(xs).toEqual([...xs].sort((a, b) => a - b))
    // each bucket is the mean of its samples: the first covers the lowest populations
    expect(series.points[0].population).toBeLessThan(series.points[1].population as number)
    expect(buildSeries(samples, "game", {}, 0).points).toHaveLength(1000)
    expect(buildSeries(samples, "game", {}, 5000).points).toHaveLength(1000)
  })

  it("cuts a range from the newest sample (`last`) or between `from` and `to`", () => {
    const samples = run(0, 100, FRAMES_PER_GAME_DAY / 10) // 10 samples per game day
    const lastDay = buildSeries(samples, "game", { last: FRAMES_PER_GAME_DAY }, 0)
    expect(lastDay.points.length).toBe(11)
    expect(lastDay.extent?.max).toBe(99 * (FRAMES_PER_GAME_DAY / 10))
    const real = buildSeries(samples, "real", { from: 10_000, to: 20_000 }, 0)
    expect(real.points.map((p) => p.t)).toEqual([10_000, 11_000, 12_000, 13_000, 14_000, 15_000, 16_000, 17_000, 18_000, 19_000, 20_000])
  })

  it("an empty or out-of-range selection is an empty series, not an error", () => {
    expect(buildSeries([], "game", { last: 5 }, 100)).toMatchObject({ points: [], samples: 0, extent: null })
    expect(buildSeries(run(0, 5), "real", { from: 1e12 }, 100).points).toEqual([])
  })

  it("breaks the line between runs and leaves out samples that have no game time on the game axis", () => {
    const samples = [sample(1, 100, 0), sample(2, null, 0), sample(3, 200, 1), sample(4, 300, 1)]
    const game = buildSeries(samples, "game", {}, 0)
    expect(game.points.map((p) => [p.run, p.gap])).toEqual([[0, false], [1, true], [1, false]])
    expect(buildSeries(samples, "real", {}, 0).points).toHaveLength(4)
  })

  it("does not average a bucket across two runs", () => {
    const samples = [sample(1, 10, 0, { population: 10 }), sample(2, 20, 0, { population: 20 }), sample(3, 30, 1, { population: 1000 }), sample(4, 40, 1, { population: 2000 })]
    // run 1 starts later in game time, so both runs are on one timeline; 1 bucket would mix them
    const series = buildSeries(samples, "game", {}, 1)
    expect(series.points.map((p) => p.population)).toEqual([15, 1500])
  })
})
