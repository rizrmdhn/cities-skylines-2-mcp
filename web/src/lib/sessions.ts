import type { HistoryEntry } from "@/lib/bridge-types"
import { markerCentre, markerShapeFor, type MarkerShape } from "@/lib/history-markers"
import type { WorldPoint } from "@/lib/world"

/*
 * AI sessions: the bridge's change log (GET /history) grouped into steps and sessions.
 *
 * What the bridge records (CS2MCP.Bridge/BridgeSystem.Session.cs, .Batch.cs):
 *   - one entry per state-changing request that was not a dry run, appended when the operation
 *     finished; `id` counts up per game process (it does NOT restart when a save is loaded, it
 *     DOES restart at 1 when the game restarts), so within one game run id order = completion order;
 *   - `timeUtc` is when the operation STARTED (second precision); `gameTime` the in-game clock when
 *     it finished;
 *   - the log is cleared when a save is loaded and capped at the newest 300 entries;
 *   - a batch (/build/batch, and /build/interchange which runs as one) logs each operation it runs
 *     as its own entry with `batchChild: true`, and then the batch request itself when the whole
 *     job finished. The batch entry therefore comes AFTER its parts, starts before them, and its
 *     `moneyDelta` covers every part (plus anything else that hit the treasury meanwhile). A batch
 *     answers 200 even when a part failed. Only one batch runs at a time; requests that do not
 *     spend money may still interleave with its parts;
 *   - there is no session id, client id or request grouping of any kind.
 *
 * So the grouping rules are ours:
 *   - Step: one plain request, or one batch = the batch entry plus the `batchChild` entries logged
 *     since the previous batch. Parts whose batch entry is not in the log (still running, or lost)
 *     form a batch step without a summary entry. A step's money is the batch entry's `moneyDelta`
 *     (never the parts again); without one, the sum of its parts.
 *   - Session: consecutive steps, oldest first. A new session starts when a step starts more than
 *     SESSION_GAP_MS (15 minutes of wall-clock time) after the latest start in the current session,
 *     or when the entry ids go backwards (the game was restarted: only possible in the desktop
 *     app's archive, which keeps entries across game runs).
 */

/** Wall-clock pause that ends a session. */
export const SESSION_GAP_MS = 15 * 60 * 1000

/** Requests that run as a batch and log their operations as `batchChild` entries. */
export const BATCH_PATHS: readonly string[] = ["/build/batch", "/build/interchange"]

export interface Step {
  /** 1-based position in its session. */
  index: number
  kind: "single" | "batch"
  /** The plain request, or the batch request itself (undefined when not logged yet / lost). */
  entry: HistoryEntry | undefined
  /** A batch's operations, in the order they ran. Empty for a single step. */
  parts: HistoryEntry[]
  /** Earliest start among its entries (ms since epoch). */
  startMs: number
  /** Latest start among its entries (ms since epoch). */
  endMs: number
  /** False when the request or any part failed. */
  ok: boolean
  /** Parts that failed (a batch can answer 200 with failed parts). */
  failedParts: number
  /** Treasury change across the step; negative = spent. */
  moneyDelta: number
  /** The step's positions on the map: its own, or each part's. */
  shapes: MarkerShape[]
  /** Representative path: the request's, or (for a batch without its entry) "/build/batch". */
  path: string
}

export interface PlaceSummary {
  /** Centre of the bounding box of every position in the session. */
  centre: WorldPoint
  min: WorldPoint
  max: WorldPoint
  /** Steps that carry at least one position. */
  steps: number
}

export interface CountItem {
  name: string
  count: number
}

export interface Session {
  /** Stable while the session's first entry stays in the log: "<first entry id>-<its start, unix seconds>". */
  key: string
  /** 1-based, oldest session = 1. */
  number: number
  steps: Step[]
  startMs: number
  endMs: number
  durationMs: number
  /** Number of log entries (a batch counts its entry and each part). */
  entryCount: number
  succeeded: number
  failed: number
  /** Money that left the treasury: the sum of the negative step deltas, as a positive number. */
  spent: number
  /** Sum of every step's delta (refunds and income during operations included). */
  netMoney: number
  /** Operations by path (batch parts counted individually, the batch request itself not). */
  actions: CountItem[]
  /** Assets named in `prefab` parameters, most used first. */
  prefabs: CountItem[]
  place: PlaceSummary | undefined
  gameTimeStart: string | null
  gameTimeEnd: string | null
  /** Whether the newest step is a batch still running (parts logged, batch entry not yet). */
  running: boolean
}

export function entryTimeMs(entry: HistoryEntry) {
  const ms = Date.parse(entry.timeUtc)
  return Number.isNaN(ms) ? 0 : ms
}

/** Identity of an entry across game runs: ids restart when the game restarts. */
export function entryKey(entry: Pick<HistoryEntry, "id" | "timeUtc" | "path">) {
  return `${entry.id}|${entry.timeUtc}|${entry.path}`
}

export function sessionKeyFor(entry: HistoryEntry) {
  return `${entry.id}-${Math.floor(entryTimeMs(entry) / 1000)}`
}

function count(names: string[]): CountItem[] {
  const counts = new Map<string, number>()
  for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1)
  return [...counts]
    .map(([name, n]) => ({ name, count: n }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
}

function makeStep(entry: HistoryEntry | undefined, parts: HistoryEntry[]): Step {
  const all = entry ? [...parts, entry] : parts
  const times = all.map(entryTimeMs)
  const failedParts = parts.filter((part) => !part.ok).length
  const shapes = (parts.length > 0 ? parts : all)
    .map(markerShapeFor)
    .filter((shape): shape is MarkerShape => shape !== undefined)
  // A batch that ran no part still has its own request (and maybe a position).
  if (shapes.length === 0 && entry && parts.length > 0) {
    const own = markerShapeFor(entry)
    if (own) shapes.push(own)
  }
  return {
    index: 0,
    kind: parts.length > 0 ? "batch" : "single",
    entry,
    parts,
    startMs: Math.min(...times),
    endMs: Math.max(...times),
    ok: (entry?.ok ?? true) && failedParts === 0,
    failedParts,
    moneyDelta: entry ? entry.moneyDelta : parts.reduce((sum, part) => sum + part.moneyDelta, 0),
    shapes,
    path: entry?.path ?? "/build/batch",
  }
}

/**
 * Steps in the order they started, oldest first. `entries` is the bridge's order: newest first.
 * `run` counts game runs: it goes up each time the ids go backwards (the game restarted).
 */
export function groupSteps(entries: readonly HistoryEntry[]): { step: Step; run: number }[] {
  const oldestFirst = [...entries].reverse()
  const slots: ({ step: Step; run: number } | null)[] = []
  let pending: HistoryEntry[] = []
  let pendingSlot = -1
  let previousId: number | undefined
  let run = 0

  const flushPending = (entry: HistoryEntry | undefined) => {
    if (pending.length === 0) return
    slots[pendingSlot] = { step: makeStep(entry, pending), run }
    pending = []
    pendingSlot = -1
  }

  for (const entry of oldestFirst) {
    // Ids went backwards: the game restarted; a batch cannot span that.
    if (previousId !== undefined && entry.id < previousId) {
      flushPending(undefined)
      run++
    }
    previousId = entry.id

    if (entry.batchChild) {
      if (pending.length === 0) {
        pendingSlot = slots.length
        slots.push(null)
      }
      pending.push(entry)
    } else if (pending.length > 0 && BATCH_PATHS.includes(entry.path)) {
      flushPending(entry)
    } else {
      slots.push({ step: makeStep(entry, []), run })
    }
  }
  flushPending(undefined)
  return slots.filter((slot) => slot !== null)
}

function summarise(steps: Step[], number: number, running: boolean): Session {
  steps.forEach((step, i) => (step.index = i + 1))
  const entries = steps.flatMap((step) => (step.entry ? [...step.parts, step.entry] : step.parts))
  const operations = steps.flatMap((step) => (step.parts.length > 0 ? step.parts : step.entry ? [step.entry] : []))
  const startMs = Math.min(...steps.map((step) => step.startMs))
  const endMs = Math.max(...steps.map((step) => step.endMs))
  const shapes = steps.flatMap((step) => step.shapes)
  const points = shapes.flatMap((shape) => (shape.kind === "point" ? [shape.at] : [shape.from, shape.to]))
  let place: PlaceSummary | undefined
  if (points.length > 0) {
    const min = { x: Math.min(...points.map((p) => p.x)), z: Math.min(...points.map((p) => p.z)) }
    const max = { x: Math.max(...points.map((p) => p.x)), z: Math.max(...points.map((p) => p.z)) }
    place = {
      centre: { x: (min.x + max.x) / 2, z: (min.z + max.z) / 2 },
      min,
      max,
      steps: steps.filter((step) => step.shapes.length > 0).length,
    }
  }
  const byId = [...entries].sort((a, b) => a.id - b.id)
  const gameTimes = byId.map((entry) => entry.gameTime).filter((time): time is string => !!time)
  return {
    // The entry logged first: a batch's first part, not the batch entry logged after its parts.
    key: sessionKeyFor(steps[0].parts[0] ?? steps[0].entry!),
    number,
    steps,
    startMs,
    endMs,
    durationMs: endMs - startMs,
    entryCount: entries.length,
    succeeded: steps.filter((step) => step.ok).length,
    failed: steps.filter((step) => !step.ok).length,
    spent: steps.reduce((sum, step) => sum + Math.max(0, -step.moneyDelta), 0),
    netMoney: steps.reduce((sum, step) => sum + step.moneyDelta, 0),
    actions: count(operations.map((entry) => entry.path)),
    prefabs: count(operations.map((entry) => entry.query?.prefab).filter((prefab): prefab is string => !!prefab)),
    place,
    gameTimeStart: gameTimes[0] ?? null,
    gameTimeEnd: gameTimes.at(-1) ?? null,
    running,
  }
}

export interface GroupOptions {
  /** The bridge says a batch is running: trailing parts without their batch entry are in flight. */
  batchRunning?: boolean
  gapMs?: number
}

/** Sessions, newest first. `entries` is the bridge's order: newest first. */
export function groupSessions(entries: readonly HistoryEntry[], options: GroupOptions = {}): Session[] {
  const gapMs = options.gapMs ?? SESSION_GAP_MS
  const slots = groupSteps(entries)
  const groups: Step[][] = []
  let current: Step[] = []
  let currentEnd = -Infinity
  let currentRun = 0
  for (const { step, run } of slots) {
    if (current.length > 0 && (run !== currentRun || step.startMs - currentEnd > gapMs)) {
      groups.push(current)
      current = []
      currentEnd = -Infinity
    }
    current.push(step)
    currentEnd = Math.max(currentEnd, step.endMs)
    currentRun = run
  }
  if (current.length > 0) groups.push(current)

  return groups
    .map((steps, i) => {
      const isNewest = i === groups.length - 1
      const last = steps.at(-1)!
      const running = isNewest && !!options.batchRunning && last.kind === "batch" && last.entry === undefined
      return summarise(steps, i + 1, running)
    })
    .reverse()
}

/** Every entry of a step, in the order they ran (a batch's entry last). */
export function stepEntries(step: Step): HistoryEntry[] {
  return step.entry ? [...step.parts, step.entry] : step.parts
}

/** The entry a step links to: the request itself, or a batch's first part. */
export function stepPrimaryEntry(step: Step): HistoryEntry {
  return step.entry ?? step.parts[0]
}

export function findSession(sessions: readonly Session[], key: string | undefined) {
  return key === undefined ? undefined : sessions.find((session) => session.key === key)
}

export function sessionOfEntry(sessions: readonly Session[], entryId: number | undefined) {
  if (entryId === undefined) return undefined
  return sessions.find((session) =>
    session.steps.some((step) => stepEntries(step).some((entry) => entry.id === entryId))
  )
}

/** Centre of a step on the map, if it has a position. */
export function stepCentre(step: Step): WorldPoint | undefined {
  if (step.shapes.length === 0) return undefined
  const centres = step.shapes.map(markerCentre)
  return {
    x: centres.reduce((sum, p) => sum + p.x, 0) / centres.length,
    z: centres.reduce((sum, p) => sum + p.z, 0) / centres.length,
  }
}

export type StatusFilter = "all" | "ok" | "failed"

/** Whether a step passes the activity page's filters (a batch matches through any part). */
export function stepMatches(step: Step, status: StatusFilter, kind: string | undefined) {
  if (status === "ok" && !step.ok) return false
  if (status === "failed" && step.ok) return false
  if (kind === undefined) return true
  return stepEntries(step).some((entry) => entry.path === kind) || step.path === kind
}

/** "1 h 5 min", "12 min", "40 s". */
export function formatDuration(ms: number) {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds} s`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`
}
