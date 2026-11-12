/**
 * Native Windows notifications for what happens in the game while the companion is not in front.
 *
 * A background poller (own timer, own cadence, see "Polling") feeds small trackers; each tracker
 * turns what it sees into at most a few notifications:
 *
 *   - connection:    the game/bridge became unreachable ("lost") or reachable again, debounced
 *   - cityLoaded:    a city was loaded (or another one), debounced
 *   - warnings:      a warning type of /city/notifications newly appears or grows (grouped in one toast)
 *   - aiActivity:    one summary per burst of AI actions ("AI made 5 changes, spent ¢64,000")
 *   - aiFailures:    one notification per burst for the AI actions that failed
 *   - spendingLimit: the AI's spending limit is nearly (or completely) used up
 *   - forcedPause:   the game has been paused by a popup for a while, which blocks AI control
 *
 * Nothing is shown while the main window is focused (setting), nor in quiet mode. While nothing
 * could be shown the poller sleeps (no requests at all) and its baselines are dropped, so what
 * happened meanwhile is never announced afterwards. Clicking a toast opens the main window on the
 * relevant page. The test notification ignores every filter.
 *
 *   GET  /api/desktop/notifications        the last 50 notifications (shown or suppressed) + status
 *   POST /api/desktop/notifications/test   shows a sample notification
 *
 * The Electron part (Notification) is behind NotifierView so the logic stays Node-testable.
 */
import { z } from "zod"

import { appUrl } from "../app-protocol.ts"
import { BridgeError } from "../bridge.ts"
import { defineFeature, type DesktopContext, type DesktopFeature } from "../context.ts"
import { RouteError } from "../routes.ts"

// ---------------------------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------------------------

export type EventKind =
  | "connection"
  | "cityLoaded"
  | "warnings"
  | "aiActivity"
  | "aiFailures"
  | "spendingLimit"
  | "forcedPause"
  | "test"

/** Why a notification was not shown. */
export type Suppression = "disabled" | "quiet" | "focused" | "unsupported" | "cooldown" | "error"

export interface Draft {
  kind: EventKind
  title: string
  body: string
  /** Page of the web app the click opens, e.g. "/activity?session=12-1731400000". */
  route: string
}

export interface LogEntry extends Draft {
  id: number
  /** ms since epoch */
  at: number
  shown: boolean
  suppressed: Suppression | null
  clicked: boolean
}

export const LOG_LIMIT = 50

/** Poll cadence (ms): the bridge answers on the game's main thread, so keep requests few. */
export const POLL_CONNECTED_MS = 10_000
export const POLL_IDLE_MS = 15_000
export const POLL_BACKOFF_MAX_MS = 60_000
/** How often the sleeping poller checks whether it may work again (no network). */
export const RECHECK_MS = 5_000
export const WARNINGS_EVERY_MS = 60_000
/** AI actions this long apart end a burst. */
export const BURST_QUIET_MS = 20_000
/** A burst that keeps going is reported at least this often. */
export const BURST_MAX_MS = 5 * 60_000
/** The activity page's session gap (web/src/lib/sessions.ts SESSION_GAP_MS). */
export const SESSION_GAP_MS = 15 * 60_000
export const HISTORY_LIMIT = 200

/** Minimum time between two toasts of the same kind (flapping connections, repeated loads). */
const MIN_GAP_MS: Partial<Record<EventKind, number>> = {
  connection: 60_000,
  cityLoaded: 30_000,
  forcedPause: 60_000,
}

const KIND_SETTING: Record<Exclude<EventKind, "test">, string> = {
  connection: "notifications.connection",
  cityLoaded: "notifications.cityLoaded",
  warnings: "notifications.warnings",
  aiActivity: "notifications.aiActivity",
  aiFailures: "notifications.aiFailures",
  spendingLimit: "notifications.spendingLimit",
  forcedPause: "notifications.forcedPause",
}

interface GameState {
  isLoading: boolean
  cityLoaded: boolean
  cityName: string | null
  simulation: { paused: boolean; selectedSpeed: number; forcedPause: string | null } | null
}

const moneyFormat = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 })
export const formatMoney = (value: number) => `¢${moneyFormat.format(Math.abs(Math.round(value)))}`

/** "BuildingOnFire_Notification" -> "Building On Fire" (same as humanizeName in the web app). */
export function humanizeName(name: string) {
  return name
    .replace(/[_-]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\s+(notification|icon)$/i, "")
    .replace(/\s+/g, " ")
    .trim()
}

/** "/build/road-connect" -> "road connect" (same as actionLabel in the web app). */
export function actionLabel(path: string) {
  return path
    .replace(/^\/(build|city|transit)\//, "")
    .replace(/^\//, "")
    .split("/")
    .join(" ")
    .replace(/-/g, " ")
}

function plural(n: number, one: string, many = `${one}s`) {
  return `${moneyFormat.format(n)} ${n === 1 ? one : many}`
}

function shortCity(city: string | null) {
  const name = (city ?? "").replace(/\s+/g, " ").trim()
  return name.length > 48 ? `${name.slice(0, 47)}…` : name || "Unnamed city"
}

// ---------------------------------------------------------------------------------------------
// What the bridge looks like right now
// ---------------------------------------------------------------------------------------------

export interface Observation {
  /** down = unreachable/refused, loading = the game is loading (neutral), up = reachable without a city */
  status: "down" | "loading" | "up" | "city"
  city: string | null
  /** down only: the bridge rejected the token */
  unauthorized: boolean
  paused: boolean | null
  forcedPause: string | null
}

export const DOWN: Observation = { status: "down", city: null, unauthorized: false, paused: null, forcedPause: null }

export function observeState(state: GameState): Observation {
  if (state.isLoading) return { ...DOWN, status: "loading" }
  if (!state.cityLoaded) return { ...DOWN, status: "up" }
  return {
    status: "city",
    city: state.cityName,
    unauthorized: false,
    paused: state.simulation?.paused ?? null,
    forcedPause: state.simulation?.forcedPause ?? null,
  }
}

// ---------------------------------------------------------------------------------------------
// Connection and city loads (debounced)
// ---------------------------------------------------------------------------------------------

export type ConnectionEvent =
  | { type: "lost"; unauthorized: boolean }
  | { type: "restored"; city: string | null }
  | { type: "city"; city: string | null; changed: boolean }

interface Confirmed {
  key: string
  status: "down" | "up" | "city"
  city: string | null
}

/**
 * A change of the bridge's state is announced only after it held, unbroken, for `delayMs` — so a
 * game restart, a loading screen or a failed poll does not spam. The first observation is the
 * baseline and announces nothing; a loading game is neutral (it cancels a pending change).
 */
export function createConnectionTracker(delayMs: () => number) {
  let confirmed: Confirmed | null = null
  let pending: { value: Confirmed; since: number; unauthorized: boolean } | null = null

  return {
    observe(o: Observation, now: number): ConnectionEvent[] {
      if (o.status === "loading") {
        pending = null
        return []
      }
      const value: Confirmed = {
        key: o.status === "city" ? `city:${o.city ?? ""}` : o.status,
        status: o.status,
        city: o.status === "city" ? o.city : null,
      }
      if (confirmed === null) {
        confirmed = value
        return []
      }
      if (value.key === confirmed.key) {
        pending = null
        return []
      }
      const change = pending && pending.value.key === value.key ? pending : { value, since: now, unauthorized: o.unauthorized }
      change.unauthorized = o.unauthorized
      pending = change
      if (now - change.since < delayMs()) return []

      const previous = confirmed
      confirmed = value
      pending = null
      if (value.status === "down") return [{ type: "lost", unauthorized: o.unauthorized }]
      if (previous.status === "down") return [{ type: "restored", city: value.city }]
      if (value.status === "city") return [{ type: "city", city: value.city, changed: previous.status === "city" }]
      return [] // a city was closed: back at the main menu
    },
    reset() {
      confirmed = null
      pending = null
    },
  }
}

/** A popup pause that lasted `afterMs`, once per popup. */
export function createPopupTracker(afterMs: () => number) {
  let since: number | null = null
  let fired = false
  return {
    observe(o: Observation, now: number): { seconds: number } | null {
      if (o.status !== "city" || o.forcedPause !== "popup") {
        since = null
        fired = false
        return null
      }
      since ??= now
      if (fired || now - since < afterMs()) return null
      fired = true
      return { seconds: Math.round((now - since) / 1000) }
    },
    reset() {
      since = null
      fired = false
    },
  }
}

// ---------------------------------------------------------------------------------------------
// City warnings
// ---------------------------------------------------------------------------------------------

/** Warnings that matter at a single icon: fires, disasters, collapsed buildings. */
const CRITICAL_WARNING = /fire|burn|destroy|collaps|flood|disaster|tornado|earthquake|tsunami|evacuat/i

export interface WarningHit {
  type: string
  label: string
  count: number
  /** The count it grew from (0 = new). */
  previous: number
  critical: boolean
}

export interface WarningRules {
  threshold: number
  cooldownMs: number
}

/**
 * Per warning type, against a reference count (what it was when last announced, or when first seen):
 *   - new/crossed: the reference was below the type's threshold and the count is at or above it;
 *   - grown:       the count is at least 1.5x the reference and `threshold` more than it;
 * and at most once per cooldown per type. A critical type's threshold is 1. The first observation
 * only sets the references (warnings that already exist are not news); a count that falls lowers
 * the reference so renewed growth is news again.
 */
export function createWarningTracker(rules: () => WarningRules) {
  const state = new Map<string, { reference: number; at: number }>()
  let baselined = false

  return {
    observe(counts: Record<string, number>, now: number): WarningHit[] {
      const { threshold, cooldownMs } = rules()
      const hits: WarningHit[] = []
      const seen = new Set<string>()
      for (const [type, raw] of Object.entries(counts)) {
        const count = typeof raw === "number" && Number.isFinite(raw) ? raw : 0
        if (count <= 0) continue
        seen.add(type)
        const label = humanizeName(type)
        const critical = CRITICAL_WARNING.test(label)
        const limit = critical ? 1 : threshold
        const entry = state.get(type) ?? { reference: baselined ? 0 : count, at: 0 }
        state.set(type, entry)
        if (!baselined) continue
        const crossed = entry.reference < limit
        const grown = entry.reference >= limit && count >= Math.max(entry.reference * 1.5, entry.reference + limit)
        if (count >= limit && (crossed || grown) && now - entry.at >= cooldownMs) {
          hits.push({ type, label, count, previous: entry.reference, critical })
          entry.reference = count
          entry.at = now
        } else if (count < entry.reference) {
          entry.reference = count
        }
      }
      for (const [type, entry] of state) {
        if (!seen.has(type)) entry.reference = 0
      }
      baselined = true
      return hits.sort((a, b) => Number(b.critical) - Number(a.critical) || b.count - a.count || a.label.localeCompare(b.label))
    },
    reset() {
      state.clear()
      baselined = false
    },
  }
}

export function warningsDraft(hits: readonly WarningHit[], city: string | null): Draft {
  const where = city ? ` in ${shortCity(city)}` : ""
  if (hits.length === 1) {
    const hit = hits[0]
    return {
      kind: "warnings",
      title: `${hit.label}: ${plural(hit.count, "warning")}${where}`,
      body: hit.previous > 0 ? `Up from ${moneyFormat.format(hit.previous)} a moment ago.` : "A new kind of warning showed up in the city.",
      route: "/",
    }
  }
  const lines = hits.slice(0, 4).map((hit) => `${hit.label}: ${moneyFormat.format(hit.count)}${hit.previous > 0 ? ` (was ${moneyFormat.format(hit.previous)})` : ""}`)
  if (hits.length > 4) lines.push(`and ${hits.length - 4} more`)
  return { kind: "warnings", title: `${hits.length} new city warnings${where}`, body: lines.join("\n"), route: "/" }
}

// ---------------------------------------------------------------------------------------------
// AI activity (/history)
// ---------------------------------------------------------------------------------------------

export interface HistoryItem {
  id: number
  timeUtc: string
  path: string
  status: number
  ok: boolean
  batchChild: boolean
  moneyDelta: number
  result: string | null
}

export interface HistoryAnswer {
  batchRunning: boolean
  spendingLimit: number | null
  spendingLimitRemaining: number | null
  /** The bridge's order: newest first. */
  entries: HistoryItem[]
}

export function parseHistory(raw: unknown): HistoryAnswer {
  const value = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>
  const number = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : null)
  const entries = (Array.isArray(value.entries) ? value.entries : []).flatMap((item): HistoryItem[] => {
    if (!item || typeof item !== "object") return []
    const e = item as Record<string, unknown>
    if (typeof e.id !== "number" || typeof e.timeUtc !== "string" || typeof e.path !== "string") return []
    return [
      {
        id: e.id,
        timeUtc: e.timeUtc,
        path: e.path,
        status: number(e.status) ?? 0,
        ok: e.ok !== false,
        batchChild: e.batchChild === true,
        moneyDelta: number(e.moneyDelta) ?? 0,
        result: typeof e.result === "string" ? e.result : null,
      },
    ]
  })
  return {
    batchRunning: value.batchRunning === true,
    spendingLimit: number(value.spendingLimit),
    spendingLimitRemaining: number(value.spendingLimitRemaining),
    entries,
  }
}

/** Identity of an entry across game runs (the bridge's ids restart with the game). */
export const itemKey = (e: Pick<HistoryItem, "id" | "timeUtc" | "path">) => `${e.id}|${e.timeUtc}|${e.path}`

/** Requests that run as a batch and log their operations as `batchChild` entries. */
const BATCH_PATHS = ["/build/batch", "/build/interchange"]

export interface BurstSummary {
  /** Operations that worked. */
  changes: number
  actions: { label: string; count: number }[]
  /** Operations that failed (a batch's failed parts, a failed plain request). */
  failures: { label: string; status: number; message: string | null }[]
  /** Money that left the treasury (positive number). */
  spent: number
  net: number
  /** Newest entry of the burst: the activity page session it belongs to is found through it. */
  last: HistoryItem
  first: HistoryItem
}

function resultMessage(result: string | null) {
  if (!result) return null
  let text = result
  try {
    const parsed: unknown = JSON.parse(result)
    if (parsed && typeof parsed === "object") {
      const o = parsed as Record<string, unknown>
      const found = o.error ?? o.message
      if (typeof found === "string") text = found
    }
  } catch {
    // not JSON: use as is
  }
  text = text.replace(/\s+/g, " ").trim()
  return text ? (text.length > 120 ? `${text.slice(0, 119)}…` : text) : null
}

/**
 * Sums up entries in the order they were logged (oldest first). A batch logs its parts first and
 * its own entry last; that entry's money covers the parts (never counted twice), same rule as
 * web/src/lib/sessions.ts. A batch request itself is not an operation unless it failed.
 */
export function summariseBurst(entries: readonly HistoryItem[]): BurstSummary | null {
  if (entries.length === 0) return null
  const operations: HistoryItem[] = []
  let pending: HistoryItem[] = []
  let spent = 0
  let net = 0
  const step = (delta: number) => {
    net += delta
    spent += Math.max(0, -delta)
  }
  for (const entry of entries) {
    if (entry.batchChild) {
      pending.push(entry)
      operations.push(entry)
    } else if (pending.length > 0 && BATCH_PATHS.includes(entry.path)) {
      step(entry.moneyDelta)
      if (!entry.ok) operations.push(entry)
      pending = []
    } else {
      step(entry.moneyDelta)
      operations.push(entry)
    }
  }
  if (pending.length > 0) step(pending.reduce((sum, e) => sum + e.moneyDelta, 0)) // batch still running or lost
  const counts = new Map<string, number>()
  for (const op of operations.filter((e) => e.ok)) {
    const label = actionLabel(op.path)
    counts.set(label, (counts.get(label) ?? 0) + 1)
  }
  return {
    changes: operations.filter((e) => e.ok).length,
    actions: [...counts].map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count || a.label.localeCompare(b.label)),
    failures: operations.filter((e) => !e.ok).map((e) => ({ label: actionLabel(e.path), status: e.status, message: resultMessage(e.result) })),
    spent,
    net,
    first: entries[0],
    last: entries[entries.length - 1],
  }
}

/**
 * The activity page's session key ("<first entry id>-<its start, unix seconds>") for the session
 * `target` belongs to, found the way the page groups: a pause of 15 minutes, or ids going
 * backwards (the game restarted), starts a new session. `live` is the bridge's order, newest first.
 */
export function sessionKeyOf(live: readonly HistoryItem[], target: HistoryItem, gapMs = SESSION_GAP_MS): string | null {
  let first: HistoryItem | null = null
  let lastMs = -Infinity
  let previousId = -Infinity
  const targetKey = itemKey(target)
  for (const entry of [...live].reverse()) {
    const ms = Date.parse(entry.timeUtc)
    const time = Number.isNaN(ms) ? lastMs : ms
    if (first === null || entry.id < previousId || time - lastMs > gapMs) {
      first = entry
      lastMs = time
    } else {
      lastMs = Math.max(lastMs, time)
    }
    previousId = entry.id
    if (itemKey(entry) === targetKey) {
      const start = Date.parse(first.timeUtc)
      return Number.isNaN(start) ? null : `${first.id}-${Math.floor(start / 1000)}`
    }
  }
  return null
}

/**
 * New /history entries are gathered into a burst; the burst is reported when nothing new came for
 * `quietMs` (and no batch is running), or after BURST_MAX_MS of continuous activity. The first
 * observation only learns what is already in the log.
 */
export function createActivityTracker(quietMs = BURST_QUIET_MS, maxMs = BURST_MAX_MS) {
  let seen: Set<string> | null = null
  let burst: { entries: HistoryItem[]; startedAt: number; lastNewAt: number } | null = null

  return {
    observe(answer: HistoryAnswer, now: number): BurstSummary | null {
      const keys = new Set(answer.entries.map(itemKey))
      if (seen === null) {
        seen = keys
        return null
      }
      const fresh = [...answer.entries].reverse().filter((e) => !seen!.has(itemKey(e)))
      seen = keys
      if (fresh.length > 0) {
        burst ??= { entries: [], startedAt: now, lastNewAt: now }
        burst.entries.push(...fresh)
        burst.lastNewAt = now
      }
      if (!burst || answer.batchRunning) return null
      if (now - burst.lastNewAt < quietMs && now - burst.startedAt < maxMs) return null
      const summary = summariseBurst(burst.entries)
      burst = null
      return summary
    },
    reset() {
      seen = null
      burst = null
    },
  }
}

export function activityDrafts(summary: BurstSummary, live: readonly HistoryItem[], city: string | null): Draft[] {
  const key = sessionKeyOf(live, summary.last)
  const base = key ? `/activity?session=${encodeURIComponent(key)}` : "/activity"
  const where = city ? ` in ${shortCity(city)}` : ""
  const drafts: Draft[] = []
  if (summary.changes > 0) {
    const money = summary.spent > 0 ? `, spent ${formatMoney(summary.spent)}` : summary.net > 0 ? `, earned ${formatMoney(summary.net)}` : ""
    const what = summary.actions.slice(0, 4).map((a) => (a.count > 1 ? `${a.label} × ${a.count}` : a.label))
    if (summary.actions.length > 4) what.push(`${summary.actions.length - 4} more kinds`)
    drafts.push({
      kind: "aiActivity",
      title: `AI made ${plural(summary.changes, "change")}${money}`,
      body: `${what.join(", ")}${where}`,
      route: base,
    })
  }
  if (summary.failures.length > 0) {
    const first = summary.failures[0]
    const list = [...new Set(summary.failures.map((f) => `${f.label} (${f.status || "failed"})`))].slice(0, 3).join(", ")
    drafts.push({
      kind: "aiFailures",
      title: `${plural(summary.failures.length, "AI action")} failed`,
      body: [list, first.message].filter(Boolean).join("\n"),
      route: `${base}${base.includes("?") ? "&" : "?"}status=failed`,
    })
  }
  return drafts
}

// ---------------------------------------------------------------------------------------------
// Spending limit
// ---------------------------------------------------------------------------------------------

export interface LimitEvent {
  level: "low" | "exhausted"
  remaining: number
  limit: number
}

/**
 * Fires when the remaining share of the AI's spending limit falls under `percent` (level "low") and
 * again when nothing is left ("exhausted"), once per step; raising the limit re-arms it. Unlimited
 * (limit null) never fires. The first observation only learns the level.
 */
export function createLimitTracker() {
  let notified: 0 | 1 | 2 | null = null
  return {
    observe(answer: Pick<HistoryAnswer, "spendingLimit" | "spendingLimitRemaining">, percent: number): LimitEvent | null {
      const { spendingLimit: limit, spendingLimitRemaining: remaining } = answer
      if (limit === null || limit <= 0 || remaining === null) {
        notified = null
        return null
      }
      const level = remaining <= 0 ? 2 : (remaining / limit) * 100 < percent ? 1 : 0
      const previous = notified
      notified = level
      if (previous === null || level <= previous || level === 0) return null
      return { level: level === 2 ? "exhausted" : "low", remaining: Math.max(0, remaining), limit }
    },
    reset() {
      notified = null
    },
  }
}

// ---------------------------------------------------------------------------------------------
// Texts of the simple events
// ---------------------------------------------------------------------------------------------

export function connectionDraft(event: ConnectionEvent): Draft {
  switch (event.type) {
    case "lost":
      return event.unauthorized
        ? {
            kind: "connection",
            title: "The game bridge rejected the token",
            body: "The companion cannot read the game. Check the token under Settings > Connection.",
            route: "/settings",
          }
        : {
            kind: "connection",
            title: "Lost connection to the game",
            body: "The companion cannot reach the Cities: Skylines II bridge. The AI cannot play until it is back.",
            route: "/",
          }
    case "restored":
      return {
        kind: "connection",
        title: "Connected to the game",
        body: event.city ? `${shortCity(event.city)} is loaded and the bridge answers.` : "The bridge answers, but no city is loaded yet.",
        route: "/",
      }
    case "city":
      return {
        kind: "cityLoaded",
        title: event.changed ? "Another city was loaded" : "City loaded",
        body: `${shortCity(event.city)} is ready for the AI.`,
        route: "/",
      }
  }
}

export function popupDraft(seconds: number, city: string | null): Draft {
  return {
    kind: "forcedPause",
    title: "The game is paused by a popup",
    body: `A popup has held ${city ? `${shortCity(city)} ` : "the game "}paused for ${seconds} s. The AI cannot control the game until it is dismissed.`,
    route: "/",
  }
}

export function limitDraft(event: LimitEvent): Draft {
  return event.level === "exhausted"
    ? {
        kind: "spendingLimit",
        title: "AI spending limit reached",
        body: `The AI has used all ${formatMoney(event.limit)} it may spend. It cannot build until the limit is raised.`,
        route: "/",
      }
    : {
        kind: "spendingLimit",
        title: "AI spending limit almost reached",
        body: `${formatMoney(event.remaining)} of ${formatMoney(event.limit)} left (${Math.round((event.remaining / event.limit) * 100)}%).`,
        route: "/",
      }
}

// ---------------------------------------------------------------------------------------------
// Electron adapter
// ---------------------------------------------------------------------------------------------

/** What the feature needs from the OS notification center. */
export interface NotifierView {
  supported(): boolean
  show(content: { title: string; body: string }, onClick: () => void): void
}

export type NotifierFactory = (ctx: DesktopContext) => Promise<NotifierView>

export const createElectronNotifier: NotifierFactory = async (ctx) => {
  const { Notification } = await import("electron")
  // A Notification that is garbage collected stops reporting clicks: hold the recent ones.
  const live = new Set<InstanceType<typeof Notification>>()
  return {
    supported: () => Notification.isSupported(),
    show({ title, body }, onClick) {
      const notification = new Notification({ title, body, icon: ctx.paths.icon })
      live.add(notification)
      if (live.size > 30) live.delete(live.values().next().value!)
      notification.on("click", () => {
        live.delete(notification)
        onClick()
      })
      notification.on("close", () => live.delete(notification))
      notification.on("failed", (_event, error) => {
        live.delete(notification)
        ctx.log.warn(`the system refused a notification: ${error}`)
      })
      notification.show()
    },
  }
}

// ---------------------------------------------------------------------------------------------
// The feature
// ---------------------------------------------------------------------------------------------

export function createNotifications(createView: NotifierFactory = createElectronNotifier): DesktopFeature {
  return defineFeature({
    id: "notifications",
    setup(ctx) {
      const bool = (key: string, fallback: boolean) => ctx.settings.define(key, { schema: z.boolean(), default: fallback })
      const int = (key: string, fallback: number, min: number, max: number) =>
        ctx.settings.define(key, { schema: z.number().int().min(min).max(max), default: fallback })

      const enabled = bool("notifications.enabled", true)
      const quiet = bool("notifications.quiet", false)
      const suppressWhenFocused = bool("notifications.suppressWhenFocused", true)
      const toggles = {
        connection: bool(KIND_SETTING.connection, true),
        cityLoaded: bool(KIND_SETTING.cityLoaded, true),
        warnings: bool(KIND_SETTING.warnings, true),
        aiActivity: bool(KIND_SETTING.aiActivity, true),
        aiFailures: bool(KIND_SETTING.aiFailures, true),
        spendingLimit: bool(KIND_SETTING.spendingLimit, true),
        forcedPause: bool(KIND_SETTING.forcedPause, true),
      }
      const warningThreshold = int("notifications.warningThreshold", 10, 1, 100_000)
      const warningCooldownMinutes = int("notifications.warningCooldownMinutes", 15, 1, 1440)
      const spendingLimitPercent = int("notifications.spendingLimitPercent", 20, 1, 100)
      const popupSeconds = int("notifications.popupSeconds", 30, 5, 600)
      const connectionDelaySeconds = int("notifications.connectionDelaySeconds", 20, 5, 300)

      const connection = createConnectionTracker(() => connectionDelaySeconds.get() * 1000)
      const popup = createPopupTracker(() => popupSeconds.get() * 1000)
      const warnings = createWarningTracker(() => ({
        threshold: warningThreshold.get(),
        cooldownMs: warningCooldownMinutes.get() * 60_000,
      }))
      const activity = createActivityTracker()
      const limit = createLimitTracker()
      const trackers = [connection, popup, warnings, activity, limit]

      // --- the log and the OS ---------------------------------------------------------------

      const log: LogEntry[] = []
      const lastShown = new Map<string, number>()
      let nextId = 1
      let view: NotifierView | null = null
      let viewFailed = false

      async function ensureView() {
        if (view || viewFailed) return view
        try {
          view = await createView(ctx)
        } catch (err) {
          viewFailed = true
          ctx.log.error("notifications are not available", err)
        }
        return view
      }

      function windowFocused() {
        const win = ctx.getMainWindow()
        return !!win && !win.isDestroyed() && win.isVisible() && !win.isMinimized() && win.isFocused()
      }

      /** Why nothing can be shown (or polled for) right now; null = free to notify. */
      function blockedNow(): Suppression | null {
        if (!enabled.get()) return "disabled"
        if (quiet.get()) return "quiet"
        if (suppressWhenFocused.get() && windowFocused()) return "focused"
        return null
      }

      function wantsAnything() {
        return Object.values(toggles).some((t) => t.get())
      }

      function openRoute(route: string) {
        try {
          const win = ctx.showMainWindow()
          const target = appUrl(route)
          if (win.webContents.getURL() !== target) {
            win.loadURL(target).catch((err: unknown) => ctx.log.warn(`could not open ${route}`, err))
          }
        } catch (err) {
          ctx.log.warn(`could not open ${route}`, err)
        }
      }

      /** Shows (or suppresses) one notification and records it. `force` = the test button: no filters. */
      async function emit(draft: Draft, force = false): Promise<LogEntry> {
        const now = Date.now()
        const entry: LogEntry = { ...draft, id: nextId++, at: now, shown: false, suppressed: null, clicked: false }
        let reason: Suppression | null = null
        if (!force) {
          reason =
            draft.kind === "test"
              ? null
              : !toggles[draft.kind].get()
                ? "disabled"
                : blockedNow()
          const gap = MIN_GAP_MS[draft.kind]
          if (!reason && gap && now - (lastShown.get(draft.kind) ?? 0) < gap) reason = "cooldown"
        }
        const target = reason ? null : await ensureView()
        if (!reason && (!target || !target.supported())) reason = "unsupported"
        if (!reason && target) {
          try {
            target.show({ title: draft.title, body: draft.body }, () => {
              entry.clicked = true
              openRoute(draft.route)
            })
            entry.shown = true
            lastShown.set(draft.kind, now)
          } catch (err) {
            reason = "error"
            ctx.log.warn("could not show a notification", err)
          }
        }
        entry.suppressed = reason
        if (reason !== "disabled") {
          log.unshift(entry)
          if (log.length > LOG_LIMIT) log.length = LOG_LIMIT
          ctx.log.info(`${entry.shown ? "notified" : `suppressed (${reason})`} [${draft.kind}] ${draft.title}`)
        }
        return entry
      }

      // --- polling ----------------------------------------------------------------------------

      let timer: NodeJS.Timeout | undefined
      let ticking = false
      let stopped = false
      let failures = 0
      let lastCity: string | null = null
      let lastWarningsAt = 0
      let lastHistory: HistoryItem[] = []
      let status: { link: Observation["status"] | "unknown"; city: string | null; checkedAt: number | null } = {
        link: "unknown",
        city: null,
        checkedAt: null,
      }
      let sleepingBecause: Suppression | "nothing-selected" | null = null

      async function probe(): Promise<Observation> {
        try {
          return observeState(await ctx.bridge.get<GameState>("/state"))
        } catch (err) {
          if (!(err instanceof BridgeError)) throw err
          return { ...DOWN, unauthorized: err.status === 401 }
        }
      }

      async function read<T>(path: string, params?: Record<string, number>) {
        try {
          return await ctx.bridge.get<T>(path, params)
        } catch (err) {
          if (!(err instanceof BridgeError)) throw err
          ctx.log.debug(`${path} unavailable: ${err.message}`)
          return null
        }
      }

      async function pollHistory(o: Observation, now: number) {
        if (!toggles.aiActivity.get() && !toggles.aiFailures.get() && !toggles.spendingLimit.get()) return
        const raw = await read<unknown>("/history", { limit: HISTORY_LIMIT })
        if (raw === null) return
        const answer = parseHistory(raw)
        lastHistory = answer.entries
        const summary = activity.observe(answer, now)
        if (summary) for (const draft of activityDrafts(summary, answer.entries, o.city)) await emit(draft)
        const event = limit.observe(answer, spendingLimitPercent.get())
        if (event) await emit(limitDraft(event))
      }

      async function pollWarnings(o: Observation, now: number) {
        if (!toggles.warnings.get() || now - lastWarningsAt < WARNINGS_EVERY_MS) return
        lastWarningsAt = now
        const raw = await read<{ countsByType?: Record<string, number> }>("/city/notifications")
        if (raw === null) return
        const hits = warnings.observe(raw.countsByType && typeof raw.countsByType === "object" ? raw.countsByType : {}, now)
        if (hits.length > 0) await emit(warningsDraft(hits, o.city))
      }

      function resetAll() {
        for (const tracker of trackers) tracker.reset()
        lastCity = null
        lastWarningsAt = 0
        lastHistory = []
        failures = 0
      }

      /** One round; returns the delay before the next. */
      async function round(): Promise<number> {
        const blocked = blockedNow()
        const sleeping = blocked ?? (wantsAnything() ? null : "nothing-selected")
        if (sleeping) {
          // Nothing could be shown: no requests, and forget the baselines so that whatever happens
          // meanwhile is not announced when we wake up.
          if (sleepingBecause === null) resetAll()
          sleepingBecause = sleeping
          return RECHECK_MS
        }
        sleepingBecause = null

        const now = Date.now()
        const o = await probe()
        status = { link: o.status, city: o.city, checkedAt: now }
        failures = o.status === "down" ? failures + 1 : 0

        // Another city (or none): the log and the warnings of the old one mean nothing now.
        const cityKey = o.status === "city" ? (o.city ?? "") : null
        if (cityKey !== lastCity) {
          activity.reset()
          warnings.reset()
          limit.reset()
          popup.reset()
          lastWarningsAt = 0
          lastHistory = []
          lastCity = cityKey
        }

        for (const event of connection.observe(o, now)) await emit(connectionDraft(event))
        const paused = popup.observe(o, now)
        if (paused) await emit(popupDraft(paused.seconds, o.city))

        if (o.status === "city") {
          await pollHistory(o, now)
          await pollWarnings(o, now)
        }
        if (o.status === "down") return Math.min(POLL_BACKOFF_MAX_MS, POLL_CONNECTED_MS * 2 ** Math.max(0, Math.min(failures, 6) - 1))
        return o.status === "city" ? POLL_CONNECTED_MS : POLL_IDLE_MS
      }

      function schedule(delay: number) {
        clearTimeout(timer)
        if (!stopped) timer = setTimeout(() => void tick(), delay)
      }

      async function tick() {
        if (ticking) return
        ticking = true
        let next = POLL_IDLE_MS
        try {
          next = await round()
        } catch (err) {
          ctx.log.error("notification poll failed", err)
        } finally {
          ticking = false
          schedule(next)
        }
      }

      /** A setting changed: look again now (a running round finishes first). */
      function wake() {
        if (ticking || stopped) return
        schedule(0)
      }

      // --- routes and lifecycle ---------------------------------------------------------------

      ctx.routes.get("/desktop/notifications", () => ({
        supported: view ? view.supported() : null,
        enabled: enabled.get(),
        quiet: quiet.get(),
        suppressWhenFocused: suppressWhenFocused.get(),
        // Why the poller is idle (no requests are sent while it is): disabled, quiet, focused or nothing-selected
        sleeping: sleepingBecause,
        status,
        notifications: log,
      }))

      ctx.routes.post("/desktop/notifications/test", async () => {
        const entry = await emit(
          {
            kind: "test",
            title: "CS2MCP Companion",
            body: "Notifications work. Click this one to open the companion.",
            route: "/",
          },
          true
        )
        if (entry.suppressed === "unsupported") throw new RouteError(503, "Notifications are not supported on this system")
        if (entry.suppressed === "error") throw new RouteError(500, "The system refused the notification (see the log)")
        return { shown: entry.shown, id: entry.id }
      })

      for (const setting of [enabled, quiet, suppressWhenFocused, ...Object.values(toggles)]) setting.onChange(wake)

      ctx.onReady(() => {
        void ensureView()
        // Window focus is not a setting: it is looked at every RECHECK_MS while idle and every round otherwise.
        schedule(2_000)
      })
      ctx.onBeforeQuit(() => {
        stopped = true
        clearTimeout(timer)
      })
    },
  })
}

export default createNotifications()
