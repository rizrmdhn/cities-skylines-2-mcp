/**
 * Trend history: a background recorder that samples the bridge while a city is loaded and keeps
 * per-city series on disk, plus the /api/desktop/trends* routes the Trends page reads.
 *
 * Polling (one tick every `trends.intervalSeconds`, default 60):
 *   GET /state                       always; the light check. No city / loading / paused / the
 *                                    simulation frame did not advance -> nothing else is asked.
 *   GET /city/overview, /city/demand, /city/budget   only when a sample will be recorded.
 * The bridge unreachable or failing -> exponential back-off up to 5 minutes.
 *
 * Storage: <userData>/trends/<city key>.jsonl, one JSON object per line, append-only. Line 1 is a
 * header ({"trends":1,"city":"<name>"}), every other line one sample (short keys, see CODES).
 * A torn last line (crash mid-append) or any unparsable line is skipped on load; a file with no
 * readable line at all is moved aside as <file>.corrupt-<time>. Rewrites (retention, thinning,
 * repair) go through a temp file + rename. Each city is capped at MAX_SAMPLES: past it, the
 * older half is thinned 2:1 (run boundaries kept), so old data gets sparser, never unbounded.
 *
 * Time: every sample has wall-clock time (t, ms) and game time: the simulation frame (f, from
 * /state, 262144 frames per game day; uniform, stops while paused) and the game's date string (g).
 * Charts on the game axis use the frame. A "run" (s) is one uninterrupted recording stretch; a
 * new run starts after the app starts, the bridge comes back, recording is switched on, another
 * city was loaded, or game time went backwards (an older save). On the game axis only the current
 * timeline is drawn: a run that starts earlier in game time hides the abandoned future of the
 * runs before it (the samples stay on disk and on the real-time axis).
 *
 * City identity: the bridge exposes only the city name, so a city is keyed by its name. Renaming
 * a city starts a new series; two different saves with the same name share one (their game times
 * interleave as separate runs).
 */
import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { appendFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { z } from "zod"

import { BridgeError, type BridgeClient } from "../bridge.ts"
import { defineFeature, type DesktopContext } from "../context.ts"
import type { Logger } from "../logger.ts"
import { RouteError } from "../routes.ts"
import type { Setting } from "../settings.ts"

declare module "../settings.ts" {
  interface SettingValues {
    "trends.enabled": boolean
    "trends.intervalSeconds": number
    "trends.retentionDays": number
  }
}

// ---- metrics ---------------------------------------------------------------------------------

/** Recorded values, by API name -> short key on disk. */
const CODES = {
  population: "pop",
  money: "money",
  happiness: "hap",
  health: "hlt",
  xp: "xp",
  income: "inc",
  expenses: "exp",
  demandResidentialLow: "dRl",
  demandResidentialMedium: "dRm",
  demandResidentialHigh: "dRh",
  demandCommercial: "dC",
  demandIndustrial: "dI",
  demandOffice: "dO",
} as const

export type MetricName = keyof typeof CODES
export const METRICS = Object.keys(CODES) as MetricName[]
export type MetricValues = Partial<Record<MetricName, number>>

/** Payload fields the recorder reads (see web/src/lib/bridge-types.ts). */
interface StatePayload {
  cityLoaded: boolean
  isLoading: boolean
  cityName: string | null
  simulation: { paused: boolean; frameIndex?: number; gameDateTime: string | null } | null
}
interface OverviewPayload {
  cityName: string
  population: number
  averageHappiness: number
  averageHealth: number
  money: number
  xp: number
  gameDateTime: string | null
}
interface DemandPayload {
  residential: { buildingDemand: { lowDensity: number; mediumDensity: number; highDensity: number } }
  commercial: { buildingDemand: number }
  industrial: { buildingDemand: number }
  office: { buildingDemand: number }
}
interface BudgetPayload {
  totalIncome: number
  totalExpenses: number
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

export function metricsFrom(
  overview: OverviewPayload,
  demand: DemandPayload | undefined,
  budget: BudgetPayload | undefined
): MetricValues {
  const values: MetricValues = {
    population: finite(overview.population),
    money: finite(overview.money),
    happiness: finite(overview.averageHappiness),
    health: finite(overview.averageHealth),
    xp: finite(overview.xp),
    income: finite(budget?.totalIncome),
    expenses: finite(budget?.totalExpenses),
    demandResidentialLow: finite(demand?.residential?.buildingDemand?.lowDensity),
    demandResidentialMedium: finite(demand?.residential?.buildingDemand?.mediumDensity),
    demandResidentialHigh: finite(demand?.residential?.buildingDemand?.highDensity),
    demandCommercial: finite(demand?.commercial?.buildingDemand),
    demandIndustrial: finite(demand?.industrial?.buildingDemand),
    demandOffice: finite(demand?.office?.buildingDemand),
  }
  for (const name of METRICS) if (values[name] === undefined) delete values[name]
  return values
}

// ---- samples and game time -------------------------------------------------------------------

export interface Sample {
  /** Wall-clock time, ms since the epoch. */
  t: number
  /** Simulation frame (/state simulation.frameIndex); null when the bridge did not send it. */
  frame: number | null
  /** The game's date and time, "yyyy-MM-dd HH:mm". */
  game: string | null
  /** Recording run, see the module comment. */
  run: number
  values: MetricValues
}

/** Frames per game hour, as the bridge's /sim/run counts them (262144 per game day). */
export const FRAMES_PER_GAME_DAY = 262144
export const FRAMES_PER_GAME_HOUR = FRAMES_PER_GAME_DAY / 24

/** "2026-03-14 08:30" -> minutes since 0001-01-01, or null. Only used to order samples without frames. */
export function gameMinutes(game: string | null): number | null {
  const match = game ? /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(game) : null
  if (!match) return null
  const [, y, mo, d, h, mi] = match.map(Number)
  const date = new Date(0)
  date.setUTCFullYear(y, mo - 1, d)
  date.setUTCHours(h, mi, 0, 0)
  return date.getTime() / 60_000
}

/** Game-time position of a sample: the frame, else (old bridges) game minutes scaled to frames. */
export function gameX(sample: Pick<Sample, "frame" | "game">): number | null {
  if (sample.frame !== null) return sample.frame
  const minutes = gameMinutes(sample.game)
  return minutes === null ? null : (minutes * FRAMES_PER_GAME_HOUR) / 60
}

/** Whether `next` lies before `previous` in game time (an older save was loaded). */
export function isBackwards(previous: Pick<Sample, "frame" | "game">, next: Pick<Sample, "frame" | "game">) {
  if (previous.frame !== null && next.frame !== null) return next.frame < previous.frame
  const a = gameMinutes(previous.game)
  const b = gameMinutes(next.game)
  return a !== null && b !== null && b < a
}

/** Whether game time moved since `previous` (false while paused). */
function hasAdvanced(previous: Pick<Sample, "frame" | "game">, next: Pick<Sample, "frame" | "game">) {
  if (previous.frame !== null && next.frame !== null) return next.frame !== previous.frame
  if (previous.game !== null && next.game !== null) return next.game !== previous.game
  return true
}

function encodeSample(sample: Sample): string {
  const line: Record<string, unknown> = { t: sample.t, s: sample.run }
  if (sample.frame !== null) line.f = sample.frame
  if (sample.game !== null) line.g = sample.game
  for (const name of METRICS) {
    const value = sample.values[name]
    if (value !== undefined) line[CODES[name]] = value
  }
  return JSON.stringify(line)
}

function decodeSample(raw: unknown): Sample | null {
  if (typeof raw !== "object" || raw === null) return null
  const line = raw as Record<string, unknown>
  const t = finite(line.t)
  const run = finite(line.s)
  if (t === undefined || run === undefined) return null
  const values: MetricValues = {}
  for (const name of METRICS) {
    const value = finite(line[CODES[name]])
    if (value !== undefined) values[name] = value
  }
  return {
    t,
    run,
    frame: finite(line.f) ?? null,
    game: typeof line.g === "string" ? line.g : null,
    values,
  }
}

// ---- thinning and retention ------------------------------------------------------------------

/** Most samples kept per city (about 1.5 MB of JSONL). */
export const MAX_SAMPLES = 10_000
/** After thinning a city holds at most this many. */
const THIN_TARGET = Math.floor(MAX_SAMPLES * 0.75)

/**
 * Drops every other sample in the older half until at most `target` remain. The first and last
 * sample of each run are always kept, so runs, gaps and the game-time lineage stay intact.
 */
export function thin(samples: Sample[], target: number): Sample[] {
  let current = samples
  while (current.length > target) {
    const half = Math.floor(current.length / 2)
    const kept: Sample[] = []
    let toggle = false
    for (let i = 0; i < current.length; i++) {
      const sample = current[i]
      const boundary =
        i === 0 || i === current.length - 1 || current[i - 1].run !== sample.run || current[i + 1].run !== sample.run
      if (i >= half || boundary) {
        kept.push(sample)
        continue
      }
      toggle = !toggle
      if (toggle) kept.push(sample)
    }
    if (kept.length === current.length) break // only boundaries left in the older half
    current = kept
  }
  return current
}

// ---- store -----------------------------------------------------------------------------------

export interface CitySummary {
  key: string
  name: string
  samples: number
  /** Wall-clock range, ms. */
  firstAt: number | null
  lastAt: number | null
  /** Game dates of the first and newest sample. */
  firstGame: string | null
  lastGame: string | null
}

interface CityData {
  key: string
  name: string
  samples: Sample[]
  /** Next run id handed out. */
  nextRun: number
  /** The file does not end with a newline (torn append): prefix the next append with one. */
  needsNewline: boolean
  /** The file has lines the loader skipped: rewrite it at the next opportunity. */
  dirty: boolean
}

const HEADER_VERSION = 1
const RETENTION_SLACK_MS = 86_400_000
const FILE_SUFFIX = ".jsonl"

/** File-name key of a city: readable slug + hash of the exact name. */
export function cityKey(name: string) {
  const slug =
    name
      .normalize("NFKD")
      .replace(/[^\w\s-]/g, "")
      .trim()
      .toLowerCase()
      .replace(/[\s_-]+/g, "-")
      .slice(0, 40) || "city"
  const hash = createHash("sha256").update(name, "utf8").digest("hex").slice(0, 8)
  return `${slug}-${hash}`
}

const KEY_PATTERN = /^[a-z0-9-]{1,64}$/

export interface TrendStoreOptions {
  dir: string
  log: Logger
  now: () => number
  /** Days to keep; 0 = no age limit. Read on every prune. */
  retentionDays: () => number
  maxSamples?: number
}

export type TrendStore = ReturnType<typeof createTrendStore>

export function createTrendStore(options: TrendStoreOptions) {
  const { dir, log, now } = options
  const maxSamples = options.maxSamples ?? MAX_SAMPLES
  const thinTarget = options.maxSamples ? Math.floor(options.maxSamples * 0.75) : THIN_TARGET
  const cities = new Map<string, Promise<CityData | null>>()
  /** Serializes all file work per city. */
  const queues = new Map<string, Promise<unknown>>()

  function fileOf(key: string) {
    return join(dir, key + FILE_SUFFIX)
  }

  function enqueue<T>(key: string, job: () => Promise<T>): Promise<T> {
    const previous = queues.get(key) ?? Promise.resolve()
    const next = previous.then(job, job)
    queues.set(
      key,
      next.catch(() => {})
    )
    return next
  }

  async function load(key: string): Promise<CityData | null> {
    const file = fileOf(key)
    let text: string
    try {
      text = await readFile(file, "utf8")
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null
      throw err
    }
    const lines = text.split("\n")
    let name: string | null = null
    const samples: Sample[] = []
    let skipped = 0
    for (const [index, line] of lines.entries()) {
      if (line.trim() === "") continue
      let raw: unknown
      try {
        raw = JSON.parse(line)
      } catch {
        skipped++
        continue
      }
      if (index === 0 && typeof raw === "object" && raw !== null && "trends" in raw) {
        const header = raw as { city?: unknown }
        if (typeof header.city === "string") name = header.city
        continue
      }
      const sample = decodeSample(raw)
      if (sample) samples.push(sample)
      else skipped++
    }
    if (name === null && samples.length === 0) {
      if (text.trim() !== "") {
        const aside = `${file}.corrupt-${now()}`
        log.warn(`${file} has no readable data; moved aside to ${aside}`)
        await rename(file, aside).catch(() => {})
      }
      return null
    }
    if (skipped) log.warn(`${file}: skipped ${skipped} unreadable line(s)`)
    // A file should already be in time order; sort defensively (stable) after a manual edit.
    samples.sort((a, b) => a.t - b.t)
    const data: CityData = {
      key,
      name: name ?? key.replace(/-[0-9a-f]{8}$/, ""),
      samples,
      nextRun: samples.reduce((max, s) => Math.max(max, s.run + 1), 0),
      needsNewline: text.length > 0 && !text.endsWith("\n"),
      dirty: skipped > 0 || name === null,
    }
    if (prune(data) || data.samples.length > maxSamples || data.dirty) await rewrite(data)
    return data
  }

  function get(key: string): Promise<CityData | null> {
    let entry = cities.get(key)
    if (!entry) {
      entry = enqueue(key, () => load(key))
      cities.set(key, entry)
      entry.catch(() => cities.delete(key))
    }
    return entry
  }

  /**
   * Applies retention; true when something was removed. `slackMs` lets expired samples pile up
   * for a while, so appends do not rewrite the file each time one sample expires.
   */
  function prune(data: CityData, slackMs = 0): boolean {
    const days = options.retentionDays()
    if (days <= 0 || data.samples.length === 0) return false
    const cutoff = now() - days * 86_400_000
    if (data.samples[0].t >= cutoff - slackMs) return false
    data.samples = data.samples.filter((sample) => sample.t >= cutoff)
    return true
  }

  async function rewrite(data: CityData) {
    if (data.samples.length > maxSamples) data.samples = thin(data.samples, thinTarget)
    const body =
      [JSON.stringify({ trends: HEADER_VERSION, city: data.name }), ...data.samples.map(encodeSample)].join("\n") +
      "\n"
    const file = fileOf(data.key)
    const temp = `${file}.tmp`
    await mkdir(dir, { recursive: true })
    await writeFile(temp, body, "utf8")
    await rename(temp, file)
    data.needsNewline = false
    data.dirty = false
  }

  return {
    dir,

    /** Opens (or creates in memory) the series of `name`; resolves its key. */
    async open(name: string): Promise<string> {
      const key = cityKey(name)
      const existing = await get(key)
      if (!existing) {
        cities.set(
          key,
          Promise.resolve({ key, name, samples: [], nextRun: 0, needsNewline: false, dirty: false })
        )
      }
      return key
    },

    /** A new run id for `key` (call open first). */
    async newRun(key: string): Promise<number> {
      const data = await get(key)
      if (!data) throw new Error(`unknown city ${key}`)
      return data.nextRun++
    },

    /** The newest sample of `key`, or null. */
    async last(key: string): Promise<Sample | null> {
      const data = await get(key)
      return data?.samples.at(-1) ?? null
    },

    /**
     * Appends one sample (crash-safe: one write of one full line). `name` recreates the series
     * when it was cleared since `open`.
     */
    append(key: string, name: string, sample: Sample): Promise<void> {
      return enqueue(key, async () => {
        let data = await cities.get(key)
        if (!data) {
          data = { key, name, samples: [], nextRun: sample.run + 1, needsNewline: false, dirty: false }
          cities.set(key, Promise.resolve(data))
        }
        data.samples.push(sample)
        const file = fileOf(key)
        const expired = prune(data, RETENTION_SLACK_MS)
        if (expired || data.samples.length > maxSamples || data.dirty || !existsSync(file)) {
          await rewrite(data)
          return
        }
        const line = (data.needsNewline ? "\n" : "") + encodeSample(sample) + "\n"
        await appendFile(file, line, "utf8")
        data.needsNewline = false
      })
    },

    /** Samples of `key` in wall-clock order (a copy of the array, not of the samples). */
    async samples(key: string): Promise<Sample[] | null> {
      const data = await get(key)
      return data ? [...data.samples] : null
    },

    async summary(key: string): Promise<CitySummary | null> {
      const data = await get(key)
      if (!data || data.samples.length === 0) return null
      const first = data.samples[0]
      const last = data.samples[data.samples.length - 1]
      return {
        key,
        name: data.name,
        samples: data.samples.length,
        firstAt: first.t,
        lastAt: last.t,
        firstGame: first.game,
        lastGame: last.game,
      }
    },

    /** Every city with at least one sample, most recently recorded first. */
    async list(): Promise<CitySummary[]> {
      let names: string[] = []
      try {
        names = await readdir(dir)
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err
      }
      const keys = new Set(
        names.filter((n) => n.endsWith(FILE_SUFFIX)).map((n) => n.slice(0, -FILE_SUFFIX.length))
      )
      for (const key of cities.keys()) keys.add(key)
      const summaries = await Promise.all(
        [...keys].filter((key) => KEY_PATTERN.test(key)).map((key) => this.summary(key).catch(() => null))
      )
      return summaries
        .filter((s): s is CitySummary => s !== null)
        .sort((a, b) => (b.lastAt ?? 0) - (a.lastAt ?? 0))
    },

    /** Deletes a city's file and memory. Resolves false when there was nothing to delete. */
    clear(key: string): Promise<boolean> {
      return enqueue(key, async () => {
        const file = fileOf(key)
        const had = cities.has(key) || existsSync(file)
        cities.delete(key)
        await rm(file, { force: true })
        return had
      })
    },

    async clearAll(): Promise<number> {
      const summaries = await this.list()
      const keys = new Set([...summaries.map((s) => s.key), ...cities.keys()])
      let cleared = 0
      for (const key of keys) if (await this.clear(key)) cleared++
      return cleared
    },

    /** Total bytes on disk (status route). */
    async bytes(): Promise<number> {
      try {
        const names = await readdir(dir)
        const sizes = await Promise.all(
          names.filter((n) => n.endsWith(FILE_SUFFIX)).map((n) => stat(join(dir, n)).then((s) => s.size, () => 0))
        )
        return sizes.reduce((a, b) => a + b, 0)
      } catch {
        return 0
      }
    },

    /** Waits for all pending file work (tests, quit). */
    async flush() {
      await Promise.all([...queues.values()])
    },

    /** Forgets in-memory state (a test simulating a restart). */
    forget() {
      cities.clear()
    },

    /** Validates a key coming from a request. */
    isKey(key: string) {
      return KEY_PATTERN.test(key)
    },
  }
}

// ---- series for plotting ---------------------------------------------------------------------

export type Axis = "game" | "real"

export interface SeriesPoint extends Partial<Record<MetricName, number | null>> {
  /** Position on the requested axis: frame (game) or ms (real). */
  x: number
  t: number
  frame: number | null
  game: string | null
  run: number
  /** Starts a new line: do not connect it to the previous point. */
  gap: boolean
}

/**
 * The current game timeline: runs in recording order; a run that starts at or before game time
 * already covered drops the samples after that point (they belong to a timeline the player left).
 * Samples without any game time are left out of the game axis.
 */
export function gameLineage(samples: Sample[]): (Sample & { x: number })[] {
  const lineage: (Sample & { x: number })[] = []
  let currentRun: number | null = null
  for (const sample of samples) {
    const x = gameX(sample)
    if (x === null) continue
    if (sample.run !== currentRun) {
      currentRun = sample.run
      while (lineage.length && lineage[lineage.length - 1].x >= x) lineage.pop()
    } else if (lineage.length && lineage[lineage.length - 1].x > x) {
      continue // defensive: never draw backwards inside a run
    }
    lineage.push({ ...sample, x })
  }
  return lineage
}

/**
 * Samples between `from` and `to` (axis units, inclusive) reduced to at most `points`: the range
 * is cut into equal buckets and each bucket (per run) becomes one point with the mean of each
 * metric and the time fields of its newest sample. points = 0 returns the raw samples.
 */
export function buildSeries(
  samples: Sample[],
  axis: Axis,
  range: { from?: number; to?: number; last?: number },
  points: number
) {
  const positioned = axis === "game" ? gameLineage(samples) : samples.map((s) => ({ ...s, x: s.t }))
  const extent = positioned.length
    ? { min: positioned[0].x, max: positioned[positioned.length - 1].x }
    : null
  let from = range.from ?? -Infinity
  let to = range.to ?? Infinity
  if (range.last !== undefined && extent) {
    to = Math.min(to, extent.max)
    from = Math.max(from, extent.max - range.last)
  }
  const inRange = positioned.filter((s) => s.x >= from && s.x <= to)
  const lo = inRange.length ? inRange[0].x : 0
  const hi = inRange.length ? inRange[inRange.length - 1].x : 0
  const out: SeriesPoint[] = []
  const toPoint = (group: (Sample & { x: number })[]): SeriesPoint => {
    const last = group[group.length - 1]
    const point: SeriesPoint = {
      x: group.length === 1 ? last.x : group.reduce((sum, s) => sum + s.x, 0) / group.length,
      t: last.t,
      frame: last.frame,
      game: last.game,
      run: last.run,
      gap: false,
    }
    for (const name of METRICS) {
      let sum = 0
      let count = 0
      for (const s of group) {
        const value = s.values[name]
        if (value !== undefined) {
          sum += value
          count++
        }
      }
      point[name] = count ? sum / count : null
    }
    return point
  }
  if (points <= 0 || inRange.length <= points) {
    for (const s of inRange) out.push(toPoint([s]))
  } else {
    const width = (hi - lo) / points || 1
    let group: (Sample & { x: number })[] = []
    let groupBucket = -1
    for (const s of inRange) {
      const bucket = Math.min(points - 1, Math.floor((s.x - lo) / width))
      if (group.length && (bucket !== groupBucket || group[0].run !== s.run)) {
        out.push(toPoint(group))
        group = []
      }
      groupBucket = bucket
      group.push(s)
    }
    if (group.length) out.push(toPoint(group))
  }
  for (let i = 1; i < out.length; i++) {
    // New run = a recording interruption or a jump in game time: break the line.
    out[i].gap = out[i].run !== out[i - 1].run
  }
  return {
    axis,
    extent,
    from: Number.isFinite(from) ? from : (extent?.min ?? null),
    to: Number.isFinite(to) ? to : (extent?.max ?? null),
    /** Raw samples in the range (before reduction). */
    samples: inRange.length,
    points: out,
  }
}

// ---- recorder --------------------------------------------------------------------------------

export type RecorderState =
  | "disabled" // trends.enabled is false
  | "starting" // before the first poll
  | "unreachable" // the bridge did not answer (backing off)
  | "error" // the bridge answered with an error (e.g. 401), backing off
  | "no-city" // no city loaded / loading
  | "paused" // a city is loaded but game time is not advancing
  | "recording"

export interface RecorderStatus {
  state: RecorderState
  city: { key: string; name: string } | null
  lastSampleAt: number | null
  /** Samples recorded since the app started. */
  sessionSamples: number
  /** When the next poll runs (ms since the epoch), null when stopped. */
  nextPollAt: number | null
  error: string | null
  consecutiveFailures: number
}

/** Longest wait between polls while backing off. */
export const MAX_BACKOFF_MS = 5 * 60_000
/** Shortest wait between light checks while no city is loaded. */
export const IDLE_CHECK_MS = 30_000

export interface RecorderOptions {
  bridge: BridgeClient
  store: TrendStore
  log: Logger
  now: () => number
  enabled: () => boolean
  intervalSeconds: () => number
}

export function createRecorder(options: RecorderOptions) {
  const { bridge, store, log, now } = options
  const status: RecorderStatus = {
    state: options.enabled() ? "starting" : "disabled",
    city: null,
    lastSampleAt: null,
    sessionSamples: 0,
    nextPollAt: null,
    error: null,
    consecutiveFailures: 0,
  }
  /** The run being appended to, per city; cleared whenever recording was interrupted. */
  let openRun: { key: string; run: number } | null = null
  /**
   * Game clock of the previous successful poll, recorded or not. An older save usually loads
   * paused and may run past the newest sample before the next recorded poll, so "game time went
   * backwards" is also checked against this, not only against the newest stored sample.
   */
  let previousClock: { key: string; frame: number | null; game: string | null } | null = null
  let timer: NodeJS.Timeout | undefined
  let running = false
  /** Bumped on start/stop/restart so a superseded loop does not schedule again. */
  let generation = 0
  /** Polls never overlap: each waits for the previous one. */
  let inFlight: Promise<unknown> = Promise.resolve()

  const intervalMs = () => options.intervalSeconds() * 1000

  function interrupt() {
    openRun = null
  }

  function fail(err: unknown): number {
    interrupt()
    status.consecutiveFailures++
    if (err instanceof BridgeError) {
      status.state = err.kind === "unreachable" ? "unreachable" : "error"
      status.error = err.message
    } else {
      status.state = "error"
      status.error = err instanceof Error ? err.message : String(err)
      log.error("trend poll failed", err)
    }
    // Never sooner than the normal interval (it may be longer than the back-off cap).
    return Math.max(intervalMs(), Math.min(MAX_BACKOFF_MS, intervalMs() * 2 ** status.consecutiveFailures))
  }

  async function optional<T>(path: string): Promise<T | undefined> {
    try {
      return await bridge.get<T>(path)
    } catch (err) {
      if (!(err instanceof BridgeError) || err.kind === "unreachable") throw err
      log.debug(`${path} unavailable: ${err.message}`)
      return undefined
    }
  }

  /** One poll; resolves the delay until the next one. */
  async function poll(): Promise<number> {
    if (!options.enabled()) {
      status.state = "disabled"
      interrupt()
      return intervalMs()
    }
    let state: StatePayload
    try {
      state = await bridge.get<StatePayload>("/state")
    } catch (err) {
      return fail(err)
    }
    status.consecutiveFailures = 0
    status.error = null
    if (!state.cityLoaded || state.isLoading || !state.cityName || !state.simulation) {
      status.state = "no-city"
      status.city = null
      previousClock = null
      interrupt()
      return Math.max(intervalMs(), IDLE_CHECK_MS)
    }

    const key = await store.open(state.cityName)
    status.city = { key, name: state.cityName }
    if (openRun && openRun.key !== key) interrupt() // another city was loaded
    const clock = {
      frame: finite(state.simulation.frameIndex) ?? null,
      game: state.simulation.gameDateTime ?? null,
    }
    if (previousClock && (previousClock.key !== key || isBackwards(previousClock, clock))) interrupt()
    previousClock = { key, ...clock }
    const last = await store.last(key)
    // Paused, or game time has not moved since the newest sample: nothing new to record.
    if (state.simulation.paused || (last && !hasAdvanced(last, clock))) {
      status.state = "paused"
      return intervalMs()
    }

    let overview: OverviewPayload
    let demand: DemandPayload | undefined
    let budget: BudgetPayload | undefined
    try {
      // One after the other: each request runs on the game's main thread.
      overview = await bridge.get<OverviewPayload>("/city/overview")
      demand = await optional<DemandPayload>("/city/demand")
      budget = await optional<BudgetPayload>("/city/budget")
    } catch (err) {
      return fail(err)
    }
    if (overview.cityName !== state.cityName) {
      // A city was loaded between the requests: try again next time.
      interrupt()
      return intervalMs()
    }

    if (last && isBackwards(last, clock)) interrupt() // an older save: a new timeline
    if (!openRun) openRun = { key, run: await store.newRun(key) }
    const sample: Sample = {
      t: now(),
      frame: clock.frame,
      game: clock.game ?? overview.gameDateTime ?? null,
      run: openRun.run,
      values: metricsFrom(overview, demand, budget),
    }
    await store.append(key, state.cityName, sample)
    status.state = "recording"
    status.lastSampleAt = sample.t
    status.sessionSamples++
    return intervalMs()
  }

  /** Runs one poll after the one in progress; resolves the delay until the next. */
  function runPoll(): Promise<number> {
    const job = inFlight.then(() => poll()).catch((err: unknown) => fail(err))
    inFlight = job
    return job
  }

  async function loop(gen: number) {
    const delay = await runPoll()
    if (!running || gen !== generation) return
    status.nextPollAt = now() + delay
    timer = setTimeout(() => void loop(gen), delay)
  }

  return {
    status: () => ({ ...status }),
    /** Starts polling now. */
    start() {
      if (running) return
      running = true
      void loop(++generation)
    },
    stop() {
      running = false
      generation++
      clearTimeout(timer)
      status.nextPollAt = null
    },
    /** Polls again now and continues on the current interval (a setting changed). */
    restart() {
      if (!running) return
      clearTimeout(timer)
      void loop(++generation)
    },
    /** A poll outside the schedule; resolves its delay once it finished (tests). */
    pollNow: () => runPoll(),
    /** Resolves when the poll in progress (if any) finished. */
    idle: () => inFlight.then(() => {}),
    /** Forget the open run (data cleared). */
    interrupt,
    setDisabled() {
      status.state = "disabled"
      status.city = null
      interrupt()
    },
  }
}

// ---- feature ---------------------------------------------------------------------------------

const seriesQuery = z.object({
  city: z.string().regex(KEY_PATTERN, "city: unknown city key"),
  axis: z.enum(["game", "real"]).default("game"),
  from: z.coerce.number().optional(),
  to: z.coerce.number().optional(),
  last: z.coerce.number().positive().optional(),
  points: z.coerce.number().int().min(0).max(5_000).default(600),
})

const clearBody = z.union([
  z.object({ city: z.string().regex(KEY_PATTERN, "city: unknown city key") }).strict(),
  z.object({ all: z.literal(true) }).strict(),
])

export interface TrendsFeatureOptions {
  /** Folder for the series files (default <userData>/trends). */
  dir?: string
  /** Wall clock (default Date.now). */
  now?: () => number
  /** Per-city cap (default MAX_SAMPLES). */
  maxSamples?: number
}

export interface TrendsSettings {
  enabled: Setting<boolean>
  intervalSeconds: Setting<number>
  retentionDays: Setting<number>
}

export function defineTrendsSettings(ctx: DesktopContext): TrendsSettings {
  return {
    enabled: ctx.settings.define("trends.enabled", { schema: z.boolean(), default: true }),
    intervalSeconds: ctx.settings.define("trends.intervalSeconds", {
      schema: z.number().int().min(10).max(3600),
      default: 60,
    }),
    retentionDays: ctx.settings.define("trends.retentionDays", {
      schema: z.number().int().min(0).max(3650),
      default: 365,
    }),
  }
}

export function createTrendsFeature(featureOptions: TrendsFeatureOptions = {}) {
  return defineFeature({
    id: "trends",
    setup(ctx) {
      const now = featureOptions.now ?? Date.now
      const settings = defineTrendsSettings(ctx)
      const store = createTrendStore({
        dir: featureOptions.dir ?? join(ctx.paths.userData, "trends"),
        log: ctx.log,
        now,
        retentionDays: () => settings.retentionDays.get(),
        maxSamples: featureOptions.maxSamples,
      })
      const recorder = createRecorder({
        bridge: ctx.bridge,
        store,
        log: ctx.log,
        now,
        enabled: () => settings.enabled.get(),
        intervalSeconds: () => settings.intervalSeconds.get(),
      })

      ctx.routes.get("/desktop/trends", async () => ({
        ...recorder.status(),
        enabled: settings.enabled.get(),
        intervalSeconds: settings.intervalSeconds.get(),
        retentionDays: settings.retentionDays.get(),
        maxSamplesPerCity: featureOptions.maxSamples ?? MAX_SAMPLES,
        bytes: await store.bytes(),
      }))
      ctx.routes.get("/desktop/trends/cities", async () => ({ cities: await store.list() }))
      ctx.routes.get("/desktop/trends/series", async (request) => {
        const query = seriesQuery.parse(Object.fromEntries(request.query))
        const samples = await store.samples(query.city)
        const summary = await store.summary(query.city)
        if (!samples || !summary) throw new RouteError(404, `no trend data for city "${query.city}"`)
        return {
          city: { key: summary.key, name: summary.name },
          metrics: METRICS,
          framesPerDay: FRAMES_PER_GAME_DAY,
          ...buildSeries(samples, query.axis, query, query.points),
        }
      })
      ctx.routes.post("/desktop/trends/clear", async (request) => {
        const body = request.parse(clearBody)
        await recorder.idle()
        if ("all" in body) {
          const cleared = await store.clearAll()
          recorder.interrupt()
          ctx.log.info(`cleared trend data of ${cleared} cities`)
          return { cleared }
        }
        const had = await store.clear(body.city)
        recorder.interrupt()
        ctx.log.info(`cleared trend data of ${body.city}`)
        return { cleared: had ? 1 : 0 }
      })

      settings.enabled.onChange((enabled) => {
        ctx.log.info(`recording ${enabled ? "on" : "off"}`)
        if (!enabled) recorder.setDisabled()
        recorder.restart()
      })
      settings.intervalSeconds.onChange(() => recorder.restart())

      ctx.onReady(() => recorder.start())
      ctx.onBeforeQuit(async () => {
        recorder.stop()
        await recorder.idle()
        await store.flush()
      })
    },
  })
}

export default createTrendsFeature()
