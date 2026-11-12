import { useQuery } from "@tanstack/react-query"
import { CircleAlertIcon } from "lucide-react"

import { QueryError } from "@/components/query-error"
import { StatList } from "@/components/stat-list"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Progress, ProgressLabel } from "@/components/ui/progress"
import { Separator } from "@/components/ui/separator"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  INFO_LAYOUTS,
  usedKeys,
  type InfoBlock,
  type InfoLayout,
} from "@/features/dashboard/infoview-layouts"
import {
  humanizeName,
  notificationTypes,
  SERVICE_WARNING_GROUP,
  type ServiceRow,
} from "@/features/dashboard/service-status"
import { ApiError } from "@/lib/api"
import type {
  Coverage,
  CoverageService,
  IndicatorValue,
  Notifications,
  Traffic,
} from "@/lib/bridge-types"
import { formatNumber } from "@/lib/format"
import { cn } from "@/lib/utils"
import { infoviewQuery } from "@/lib/queries"

function formatValue(value: number, digits = 0) {
  return digits > 0
    ? value.toLocaleString("en-US", { maximumFractionDigits: digits, minimumFractionDigits: 0 })
    : formatNumber(value)
}

const asNumber = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : undefined)

function isIndicator(value: unknown): value is IndicatorValue {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as IndicatorValue).current === "number" &&
    typeof (value as IndicatorValue).max === "number"
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h4 className="text-xs font-medium text-muted-foreground">{title}</h4>
      {children}
    </section>
  )
}

/** Used against capacity, like a school row of the Education panel. */
function Meter({
  label,
  used,
  capacity,
  unit,
  extra,
}: {
  label: string
  used: number
  capacity: number
  unit: string
  extra?: { label: string; value: number }
}) {
  const share = capacity > 0 ? (used / capacity) * 100 : used > 0 ? 100 : 0
  const over = capacity > 0 && used > capacity
  return (
    <div className="flex flex-col gap-1.5" aria-label={label} role="group">
      <Progress value={Math.min(100, share)} aria-valuetext={`${formatValue(used)} of ${formatValue(capacity)}`}>
        <ProgressLabel>{label}</ProgressLabel>
        <span className="ms-auto text-sm tabular-nums">
          {formatValue(used)} {unit}
        </span>
      </Progress>
      <div className="flex justify-between gap-2 text-xs text-muted-foreground tabular-nums">
        <span>{extra ? `${extra.label}: ${formatValue(extra.value)}` : `${Math.round(share)}% used`}</span>
        <span className={over ? "text-destructive" : undefined}>
          Capacity: {formatValue(capacity)}
          {over ? " (over capacity)" : ""}
        </span>
      </div>
    </div>
  )
}

/** An { min, max, current } bar of a panel. */
function Indicator({ label, value }: { label: string; value: IndicatorValue }) {
  const span = value.max - value.min
  const share = span > 0 ? ((value.current - value.min) / span) * 100 : 0
  return (
    <Progress
      value={Math.max(0, Math.min(100, share))}
      aria-valuetext={`${formatValue(value.current, 2)} on a scale of ${formatValue(value.min, 2)} to ${formatValue(value.max, 2)}`}
    >
      <ProgressLabel>{label}</ProgressLabel>
      <span className="ms-auto text-sm tabular-nums text-muted-foreground">
        {formatValue(value.current, 2)} / {formatValue(value.max, 2)}
      </span>
    </Progress>
  )
}

/** "poorlyEducated" -> "Poorly Educated" */
const label = (key: string) => {
  const words = humanizeName(key)
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/** Every number in a raw binding's JSON, with its path as the label. */
function flattenNumbers(value: unknown, prefix = ""): { label: string; value: number }[] {
  if (typeof value === "number") return [{ label: prefix || "Value", value }]
  if (Array.isArray(value)) return value.flatMap((item, i) => flattenNumbers(item, prefix ? `${prefix} ${i + 1}` : `#${i + 1}`))
  if (typeof value === "object" && value !== null) {
    return Object.entries(value).flatMap(([key, item]) =>
      flattenNumbers(item, prefix ? `${prefix} · ${label(key)}` : label(key))
    )
  }
  return []
}

function Block({ block, values }: { block: InfoBlock; values: Record<string, unknown> }) {
  switch (block.kind) {
    case "meter": {
      const used = asNumber(values[block.used])
      const capacity = asNumber(values[block.capacity])
      if (used === undefined || capacity === undefined) return null
      const extra = block.extra ? asNumber(values[block.extra.key]) : undefined
      return (
        <Meter
          label={block.label}
          used={used}
          capacity={capacity}
          unit={block.unit}
          extra={block.extra && extra !== undefined ? { label: block.extra.label, value: extra } : undefined}
        />
      )
    }
    case "indicator": {
      const value = values[block.key]
      return isIndicator(value) ? <Indicator label={block.label} value={value} /> : null
    }
    case "stats": {
      const stats = block.items.flatMap((item) => {
        const value = asNumber(values[item.key])
        return value === undefined ? [] : [{ label: item.label, value: formatValue(value, item.digits) }]
      })
      return stats.length > 0 ? <StatList stats={stats} /> : null
    }
    case "raw": {
      const numbers = flattenNumbers(values[block.key])
      if (numbers.length === 0) return null
      return (
        <Section title={block.label}>
          <StatList stats={numbers.map((n) => ({ label: n.label, value: formatValue(n.value, 1) }))} />
        </Section>
      )
    }
  }
}

/** The service's info view panel, recalculated by the bridge while this item is open. */
function InfoviewSection({ layout }: { layout: InfoLayout }) {
  const infoview = useQuery(infoviewQuery(layout.view))

  if (infoview.isError) {
    const unsupported =
      infoview.error instanceof ApiError && (infoview.error.status === 404 || infoview.error.status === 400)
    return unsupported ? (
      <Alert>
        <CircleAlertIcon />
        <AlertTitle>Panel figures need the updated mod</AlertTitle>
        <AlertDescription>
          Restart Cities: Skylines II so it loads the CS2MCP build with info view support.
        </AlertDescription>
      </Alert>
    ) : (
      <QueryError title="Could not read the info view" error={infoview.error} />
    )
  }
  if (!infoview.data) return <Skeleton className="h-24" />

  const { values } = infoview.data
  const shown = new Set(
    Object.values(INFO_LAYOUTS)
      .filter((other) => other?.view === layout.view)
      .flatMap((other) => [...usedKeys(other!)])
  )
  const more = Object.entries(values).flatMap(([key, value]) => {
    if (shown.has(key)) return []
    const number = asNumber(value)
    if (number !== undefined) return [{ label: label(key), value: formatValue(number, 2) }]
    if (isIndicator(value)) {
      return [{ label: label(key), value: `${formatValue(value.current, 2)} / ${formatValue(value.max, 2)}` }]
    }
    return []
  })

  return (
    <Section title="In-game panel">
      {!infoview.data.refreshed && (
        <p className="text-xs text-muted-foreground">
          Could not recalculate the panel ({infoview.data.refreshError ?? "unknown reason"}); these are
          the figures from when it was last open in the game.
        </p>
      )}
      {layout.blocks.map((block, i) => (
        <Block key={i} block={block} values={values} />
      ))}
      {more.length > 0 && (
        <details className="text-sm">
          <summary className="cursor-pointer text-xs text-muted-foreground">More figures</summary>
          <div className="pt-3">
            <StatList stats={more} />
          </div>
        </details>
      )}
    </Section>
  )
}

const LEVELS = [
  { key: "none", label: "None", className: "bg-destructive" },
  { key: "low", label: "Low", className: "bg-destructive/50" },
  { key: "medium", label: "Medium", className: "bg-muted-foreground/50" },
  { key: "high", label: "High", className: "bg-primary" },
] as const

function CoverageSection({ service }: { service: CoverageService }) {
  const levels = service.levels
  const total = levels ? levels.none + levels.low + levels.medium + levels.high : 0
  const kinds = Object.entries(service.byKind ?? {}).sort((a, b) => b[1].buildings - a[1].buildings)
  return (
    <Section title="Coverage of zoned buildings">
      <StatList
        stats={[
          { label: "Buildings covered", value: `${formatNumber(service.buildings - service.underservedBuildings)} of ${formatNumber(service.buildings)}` },
          { label: "Residents underserved", value: formatNumber(service.underservedResidents) },
          ...(service.providers !== null ? [{ label: "Facilities", value: formatNumber(service.providers) }] : []),
        ]}
      />
      {levels && total > 0 && (
        <div className="flex flex-col gap-2">
          <div aria-hidden className="flex h-2.5 overflow-hidden rounded-full bg-muted">
            {LEVELS.map((level) => (
              <div
                key={level.key}
                className={level.className}
                style={{ width: `${(levels[level.key] / total) * 100}%` }}
              />
            ))}
          </div>
          <ul aria-label="Coverage levels" className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
            {LEVELS.map((level) => (
              <li key={level.key} className="flex items-center gap-1.5">
                <span aria-hidden className={cn("size-2 rounded-full", level.className)} />
                {level.label}: {formatNumber(levels[level.key])} ({Math.round((levels[level.key] / total) * 100)}%)
              </li>
            ))}
          </ul>
        </div>
      )}
      {kinds.length > 0 && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Zone</TableHead>
              <TableHead className="text-end">Buildings</TableHead>
              <TableHead className="text-end">Underserved</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {kinds.map(([kind, counts]) => (
              <TableRow key={kind}>
                <TableCell className="capitalize">{humanizeName(kind)}</TableCell>
                <TableCell className="text-end tabular-nums">{formatNumber(counts.buildings)}</TableCell>
                <TableCell className="text-end tabular-nums">
                  {formatNumber(counts.underserved)}
                  {counts.buildings > 0 ? ` (${Math.round((counts.underserved / counts.buildings) * 100)}%)` : ""}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Section>
  )
}

function TrafficSection({ traffic }: { traffic: Traffic }) {
  return (
    <Section title="Traffic">
      <StatList
        stats={[
          { label: "City flow", value: `${traffic.cityTrafficFlowPercent}%` },
          { label: "Volume", value: formatNumber(traffic.cityTrafficVolume) },
          { label: "Roads", value: formatNumber(traffic.cityRoadsAveraged) },
          { label: "Under 50% flow", value: formatNumber(traffic.congestedRoads.below50Percent) },
          { label: "Under 25% flow", value: formatNumber(traffic.congestedRoads.below25Percent) },
          { label: "Bottlenecks", value: formatNumber(traffic.bottlenecks.count), detail: `${formatNumber(traffic.bottlenecks.lanes)} lanes` },
        ]}
      />
    </Section>
  )
}

function WarningsSection({ types }: { types: ReturnType<typeof notificationTypes> }) {
  return (
    <Section title="Warning icons">
      <ul aria-label="Warning icons" className="flex flex-col gap-1.5">
        {types.map((item) => (
          <li key={item.type} className="flex items-center gap-2 text-sm">
            <span className="min-w-0 flex-1 truncate" title={item.type}>
              {item.label}
            </span>
            <span className="font-medium tabular-nums">{formatNumber(item.count)}</span>
          </li>
        ))}
      </ul>
    </Section>
  )
}

function isCoverageService(value: unknown): value is CoverageService {
  return typeof value === "object" && value !== null && "underservedPercent" in value
}

/** Everything known about one service; mounted only while its accordion item is open. */
export function ServiceDetails({
  row,
  coverage,
  traffic,
  notifications,
}: {
  row: ServiceRow
  coverage: Coverage | undefined
  traffic: Traffic | undefined
  notifications: Notifications | undefined
}) {
  const layout = INFO_LAYOUTS[row.id]
  const coverageService = coverage?.services[row.id]
  const group = SERVICE_WARNING_GROUP[row.id]
  const warnings = group ? notificationTypes(notifications).filter((item) => item.group === group) : []

  const sections = [
    layout && <InfoviewSection key="infoview" layout={layout} />,
    row.id === "traffic" && traffic && <TrafficSection key="traffic" traffic={traffic} />,
    isCoverageService(coverageService) && coverageService.buildings > 0 && (
      <CoverageSection key="coverage" service={coverageService} />
    ),
    warnings.length > 0 && <WarningsSection key="warnings" types={warnings} />,
  ].filter(Boolean)

  return (
    <div className="flex flex-col gap-4 px-1 pt-1">
      <p className="text-sm text-muted-foreground">{row.detail}</p>
      {sections.flatMap((section, i) => (i === 0 ? [section] : [<Separator key={`sep-${i}`} />, section]))}
    </div>
  )
}
