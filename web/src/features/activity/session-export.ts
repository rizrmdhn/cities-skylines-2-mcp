import type { HistoryEntry } from "@/lib/bridge-types"
import { actionLabel, formatMoney, formatMoneyDelta, prettyJson } from "@/lib/format"
import { formatDuration, SESSION_GAP_MS, type Session, type Step } from "@/lib/sessions"

/*
 * Session reports: Markdown for people, JSON for tools. Times are written in UTC so a report
 * reads the same wherever it is opened (and the output is deterministic for tests).
 */

export interface ExportContext {
  /** City the history belongs to, when known. */
  city?: string
  /** When the export was made (default: now). */
  now?: Date
  /** The page's filters, recorded in a whole-history export. */
  filters?: { status: string; kind: string | undefined }
}

export const SESSION_RULE =
  `A step is one request, or one batch with its parts. A session is a run of steps without a pause ` +
  `longer than ${SESSION_GAP_MS / 60_000} minutes; a game restart also starts a new session.`

/** "2026-11-11 09:00:05 UTC" */
export function utc(ms: number) {
  return `${new Date(ms).toISOString().replace("T", " ").replace(/\.\d+Z$/, "")} UTC`
}

function entryUtc(entry: HistoryEntry) {
  const ms = Date.parse(entry.timeUtc)
  return Number.isNaN(ms) ? entry.timeUtc : utc(ms)
}

/** Inline code that survives backticks in the value. */
function code(value: string) {
  const fence = value.includes("`") ? "``" : "`"
  const pad = value.startsWith("`") || value.endsWith("`") ? " " : ""
  return `${fence}${pad}${value}${pad}${fence}`
}

function tableCell(value: string) {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ")
}

/** The bridge's error message from a failed entry's result, when it has one. */
export function entryError(entry: HistoryEntry): string | undefined {
  if (entry.ok) return undefined
  if (entry.result) {
    try {
      const parsed: unknown = JSON.parse(entry.result)
      if (parsed && typeof parsed === "object" && "error" in parsed && typeof parsed.error === "string") {
        return parsed.error
      }
    } catch {
      return entry.result
    }
  }
  return entry.status === 0 ? "no result: the operation never completed" : `HTTP ${entry.status}`
}

function stepTitle(step: Step) {
  if (step.kind === "single") return actionLabel(step.path)
  const parts = `${step.parts.length} part${step.parts.length === 1 ? "" : "s"}`
  return `${actionLabel(step.path)} (${parts}${step.entry ? "" : ", batch result not logged"})`
}

export function stepResultLabel(step: Step) {
  if (step.ok) return "done"
  if (step.kind === "batch" && step.failedParts > 0) {
    return `failed (${step.failedParts} of ${step.parts.length} parts)`
  }
  return `failed${step.entry?.status ? ` ${step.entry.status}` : ""}`
}

function countList(items: { name: string; count: number }[], label: (name: string) => string) {
  return items.map((item) => (item.count > 1 ? `${label(item.name)} × ${item.count}` : label(item.name))).join(", ")
}

function round(value: number) {
  return Math.round(value).toString()
}

export function placeLabel(session: Session) {
  const place = session.place
  if (!place) return "no positions recorded"
  const centre = `around (${round(place.centre.x)}, ${round(place.centre.z)})`
  const extent =
    place.min.x === place.max.x && place.min.z === place.max.z
      ? ""
      : `, within x ${round(place.min.x)}…${round(place.max.x)}, z ${round(place.min.z)}…${round(place.max.z)}`
  return `${centre}${extent} (${place.steps} step${place.steps === 1 ? "" : "s"} with a position)`
}

function summaryRows(session: Session): [string, string][] {
  const rows: [string, string][] = [
    ["Started", utc(session.startMs)],
    ["Ended", `${utc(session.endMs)} (${formatDuration(session.durationMs)})`],
  ]
  if (session.gameTimeStart) {
    rows.push(["In game", session.gameTimeStart === session.gameTimeEnd ? session.gameTimeStart : `${session.gameTimeStart} → ${session.gameTimeEnd}`])
  }
  rows.push(
    [
      "Steps",
      `${session.steps.length} (${session.entryCount} log entries): ${session.succeeded} done, ${session.failed} failed` +
        (session.running ? ", a batch is still running" : ""),
    ],
    ["Money spent", `${formatMoney(session.spent)} (net change ${formatMoneyDelta(session.netMoney)})`],
    ["Actions", countList(session.actions, actionLabel) || "none"],
  )
  if (session.prefabs.length > 0) rows.push(["Assets", countList(session.prefabs, (name) => name)])
  rows.push(["Where", placeLabel(session)])
  return rows
}

function entryLines(entry: HistoryEntry): string[] {
  const lines = [
    `- ${code(entry.path)} · #${entry.id} · ${entryUtc(entry)}${entry.gameTime ? ` · in game ${entry.gameTime}` : ""}`,
  ]
  const params = Object.entries(entry.query ?? {})
  lines.push(`- Parameters: ${params.length === 0 ? "none" : params.map(([k, v]) => code(`${k}=${v}`)).join(", ")}`)
  lines.push(`- Money: ${formatMoneyDelta(entry.moneyDelta)}`)
  const error = entryError(entry)
  if (error) lines.push(`- Error: ${error}`)
  if (entry.result) {
    lines.push("- Result:", "", "  ```json", ...prettyJson(entry.result).split("\n").map((line) => `  ${line}`), "  ```")
  }
  return lines
}

function stepMarkdown(step: Step, heading: string, prefix: string): string[] {
  const lines = [`${heading} ${prefix}${step.index}. ${stepTitle(step)} — ${stepResultLabel(step)} — ${formatMoneyDelta(step.moneyDelta)}`, ""]
  if (step.entry) lines.push(...entryLines(step.entry), "")
  step.parts.forEach((part, i) => {
    lines.push(
      `${heading}# ${prefix}${step.index}.${i + 1}. ${actionLabel(part.path)} — ${part.ok ? "done" : `failed ${part.status}`}`,
      "",
      ...entryLines(part),
      ""
    )
  })
  return lines
}

function sessionBody(session: Session, level: number, stepPrefix: string): string[] {
  const h = "#".repeat(level)
  const lines = ["| | |", "| --- | --- |", ...summaryRows(session).map(([k, v]) => `| ${k} | ${tableCell(v)} |`), ""]
  lines.push(`${h}# Steps`, "")
  for (const step of session.steps) lines.push(...stepMarkdown(step, `${h}##`, stepPrefix))
  return lines
}

function exportedLine(context: ExportContext) {
  return `Exported ${utc((context.now ?? new Date()).getTime())} from the CS2MCP companion. ${SESSION_RULE}`
}

export function sessionMarkdown(session: Session, context: ExportContext = {}): string {
  const title = `# AI session ${session.number}${context.city ? ` — ${context.city}` : ""}`
  return [title, "", exportedLine(context), "", ...sessionBody(session, 1, "")].join("\n").trimEnd() + "\n"
}

export function historyMarkdown(sessions: readonly Session[], context: ExportContext = {}): string {
  const lines = [`# AI activity${context.city ? ` — ${context.city}` : ""}`, "", exportedLine(context), ""]
  const filters = filterLabel(context.filters)
  lines.push(
    `${sessions.length} session${sessions.length === 1 ? "" : "s"}, newest first${filters ? `; ${filters}` : ""}.`,
    ""
  )
  for (const session of sessions) {
    lines.push(`## Session ${session.number} — ${utc(session.startMs)}`, "", ...sessionBody(session, 2, `${session.number}.`))
  }
  return lines.join("\n").trimEnd() + "\n"
}

function filterLabel(filters: ExportContext["filters"]) {
  if (!filters) return ""
  const parts: string[] = []
  if (filters.status === "ok") parts.push("sessions with at least one step that was done")
  if (filters.status === "failed") parts.push("sessions with at least one failed step")
  if (filters.kind) parts.push(`sessions with a ${code(filters.kind)} step`)
  return parts.length > 0 ? `only ${parts.join(" and ")} (every step of those sessions is listed)` : ""
}

function sessionJson(session: Session) {
  return {
    key: session.key,
    number: session.number,
    startUtc: new Date(session.startMs).toISOString(),
    endUtc: new Date(session.endMs).toISOString(),
    durationSeconds: Math.round(session.durationMs / 1000),
    gameTimeStart: session.gameTimeStart,
    gameTimeEnd: session.gameTimeEnd,
    stepCount: session.steps.length,
    entryCount: session.entryCount,
    succeeded: session.succeeded,
    failed: session.failed,
    spent: session.spent,
    netMoney: session.netMoney,
    running: session.running,
    actions: session.actions,
    prefabs: session.prefabs,
    place: session.place ?? null,
    steps: session.steps.map((step) => ({
      index: step.index,
      kind: step.kind,
      path: step.path,
      ok: step.ok,
      failedParts: step.failedParts,
      moneyDelta: step.moneyDelta,
      startUtc: new Date(step.startMs).toISOString(),
      /** The request itself (a batch's own entry), exactly as the bridge logged it. */
      entry: step.entry ?? null,
      /** A batch's operations, in the order they ran. */
      parts: step.parts,
    })),
  }
}

function jsonHeader(context: ExportContext) {
  return {
    format: "cs2mcp-ai-sessions",
    version: 1,
    exportedAt: (context.now ?? new Date()).toISOString(),
    city: context.city ?? null,
    sessionRule: SESSION_RULE,
  }
}

export function sessionJsonExport(session: Session, context: ExportContext = {}): string {
  return JSON.stringify({ ...jsonHeader(context), sessions: [sessionJson(session)] }, null, 2) + "\n"
}

export function historyJsonExport(sessions: readonly Session[], context: ExportContext = {}): string {
  return (
    JSON.stringify(
      { ...jsonHeader(context), filters: context.filters ?? null, sessions: sessions.map(sessionJson) },
      null,
      2
    ) + "\n"
  )
}

/** "cs2mcp-riverside-session-2-20261111-0900.md" */
export function exportFileName(
  what: { session: Session } | { sessions: readonly Session[] },
  format: "md" | "json",
  context: ExportContext = {}
) {
  const city = context.city ? `-${context.city.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}` : ""
  const stamp = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace(/[-:]/g, "").replace("T", "-")
  const name =
    "session" in what
      ? `session-${what.session.number}-${stamp(what.session.startMs)}`
      : `activity-${stamp((context.now ?? new Date()).getTime())}`
  return `cs2mcp${city}-${name}.${format}`
}

