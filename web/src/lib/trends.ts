import { keepPreviousData, queryOptions } from "@tanstack/react-query"

import { apiGet, apiPost } from "@/lib/api"

/**
 * Trend history, recorded by the desktop app (desktop/src/features/trends.ts) and read through
 * /api/desktop/trends*. The browser companion has none of it.
 */

/** Names of the recorded values, as in the series points. */
export type TrendMetric =
  | "population"
  | "money"
  | "happiness"
  | "health"
  | "xp"
  | "income"
  | "expenses"
  | "demandResidentialLow"
  | "demandResidentialMedium"
  | "demandResidentialHigh"
  | "demandCommercial"
  | "demandIndustrial"
  | "demandOffice"

/** GET /api/desktop/trends */
export interface TrendsStatus {
  state: "disabled" | "starting" | "unreachable" | "error" | "no-city" | "paused" | "recording"
  /** The city the recorder currently sees; null when none is loaded. */
  city: { key: string; name: string } | null
  lastSampleAt: number | null
  /** Samples recorded since the app started. */
  sessionSamples: number
  nextPollAt: number | null
  error: string | null
  consecutiveFailures: number
  enabled: boolean
  intervalSeconds: number
  retentionDays: number
  maxSamplesPerCity: number
  /** Size of all history files. */
  bytes: number
}

/** GET /api/desktop/trends/cities */
export interface TrendCity {
  key: string
  name: string
  samples: number
  firstAt: number | null
  lastAt: number | null
  firstGame: string | null
  lastGame: string | null
}

export interface TrendPoint extends Partial<Record<TrendMetric, number | null>> {
  /** Position on the requested axis: simulation frame (game) or ms since the epoch (real). */
  x: number
  /** Wall-clock time of the (newest) sample, ms. */
  t: number
  frame: number | null
  /** The game's date, "yyyy-MM-dd HH:mm". */
  game: string | null
  run: number
  /** A recording gap or a jump in game time lies before this point: do not connect it. */
  gap: boolean
}

/** GET /api/desktop/trends/series */
export interface TrendSeries {
  city: { key: string; name: string }
  metrics: TrendMetric[]
  framesPerDay: number
  axis: TrendAxis
  extent: { min: number; max: number } | null
  from: number | null
  to: number | null
  /** Samples in the range before they were reduced to `points`. */
  samples: number
  points: TrendPoint[]
}

export type TrendAxis = "game" | "real"

export const TREND_AXES: { value: TrendAxis; label: string }[] = [
  { value: "game", label: "Game time" },
  { value: "real", label: "Real time" },
]

const HOUR = 3_600_000

/** The range choices of each axis: game time in days of game time, real time in ms. */
export const TREND_RANGES = {
  game: [
    { value: "week", label: "7 days", days: 7 },
    { value: "month", label: "30 days", days: 30 },
    { value: "year", label: "1 year", days: 365 },
    { value: "all", label: "All", days: null },
  ],
  real: [
    { value: "1h", label: "1 h", ms: HOUR },
    { value: "6h", label: "6 h", ms: 6 * HOUR },
    { value: "24h", label: "24 h", ms: 24 * HOUR },
    { value: "7d", label: "7 days", ms: 7 * 24 * HOUR },
    { value: "all", label: "All", ms: null },
  ],
} as const

export const DEFAULT_RANGE = "all"

export function isTrendRange(axis: TrendAxis, range: string): boolean {
  return (TREND_RANGES[axis] as readonly { value: string }[]).some((entry) => entry.value === range)
}

/** Query parameters of a series request for a range choice (`now` = wall clock for real time). */
export function rangeParams(
  axis: TrendAxis,
  range: string,
  framesPerDay: number,
  now: number
): { last?: number; from?: number } {
  if (axis === "game") {
    const days = TREND_RANGES.game.find((entry) => entry.value === range)?.days
    return days ? { last: days * framesPerDay } : {}
  }
  const ms = TREND_RANGES.real.find((entry) => entry.value === range)?.ms
  return ms ? { from: now - ms } : {}
}

/** One game day is 262144 simulation frames; the series response confirms it. */
export const FRAMES_PER_DAY = 262144

export const trendsQueryKeys = {
  all: ["desktop", "trends"] as const,
  status: ["desktop", "trends", "status"] as const,
  cities: ["desktop", "trends", "cities"] as const,
  series: (city: string, axis: TrendAxis, range: string, points: number) =>
    ["desktop", "trends", "series", city, axis, range, points] as const,
}

export const trendsStatusQuery = () =>
  queryOptions({
    queryKey: trendsQueryKeys.status,
    queryFn: ({ signal }) => apiGet<TrendsStatus>("/desktop/trends", {}, signal),
    refetchInterval: 10_000,
  })

export const trendsCitiesQuery = () =>
  queryOptions({
    queryKey: trendsQueryKeys.cities,
    queryFn: ({ signal }) => apiGet<{ cities: TrendCity[] }>("/desktop/trends/cities", {}, signal).then((r) => r.cities),
    refetchInterval: 30_000,
  })

/** Points drawn per chart: the recorder thins the series to this. */
export const CHART_POINTS = 600

/** One series request; `points` 0 returns every recorded sample of the range (CSV export). */
export function fetchTrendSeries(city: string, axis: TrendAxis, range: string, points: number, signal?: AbortSignal) {
  return apiGet<TrendSeries>(
    "/desktop/trends/series",
    { city, axis, points, ...rangeParams(axis, range, FRAMES_PER_DAY, Date.now()) },
    signal
  )
}

export const trendsSeriesQuery = (city: string, axis: TrendAxis, range: string, points = CHART_POINTS) =>
  queryOptions({
    queryKey: trendsQueryKeys.series(city, axis, range, points),
    queryFn: ({ signal }) => fetchTrendSeries(city, axis, range, points, signal),
    refetchInterval: 30_000,
    // keep the last chart on screen while another range or city loads
    placeholderData: keepPreviousData,
  })

/** Sets one `trends.*` setting through the settings route. */
export function setTrendsSetting(key: "trends.enabled" | "trends.intervalSeconds" | "trends.retentionDays", value: boolean | number) {
  return apiPost("/desktop/settings", { [key]: value })
}

/** Deletes the history of one city, or of all. */
export function clearTrends(target: { city: string } | { all: true }) {
  return apiPost<{ cleared: number }>("/desktop/trends/clear", target)
}

// ---- CSV ------------------------------------------------------------------------------------

function csvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return ""
  const text = String(value)
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

/**
 * The CSV of a series: one row per sample (or per point, when the series was reduced), with the
 * wall-clock time, the game date and frame, the recording run and one column per metric.
 */
export function seriesToCsv(series: Pick<TrendSeries, "metrics" | "points">): string {
  const header = ["time", "game_date", "frame", "run", ...series.metrics]
  const rows = series.points.map((point) => [
    new Date(point.t).toISOString(),
    point.game,
    point.frame,
    point.run,
    ...series.metrics.map((metric) => {
      const value = point[metric]
      return value === null || value === undefined ? null : Math.round(value * 100) / 100
    }),
  ])
  return [header, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n"
}

/** "Riverside" -> "riverside"; safe for a file name. */
export function fileSlug(name: string): string {
  return name.normalize("NFKD").replace(/[^\w-]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase() || "city"
}

/** Hands `text` to the user as a file download (a Blob and a temporary <a download>). */
export function downloadTextFile(filename: string, text: string, type = "text/csv;charset=utf-8") {
  const url = URL.createObjectURL(new Blob([text], { type }))
  const link = document.createElement("a")
  link.href = url
  link.download = filename
  link.rel = "noopener"
  document.body.append(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}
