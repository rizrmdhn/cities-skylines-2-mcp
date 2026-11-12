import { useQuery } from "@tanstack/react-query"
import { ChartLineIcon, DownloadIcon, MonitorIcon } from "lucide-react"
import { useMemo, useState } from "react"
import { toast } from "sonner"

import { QueryError } from "@/components/query-error"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { PANELS } from "@/features/trends/panels"
import { RecorderCard } from "@/features/trends/recorder-card"
import { TrendChart } from "@/features/trends/trend-chart"
import { ApiError } from "@/lib/api"
import { useDesktop } from "@/lib/desktop"
import { formatNumber } from "@/lib/format"
import {
  DEFAULT_RANGE,
  downloadTextFile,
  fetchTrendSeries,
  fileSlug,
  isTrendRange,
  seriesToCsv,
  TREND_AXES,
  TREND_RANGES,
  trendsCitiesQuery,
  trendsSeriesQuery,
  trendsStatusQuery,
  type TrendAxis,
  type TrendCity,
  type TrendSeries,
} from "@/lib/trends"

export interface TrendsSearch {
  city?: string
  axis: TrendAxis
  range: string
}

/** The Trends page. History is recorded by the desktop app; the browser companion shows a note. */
export function TrendsView({
  search,
  onSearch,
}: {
  search: TrendsSearch
  onSearch: (patch: Partial<TrendsSearch>) => void
}) {
  const { isDesktop, isPending } = useDesktop()
  if (isPending) return <Skeleton className="m-4 h-64" />
  if (!isDesktop) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <MonitorIcon />
          </EmptyMedia>
          <EmptyTitle>Trends are available in the desktop app</EmptyTitle>
          <EmptyDescription>
            The CS2MCP Companion desktop app records how your city develops in the background, even while its window
            is hidden, and charts it here. The browser version has no history to show.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }
  return <DesktopTrends search={search} onSearch={onSearch} />
}

function DesktopTrends({ search, onSearch }: { search: TrendsSearch; onSearch: (patch: Partial<TrendsSearch>) => void }) {
  const status = useQuery(trendsStatusQuery())
  const cities = useQuery(trendsCitiesQuery())
  const [exporting, setExporting] = useState(false)

  // Cities with data, plus the one that is loaded right now (it may not have a sample yet).
  const options = useMemo<TrendCity[]>(() => {
    const list = cities.data ?? []
    const current = status.data?.city
    if (current && !list.some((city) => city.key === current.key)) {
      return [
        { key: current.key, name: current.name, samples: 0, firstAt: null, lastAt: null, firstGame: null, lastGame: null },
        ...list,
      ]
    }
    return list
  }, [cities.data, status.data?.city])

  const selected =
    options.find((city) => city.key === search.city) ??
    options.find((city) => city.key === status.data?.city?.key) ??
    options[0]
  const axis = search.axis
  const range = isTrendRange(axis, search.range) ? search.range : DEFAULT_RANGE

  const series = useQuery({ ...trendsSeriesQuery(selected?.key ?? "", axis, range), enabled: Boolean(selected) })
  const noData = series.error instanceof ApiError && series.error.status === 404

  if (status.isError) return <PageFrame><QueryError title="Could not reach the recorder" error={status.error} /></PageFrame>
  if (!status.data || cities.isPending) return <PageFrame><Skeleton className="h-24" /><Skeleton className="h-64" /></PageFrame>

  async function exportCsv() {
    if (!selected) return
    setExporting(true)
    try {
      const raw = await fetchTrendSeries(selected.key, axis, range, 0)
      downloadTextFile(`cs2mcp-trends-${fileSlug(selected.name)}-${axis}-${range}.csv`, seriesToCsv(raw))
      toast.success(`Exported ${formatNumber(raw.points.length)} rows`)
    } catch (error) {
      toast.error(`Could not export: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setExporting(false)
    }
  }

  const hasData = Boolean(selected && selected.samples > 0 && !noData)
  const data = hasData ? series.data : undefined

  return (
    <PageFrame>
      <RecorderCard
        status={status.data}
        city={selected && selected.samples > 0 ? selected : null}
        cityCount={cities.data?.length ?? 0}
      />

      {options.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <Select
            items={options.map((city) => ({ value: city.key, label: city.name }))}
            value={selected?.key ?? null}
            onValueChange={(value) => onSearch({ city: value === null ? undefined : String(value) })}
          >
            <SelectTrigger size="sm" aria-label="City" className="w-48">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {options.map((city) => (
                  <SelectItem key={city.key} value={city.key}>
                    {city.name}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
          <ToggleGroup
            variant="outline"
            size="sm"
            spacing={0}
            aria-label="Time axis"
            value={[axis]}
            onValueChange={(value: string[]) => {
              const next = TREND_AXES.find((entry) => entry.value === value.at(-1))
              if (next && next.value !== axis) onSearch({ axis: next.value, range: DEFAULT_RANGE })
            }}
          >
            {TREND_AXES.map((entry) => (
              <ToggleGroupItem key={entry.value} value={entry.value}>
                {entry.label}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          <ToggleGroup
            variant="outline"
            size="sm"
            spacing={0}
            aria-label="Range"
            value={[range]}
            onValueChange={(value: string[]) => {
              const next = value.at(-1)
              if (next && isTrendRange(axis, next)) onSearch({ range: next })
            }}
          >
            {TREND_RANGES[axis].map((entry) => (
              <ToggleGroupItem key={entry.value} value={entry.value}>
                {entry.label}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          <Button variant="outline" size="sm" className="ms-auto" disabled={!hasData || exporting} onClick={() => void exportCsv()}>
            <DownloadIcon data-icon="inline-start" />
            Export CSV
          </Button>
        </div>
      )}

      {!hasData ? (
        <NoHistory cityName={selected?.name} enabled={status.data.enabled} interval={status.data.intervalSeconds} />
      ) : series.isError && !noData ? (
        <QueryError title="Could not load the history" error={series.error} />
      ) : !data ? (
        <Skeleton className="h-64" />
      ) : (
        <Charts series={data} axis={axis} />
      )}
    </PageFrame>
  )
}

function PageFrame({ children }: { children: React.ReactNode }) {
  return <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 p-4">{children}</div>
}

function NoHistory({ cityName, enabled, interval }: { cityName?: string; enabled: boolean; interval: number }) {
  return (
    <Empty>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <ChartLineIcon />
        </EmptyMedia>
        <EmptyTitle>{cityName ? `No history for ${cityName} yet` : "No history yet"}</EmptyTitle>
        <EmptyDescription>
          {enabled
            ? `Recording starts now. While a city is loaded and the game is running, the app saves a sample every ${interval} seconds, even when this window is hidden. Charts appear after a few samples; nothing is recorded while the game is paused.`
            : "Recording is switched off. Turn on “Record history” above and the charts fill as you play."}
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  )
}

function Charts({ series, axis }: { series: TrendSeries; axis: TrendAxis }) {
  const first = series.points[0]
  const last = series.points.at(-1)
  const panels = PANELS.filter((panel) =>
    series.points.some((point) => panel.lines.some((line) => point[line.key] != null))
  )
  const reduced = series.samples > series.points.length
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted-foreground" data-testid="trend-range">
        {formatNumber(series.samples)} samples
        {first?.game && last?.game ? `, ${first.game} to ${last.game} in game time` : ""}
        {reduced ? `, averaged into ${formatNumber(series.points.length)} points` : ""}.
        {axis === "game"
          ? " Game time only moves while the simulation runs."
          : " Real time includes the pauses between play sessions."}
      </p>
      <div className="grid gap-4 lg:grid-cols-2">
        {(panels.length ? panels : PANELS).map((panel) => (
          <Card key={panel.id} size="sm" data-testid={`panel-${panel.id}`}>
            <CardHeader>
              <CardTitle>{panel.title}</CardTitle>
              <CardDescription>{panel.description}</CardDescription>
            </CardHeader>
            <CardContent>
              <TrendChart
                title={panel.title}
                lines={panel.lines}
                points={series.points}
                axis={axis}
                formatValue={panel.formatValue}
                formatTick={panel.formatTick}
                bounds={panel.bounds}
              />
              <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                {panel.lines.map((line) => (
                  <li key={line.key} className="flex items-center gap-1.5">
                    <span className={`size-2 rounded-full bg-current ${line.className}`} aria-hidden="true" />
                    {line.label}
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  )
}
