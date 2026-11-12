import { Spinner } from "@/components/ui/spinner"
import type { GridLayer, GridMap } from "@/lib/bridge-types"
import { formatLayerValue, LAYER_LABELS } from "@/features/map/layers"
import { PALETTE_CSS, valueAt, valueRange } from "@/lib/heatmap"
import type { WorldPoint } from "@/lib/world"
import { useMemo } from "react"

/** Colour scale of the heatmap plus the coordinates and value under the pointer. */
export function MapLegend({
  layer,
  grid,
  loading,
  hover,
}: {
  layer: GridLayer
  grid: GridMap | undefined
  loading: boolean
  hover: WorldPoint | undefined
}) {
  const range = useMemo(() => (grid ? valueRange(grid.values) : undefined), [grid])
  const hoverValue = grid && hover ? valueAt(grid, hover) : undefined

  return (
    <div className="flex w-64 max-w-full flex-col gap-1.5 rounded-lg border bg-background/90 p-2.5 text-xs shadow-sm backdrop-blur">
      <div className="flex items-center gap-2">
        <span className="font-medium">{LAYER_LABELS[layer]}</span>
        {loading && <Spinner />}
        {grid && <span className="ms-auto truncate text-muted-foreground">{grid.unit}</span>}
      </div>
      <div
        aria-hidden
        className="h-2 rounded-full"
        style={{ backgroundImage: `linear-gradient(to right, ${PALETTE_CSS.join(", ")})` }}
      />
      <div className="flex justify-between tabular-nums text-muted-foreground">
        <span>{range ? formatLayerValue(range.min) : "-"}</span>
        <span>{range ? formatLayerValue(range.max) : "-"}</span>
      </div>
      <div className="font-mono tabular-nums text-muted-foreground" aria-live="off" data-testid="pointer-readout">
        {hover
          ? `x ${Math.round(hover.x)} · z ${Math.round(hover.z)}${
              hoverValue !== undefined ? ` · ${formatLayerValue(hoverValue)}` : ""
            }`
          : "Point at the map for coordinates"}
      </div>
    </div>
  )
}
