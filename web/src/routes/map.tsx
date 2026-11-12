import { useQuery, useQueryClient } from "@tanstack/react-query"
import { createFileRoute, stripSearchParams } from "@tanstack/react-router"
import {
  MousePointer2Icon,
  RefreshCwIcon,
  SplineIcon,
  SquareDashedIcon,
} from "lucide-react"
import { useEffect, useMemo, useRef, useState } from "react"
import { z } from "zod"

import { QueryError } from "@/components/query-error"
import { WaitingForCity } from "@/components/waiting-for-city"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { LAYER_LABELS } from "@/features/map/layers"
import { MapCanvas } from "@/features/map/map-canvas"
import { MapLegend } from "@/features/map/map-legend"
import { OverlayCard } from "@/features/map/overlay-card"
import { SelectionPanel } from "@/features/map/selection-panel"
import { useRoads } from "@/features/map/use-roads"
import { useDebouncedValue } from "@/hooks/use-debounced-value"
import { useElementSize } from "@/hooks/use-element-size"
import { GRID_LAYERS, type GridLayer } from "@/lib/bridge-types"
import { useConnection } from "@/lib/connection"
import { historyMarkers } from "@/lib/history-markers"
import {
  cameraQuery,
  gridmapQuery,
  historyQuery,
  queryKeys,
} from "@/lib/queries"
import {
  decodeSelection,
  encodeSelection,
  isSelectionMode,
  SELECTION_MODES,
  type Selection,
  type SelectionMode,
} from "@/lib/selection"
import {
  clampView,
  roadTilesFor,
  type MapView,
  type WorldPoint,
} from "@/lib/world"

const SEARCH_DEFAULTS = {
  layer: "landValue" as GridLayer,
  cx: 0,
  cz: 0,
  zoom: 0,
  follow: false,
  mode: "point" as SelectionMode,
  roads: true,
  markers: true,
}

const mapSearch = z.object({
  layer: z.enum(GRID_LAYERS).default(SEARCH_DEFAULTS.layer).catch(SEARCH_DEFAULTS.layer),
  cx: z.number().default(0).catch(0),
  cz: z.number().default(0).catch(0),
  zoom: z.number().default(0).catch(0),
  follow: z.boolean().default(false).catch(false),
  mode: z.enum(SELECTION_MODES).default("point").catch("point"),
  sel: z.string().optional().catch(undefined),
  roads: z.boolean().default(true).catch(true),
  markers: z.boolean().default(true).catch(true),
})

export const Route = createFileRoute("/map")({
  validateSearch: mapSearch,
  search: { middlewares: [stripSearchParams(SEARCH_DEFAULTS)] },
  component: MapPage,
})

const MODE_ITEMS: { value: SelectionMode; label: string; icon: typeof MousePointer2Icon }[] = [
  { value: "point", label: "Point: click to pick, drag to move", icon: MousePointer2Icon },
  { value: "box", label: "Area: drag to mark an area", icon: SquareDashedIcon },
  { value: "line", label: "Line: drag from start to end", icon: SplineIcon },
]

const LAYER_ITEMS = GRID_LAYERS.map((value) => ({ value, label: LAYER_LABELS[value] }))

/** Rounded the way the view is written to the URL. */
function roundView(view: MapView): MapView {
  return {
    cx: Math.round(view.cx),
    cz: Math.round(view.cz),
    zoom: Math.round(view.zoom * 100) / 100,
  }
}

function sameView(a: MapView, b: MapView) {
  return a.cx === b.cx && a.cz === b.cz && a.zoom === b.zoom
}

function MapPage() {
  const connection = useConnection()
  if (!connection.ready) return <WaitingForCity />
  return <MapWorkspace />
}

function MapWorkspace() {
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  const containerRef = useRef<HTMLDivElement>(null)
  const size = useElementSize(containerRef)
  const [hover, setHover] = useState<WorldPoint>()

  const setSearch = (patch: Partial<z.infer<typeof mapSearch>>) =>
    navigate({ search: (prev) => ({ ...prev, ...patch }), replace: true })

  const camera = useQuery(cameraQuery(search.follow))
  const cameraPivot = camera.data?.pivot
  const followPivot = search.follow ? cameraPivot : undefined

  // The view lives in state while the user drags, and in the URL once it settles. While
  // following the game camera, the camera's look-at point is the centre and the zoom stays ours.
  const [view, setView] = useState<MapView>(() =>
    clampView({ cx: search.cx, cz: search.cz, zoom: search.zoom })
  )
  const shownView = followPivot
    ? clampView({ ...view, cx: followPivot.x, cz: followPivot.z })
    : view
  const settledView = useDebouncedValue(shownView, 350)

  // A URL change we did not write (a link, back/forward) moves the map there.
  const urlView = { cx: search.cx, cz: search.cz, zoom: search.zoom }
  const [seenUrlView, setSeenUrlView] = useState(urlView)
  if (!sameView(seenUrlView, urlView)) {
    setSeenUrlView(urlView)
    if (!sameView(urlView, roundView(settledView))) setView(clampView(urlView))
  }

  useEffect(() => {
    const rounded = roundView(settledView)
    navigate({ search: (prev) => ({ ...prev, ...rounded }), replace: true })
  }, [settledView, navigate])

  const queryClient = useQueryClient()
  const grid = useQuery(gridmapQuery(search.layer))
  // Tiles for the settled view (fallback for mods without /city/road-network), so a drag does
  // not request every tile it passes over.
  const roadTiles = search.roads && size ? roadTilesFor(settledView, size) : null
  const roads = useRoads({ enabled: search.roads, tiles: roadTiles })
  const history = useQuery(historyQuery())
  const reloadRoads = () => {
    queryClient.invalidateQueries({ queryKey: queryKeys.roadNetwork })
    queryClient.invalidateQueries({ queryKey: queryKeys.roadTiles })
  }

  // A change made through the bridge may have built or removed roads: drop the cached roads.
  const historyTotal = history.data?.total
  const seenHistoryTotal = useRef(historyTotal)
  useEffect(() => {
    if (historyTotal === undefined) return
    if (seenHistoryTotal.current !== undefined && seenHistoryTotal.current !== historyTotal) {
      reloadRoads()
    }
    seenHistoryTotal.current = historyTotal
  }, [historyTotal]) // eslint-disable-line react-hooks/exhaustive-deps

  const markers = useMemo(
    () => (search.markers && history.data ? historyMarkers(history.data.entries) : []),
    [search.markers, history.data]
  )
  const selection = useMemo(() => decodeSelection(search.sel), [search.sel])

  const handleViewChange = (next: MapView) => {
    if (followPivot && (next.cx !== shownView.cx || next.cz !== shownView.cz)) {
      setSearch({ follow: false })
    }
    setView(next)
  }

  // Only the tile fallback is limited to zoomed-in views; the whole network draws at any zoom.
  const roadsTooWide =
    search.roads && roads.source === "tiles" && size !== undefined && roadTilesFor(shownView, size) === null

  return (
    <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
      <div ref={containerRef} className="relative min-h-[60svh] flex-1 overflow-hidden lg:min-h-0">
        <MapCanvas
          view={shownView}
          size={size}
          grid={grid.data}
          roads={roadsTooWide || !search.roads ? undefined : roads.network}
          markers={markers}
          camera={camera.data}
          selection={selection}
          mode={search.mode}
          onViewChange={handleViewChange}
          onSelect={(next: Selection) => setSearch({ sel: encodeSelection(next) })}
          onHover={setHover}
        />

        <div className="pointer-events-none absolute inset-x-3 top-3 flex flex-wrap items-start gap-2 *:pointer-events-auto">
          <div className="flex items-center gap-1 rounded-lg border bg-background/90 p-1 shadow-sm backdrop-blur">
            <Select
              items={LAYER_ITEMS}
              value={search.layer}
              onValueChange={(value) => value && setSearch({ layer: value as GridLayer })}
            >
              <SelectTrigger size="sm" aria-label="Data layer" className="w-48">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {LAYER_ITEMS.map((item) => (
                    <SelectItem key={item.value} value={item.value}>
                      {item.label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Reload data layer"
                    disabled={grid.isFetching}
                    onClick={() => grid.refetch()}
                  />
                }
              >
                <RefreshCwIcon />
              </TooltipTrigger>
              <TooltipContent>Reload data layer</TooltipContent>
            </Tooltip>
          </div>

          <div className="rounded-lg border bg-background/90 p-1 shadow-sm backdrop-blur">
            <ToggleGroup
              size="sm"
              spacing={0}
              aria-label="Selection mode"
              value={[search.mode]}
              onValueChange={(value: string[]) => {
                const next = value.at(-1)
                if (next && isSelectionMode(next)) setSearch({ mode: next })
              }}
            >
              {MODE_ITEMS.map(({ value, label, icon: Icon }) => (
                <Tooltip key={value}>
                  <TooltipTrigger render={<ToggleGroupItem value={value} aria-label={label} />}>
                    <Icon />
                  </TooltipTrigger>
                  <TooltipContent>{label}</TooltipContent>
                </Tooltip>
              ))}
            </ToggleGroup>
          </div>

          {roadsTooWide && <Badge variant="secondary">Zoom in to see roads</Badge>}
          {!roadsTooWide && roads.fetching && <Badge variant="outline">Loading roads</Badge>}
          {!roadsTooWide && roads.truncated > 0 && (
            <Badge variant="outline">Dense area: some roads not shown</Badge>
          )}
        </div>

        <div className="pointer-events-none absolute bottom-3 left-3 flex max-w-[calc(100%-1.5rem)] flex-col gap-2 *:pointer-events-auto">
          {grid.isError && <QueryError title="Could not load the data layer" error={grid.error} />}
          {roads.error && !roadsTooWide && (
            <QueryError title="Could not load roads" error={roads.error} />
          )}
          <MapLegend layer={search.layer} grid={grid.data} loading={grid.isFetching} hover={hover} />
        </div>
      </div>

      <aside className="flex flex-col gap-4 overflow-auto border-t p-4 lg:w-96 lg:border-t-0 lg:border-l">
        <SelectionPanel
          selection={selection}
          layer={search.layer}
          grid={grid.data}
          onClear={() => setSearch({ sel: undefined })}
        />
        <OverlayCard
          roads={search.roads}
          markers={search.markers}
          follow={search.follow}
          camera={camera.data}
          onRoadsChange={(roads) => setSearch({ roads })}
          onReloadRoads={reloadRoads}
          onMarkersChange={(on) => setSearch({ markers: on })}
          onFollowChange={(follow) => setSearch({ follow })}
          onCentreCamera={() =>
            cameraPivot &&
            setView((current) =>
              clampView({ ...current, cx: cameraPivot.x, cz: cameraPivot.z, zoom: Math.max(current.zoom, 4) })
            )
          }
        />
      </aside>
    </div>
  )
}
