import { cn } from "cn"
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react"

import { formatNumber } from "@/lib/format"
import { FRAMES_PER_DAY, type TrendAxis, type TrendMetric, type TrendPoint } from "@/lib/trends"

/**
 * A small hand-written SVG line chart for the Trends page (no chart dependency, see
 * desktop/README.md): several series on one value axis, a time axis in game or real time, line
 * breaks at recording gaps, a hover/keyboard cursor with a tooltip. Colours come from Tailwind
 * classes (`text-*`), so they follow the light/dark theme.
 */

export interface ChartLine {
  key: TrendMetric
  label: string
  /** Tailwind text colour classes; the line, dots and legend swatch use currentColor. */
  className: string
}

export interface TrendChartProps {
  title: string
  lines: ChartLine[]
  points: TrendPoint[]
  axis: TrendAxis
  /** Tooltip and screen-reader values. */
  formatValue?: (value: number) => string
  /** Value-axis labels (default: formatValue). */
  formatTick?: (value: number) => string
  /** The value axis never leaves these bounds (e.g. 0..255 demand). */
  bounds?: { min?: number; max?: number }
  height?: number
  className?: string
}

const MARGIN = { top: 10, right: 14, bottom: 26, left: 56 }
const DEFAULT_WIDTH = 640

/** 1, 2, 5 x 10^n steps covering [min, max]. */
export function niceScale(min: number, max: number, count = 4, bounds: TrendChartProps["bounds"] = {}) {
  if (!(max > min)) {
    const pad = Math.max(Math.abs(min) * 0.05, 1)
    min -= pad
    max += pad
  }
  const raw = (max - min) / count
  const magnitude = 10 ** Math.floor(Math.log10(raw))
  const normalized = raw / magnitude
  const step = (normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10) * magnitude
  let start = Math.floor(min / step) * step
  let end = Math.ceil(max / step) * step
  if (bounds.min !== undefined) start = Math.max(start, bounds.min)
  if (bounds.max !== undefined) end = Math.min(end, bounds.max)
  const ticks: number[] = []
  for (let value = Math.ceil(start / step) * step; value <= end + step / 1e6; value += step) {
    ticks.push(Math.round(value / step) * step)
  }
  if (ticks.length < 2) ticks.push(start, end)
  return { min: start, max: end, ticks: [...new Set(ticks)].sort((a, b) => a - b) }
}

/** Index of the point whose x is closest to `x` (points are sorted by x). */
export function nearestIndex(xs: number[], x: number): number {
  let low = 0
  let high = xs.length - 1
  while (high - low > 1) {
    const mid = (low + high) >> 1
    if (xs[mid] < x) low = mid
    else high = mid
  }
  return Math.abs(xs[low] - x) <= Math.abs(xs[high] - x) ? low : high
}

const timeFormat = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" })
const dayFormat = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" })
const fullFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" })

/** Label of a point on the time axis; `span` is the visible width in axis units. */
export function timeLabel(point: TrendPoint, axis: TrendAxis, span: number): string {
  if (axis === "game") {
    if (!point.game) return ""
    const [date, time = ""] = point.game.split(" ")
    return span < 3 * FRAMES_PER_DAY ? `${date.slice(5)} ${time}`.trim() : date
  }
  const date = new Date(point.t)
  return span < 2 * 86_400_000 ? timeFormat.format(date) : dayFormat.format(date)
}

function useWidth(ref: React.RefObject<HTMLElement | null>) {
  const [width, setWidth] = useState(DEFAULT_WIDTH)
  useEffect(() => {
    const element = ref.current
    if (!element || typeof ResizeObserver === "undefined") return
    const observer = new ResizeObserver(([entry]) => {
      const next = Math.floor(entry.contentRect.width)
      if (next > 0) setWidth(next)
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [ref])
  return width
}

interface Segment {
  from: number
  to: number
}

/** Runs of consecutive points with a value, broken at gaps. */
function segmentsOf(points: TrendPoint[], key: TrendMetric): Segment[] {
  const segments: Segment[] = []
  let current: Segment | null = null
  points.forEach((point, index) => {
    const value = point[key]
    if (value === null || value === undefined) {
      current = null
      return
    }
    if (!current || point.gap) {
      current = { from: index, to: index }
      segments.push(current)
    } else {
      current.to = index
    }
  })
  return segments
}

export function TrendChart({
  title,
  lines,
  points,
  axis,
  formatValue = formatNumber,
  formatTick,
  bounds,
  height = 190,
  className,
}: TrendChartProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const width = useWidth(containerRef)
  const [cursor, setCursor] = useState<number | null>(null)
  const descriptionId = useId()
  const tickFormat = formatTick ?? formatValue

  const layout = useMemo(() => {
    const innerWidth = Math.max(10, width - MARGIN.left - MARGIN.right)
    const innerHeight = height - MARGIN.top - MARGIN.bottom
    const xs = points.map((point) => point.x)
    const first = xs[0] ?? 0
    const last = xs.at(-1) ?? 1
    const x0 = last > first ? first : first - 1
    const x1 = last > first ? last : first + 1
    const values: number[] = []
    for (const point of points) {
      for (const line of lines) {
        const value = point[line.key]
        if (value !== null && value !== undefined) values.push(value)
      }
    }
    const scale = values.length
      ? niceScale(Math.min(...values), Math.max(...values), 4, bounds)
      : null
    const px = (x: number) => (xs.length === 1 ? MARGIN.left + innerWidth / 2 : MARGIN.left + ((x - x0) / (x1 - x0)) * innerWidth)
    const py = (value: number) =>
      scale ? MARGIN.top + innerHeight - ((value - scale.min) / (scale.max - scale.min || 1)) * innerHeight : 0
    return { innerWidth, innerHeight, xs, x0, x1, scale, px, py }
  }, [points, lines, width, height, bounds])

  const { scale, xs, px, py } = layout
  const index = cursor === null ? null : Math.min(cursor, points.length - 1)
  const active = index === null ? null : points[index]

  function moveTo(event: PointerEvent<SVGSVGElement>) {
    if (!points.length) return
    const rect = event.currentTarget.getBoundingClientRect()
    const x = event.clientX - rect.left
    const fraction = (x - MARGIN.left) / layout.innerWidth
    setCursor(nearestIndex(xs, layout.x0 + fraction * (layout.x1 - layout.x0)))
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (!points.length) return
    const lastIndex = points.length - 1
    const current = index ?? lastIndex
    const next =
      event.key === "ArrowLeft" ? current - 1
      : event.key === "ArrowRight" ? current + 1
      : event.key === "Home" ? 0
      : event.key === "End" ? lastIndex
      : null
    if (event.key === "Escape") setCursor(null)
    if (next === null) return
    event.preventDefault()
    setCursor(Math.max(0, Math.min(lastIndex, next)))
  }

  const latest = points.at(-1)
  const summary = latest
    ? `${title}. Latest: ${lines
        .map((line) => {
          const value = latest[line.key]
          return `${line.label} ${value === null || value === undefined ? "no value" : formatValue(value)}`
        })
        .join(", ")}${latest.game ? ` on ${latest.game}` : ""}. Use the arrow keys to inspect earlier points.`
    : `${title}. No data in this range.`

  const span = layout.x1 - layout.x0
  const tickCount = width < 420 ? 3 : 5
  const xTicks = points.length
    ? Array.from({ length: tickCount }, (_, i) => {
        const point = points[nearestIndex(xs, layout.x0 + (span * i) / (tickCount - 1))]
        return { x: px(point.x), label: timeLabel(point, axis, span), point }
      }).filter((tick, i, all) => i === 0 || tick.point !== all[i - 1].point)
    : []

  const cursorX = active ? px(active.x) : 0
  const flip = cursorX > width * 0.55

  return (
    <div
      ref={containerRef}
      role="group"
      aria-label={`${title} chart`}
      aria-describedby={descriptionId}
      tabIndex={0}
      onKeyDown={onKeyDown}
      onBlur={() => setCursor(null)}
      className={cn("relative rounded-md outline-none focus-visible:ring-3 focus-visible:ring-ring/50", className)}
      data-testid="trend-chart"
    >
      <p id={descriptionId} className="sr-only">
        {summary}
      </p>
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        className="block touch-pan-y select-none"
        aria-hidden="true"
        onPointerMove={moveTo}
        onPointerDown={moveTo}
        onPointerLeave={() => setCursor(null)}
      >
        {scale?.ticks.map((tick) => (
          <g key={tick}>
            <line
              x1={MARGIN.left}
              x2={width - MARGIN.right}
              y1={py(tick)}
              y2={py(tick)}
              className="stroke-border"
              strokeWidth={1}
              strokeDasharray={tick === scale.min ? undefined : "3 3"}
            />
            <text x={MARGIN.left - 8} y={py(tick)} dy="0.32em" textAnchor="end" className="fill-muted-foreground text-[11px] tabular-nums">
              {tickFormat(tick)}
            </text>
          </g>
        ))}
        {xTicks.map((tick, i) => (
          <text
            key={`${tick.x}-${i}`}
            x={tick.x}
            y={height - 8}
            textAnchor={i === 0 ? "start" : i === xTicks.length - 1 ? "end" : "middle"}
            className="fill-muted-foreground text-[11px]"
          >
            {tick.label}
          </text>
        ))}
        {scale &&
          lines.map((line, lineIndex) => (
            <g key={line.key} className={line.className} data-series={line.key}>
              {segmentsOf(points, line.key).map((segment) => {
                const slice = points.slice(segment.from, segment.to + 1)
                if (slice.length === 1) {
                  return <circle key={segment.from} cx={px(slice[0].x)} cy={py(slice[0][line.key] as number)} r={2.5} fill="currentColor" />
                }
                const d = slice
                  .map((point, i) => `${i === 0 ? "M" : "L"}${px(point.x).toFixed(1)} ${py(point[line.key] as number).toFixed(1)}`)
                  .join("")
                return (
                  <g key={segment.from}>
                    {lines.length === 1 && lineIndex === 0 && (
                      <path
                        d={`${d}L${px(slice.at(-1)!.x).toFixed(1)} ${py(scale.min)}L${px(slice[0].x).toFixed(1)} ${py(scale.min)}Z`}
                        fill="currentColor"
                        fillOpacity={0.1}
                        stroke="none"
                      />
                    )}
                    <path d={d} fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinejoin="round" strokeLinecap="round" />
                  </g>
                )
              })}
            </g>
          ))}
        {scale && active && (
          <g pointerEvents="none">
            <line x1={cursorX} x2={cursorX} y1={MARGIN.top} y2={height - MARGIN.bottom} className="stroke-muted-foreground/60" strokeWidth={1} />
            {lines.map((line) => {
              const value = active[line.key]
              if (value === null || value === undefined) return null
              return (
                <circle key={line.key} cx={cursorX} cy={py(value)} r={3.5} className={cn("fill-background", line.className)} stroke="currentColor" strokeWidth={2} />
              )
            })}
          </g>
        )}
        {!scale && (
          <text x={width / 2} y={height / 2} textAnchor="middle" className="fill-muted-foreground text-xs">
            No data in this range
          </text>
        )}
      </svg>
      {active && (
        <div
          role="status"
          data-testid="trend-tooltip"
          className="pointer-events-none absolute top-1 z-10 min-w-36 rounded-md border bg-popover px-2.5 py-1.5 text-xs text-popover-foreground shadow-md"
          style={{ left: cursorX, transform: `translateX(${flip ? "calc(-100% - 12px)" : "12px"})` }}
        >
          <div className="mb-1 font-medium">{active.game ?? fullFormat.format(new Date(active.t))}</div>
          {active.game && <div className="mb-1 text-muted-foreground">{fullFormat.format(new Date(active.t))}</div>}
          <ul className="flex flex-col gap-0.5">
            {lines.map((line) => {
              const value = active[line.key]
              return (
                <li key={line.key} className="flex items-center gap-2">
                  <span className={cn("size-2 shrink-0 rounded-full bg-current", line.className)} aria-hidden="true" />
                  <span className="text-muted-foreground">{line.label}</span>
                  <span className="ms-auto ps-3 font-medium tabular-nums">
                    {value === null || value === undefined ? "–" : formatValue(value)}
                  </span>
                </li>
              )
            })}
          </ul>
        </div>
      )}
    </div>
  )
}
