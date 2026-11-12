const integer = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 })
const compact = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
})

export function formatNumber(value: number) {
  return integer.format(value)
}

/** Game money, shown with the game's ¢ sign. */
export function formatMoney(value: number, options: { compact?: boolean } = {}) {
  const sign = value < 0 ? "-" : ""
  const abs = Math.abs(value)
  return `${sign}¢${options.compact && abs >= 10_000 ? compact.format(abs) : integer.format(abs)}`
}

/** Treasury change: "+¢1,200", "-¢48,000", "¢0". */
export function formatMoneyDelta(value: number) {
  if (value === 0) return "¢0"
  return `${value > 0 ? "+" : ""}${formatMoney(value)}`
}

export function formatTime(iso: string) {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" })
}

export function formatDateTime(iso: string) {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return date.toLocaleString()
}

/** "/build/road/connect" -> "road connect", "/city/taxes/set" -> "taxes set". */
export function actionLabel(path: string) {
  return path
    .replace(/^\/(build|city|transit)\//, "")
    .replace(/^\//, "")
    .split("/")
    .join(" ")
    .replace(/-/g, " ")
}

/** Pretty-prints a JSON string; anything else is returned as is. */
export function prettyJson(text: string) {
  try {
    return JSON.stringify(JSON.parse(text), null, 2)
  } catch {
    return text
  }
}

/** "Nov 11, 09:00 – 09:12", or with the second date when the session ran past midnight. */
export function formatTimeRange(startMs: number, endMs: number) {
  const day = (ms: number) => new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" })
  const clock = (ms: number) => new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
  if (startMs === endMs) return `${day(startMs)}, ${clock(startMs)}`
  const sameDay = day(startMs) === day(endMs)
  return `${day(startMs)}, ${clock(startMs)} – ${sameDay ? "" : `${day(endMs)}, `}${clock(endMs)}`
}
