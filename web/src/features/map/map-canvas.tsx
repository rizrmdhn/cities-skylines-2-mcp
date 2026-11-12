import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react"

import { useThemeVersion } from "@/hooks/use-theme-version"
import type { Camera, GridMap } from "@/lib/bridge-types"
import type { RoadNetwork } from "@/features/map/use-roads"
import { drawMap, readThemeColours } from "@/features/map/draw"
import { heatmapPixels, valueRange } from "@/lib/heatmap"
import type { HistoryMarker } from "@/lib/history-markers"
import type { Selection, SelectionMode } from "@/lib/selection"
import {
  panBy,
  screenToWorld,
  zoomAt,
  type MapView,
  type ScreenPoint,
  type Size,
  type WorldPoint,
} from "@/lib/world"

/** Pixels the pointer may move before a press counts as a drag, not a click. */
const CLICK_SLOP = 4

interface Drag {
  pointerId: number
  start: ScreenPoint
  last: ScreenPoint
  action: "pan" | "draw"
  button: number
  moved: boolean
}

export interface MapCanvasProps {
  view: MapView
  size: Size | undefined
  grid: GridMap | undefined
  roads: RoadNetwork | undefined
  markers: readonly HistoryMarker[]
  camera: Camera | undefined
  selection: Selection | undefined
  mode: SelectionMode
  onViewChange: (view: MapView) => void
  onSelect: (selection: Selection) => void
  onHover: (point: WorldPoint | undefined) => void
}

export function createHeatmap(grid: GridMap): HTMLCanvasElement | null {
  if (grid.textureSize <= 0) return null
  const canvas = document.createElement("canvas")
  canvas.width = grid.textureSize
  canvas.height = grid.textureSize
  const ctx = canvas.getContext("2d")
  if (!ctx) return null
  const pixels = heatmapPixels(grid, valueRange(grid.values))
  ctx.putImageData(new ImageData(pixels, grid.textureSize, grid.textureSize), 0, 0)
  return canvas
}

export function MapCanvas({
  view,
  size,
  grid,
  roads,
  markers,
  camera,
  selection,
  mode,
  onViewChange,
  onSelect,
  onHover,
}: MapCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const dragRef = useRef<Drag | null>(null)
  const [draft, setDraft] = useState<Selection>()
  const themeVersion = useThemeVersion()
  const heatmap = useMemo(() => (grid ? createHeatmap(grid) : null), [grid])

  // Latest props for the native wheel listener, which is attached once.
  const latest = useRef({ view, onViewChange })
  useEffect(() => {
    latest.current = { view, onViewChange }
  })

  /** Pointer position in canvas pixels, plus the canvas size it was measured against. */
  const locate = (clientX: number, clientY: number) => {
    const rect = canvasRef.current!.getBoundingClientRect()
    return {
      point: { x: clientX - rect.left, y: clientY - rect.top },
      size: { width: rect.width, height: rect.height },
    }
  }

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !size || size.width === 0 || size.height === 0) return
    const dpr = window.devicePixelRatio || 1
    canvas.width = Math.round(size.width * dpr)
    canvas.height = Math.round(size.height * dpr)
    const ctx = canvas.getContext("2d")
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    drawMap(ctx, {
      view,
      size,
      heatmap,
      roads,
      markers,
      camera,
      selection,
      draft,
      theme: readThemeColours(),
    })
  }, [view, size, heatmap, roads, markers, camera, selection, draft, themeVersion])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      const { point, size: measured } = locate(event.clientX, event.clientY)
      const lines = event.deltaMode === 1 ? 16 : 1
      const delta = Math.max(-0.75, Math.min(0.75, (-event.deltaY * lines) / 300))
      latest.current.onViewChange(zoomAt(latest.current.view, measured, point, delta))
    }
    canvas.addEventListener("wheel", onWheel, { passive: false })
    return () => canvas.removeEventListener("wheel", onWheel)
  }, [])

  const handlePointerDown = (event: PointerEvent<HTMLCanvasElement>) => {
    const { point } = locate(event.clientX, event.clientY)
    const pan = event.button !== 0 || mode === "point" || event.shiftKey
    dragRef.current = {
      pointerId: event.pointerId,
      start: point,
      last: point,
      action: pan ? "pan" : "draw",
      button: event.button,
      moved: false,
    }
    event.currentTarget.setPointerCapture?.(event.pointerId)
  }

  const handlePointerMove = (event: PointerEvent<HTMLCanvasElement>) => {
    const { point, size: measured } = locate(event.clientX, event.clientY)
    onHover(screenToWorld(point, view, measured))
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    if (!drag.moved && Math.hypot(point.x - drag.start.x, point.y - drag.start.y) > CLICK_SLOP) {
      drag.moved = true
    }
    if (!drag.moved) return
    if (drag.action === "pan") {
      onViewChange(panBy(view, measured, point.x - drag.last.x, point.y - drag.last.y))
    } else {
      setDraft({
        kind: mode === "box" ? "box" : "line",
        from: screenToWorld(drag.start, view, measured),
        to: screenToWorld(point, view, measured),
      })
    }
    drag.last = point
  }

  const handlePointerUp = (event: PointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current
    dragRef.current = null
    if (!drag || drag.pointerId !== event.pointerId) return
    const { point, size: measured } = locate(event.clientX, event.clientY)
    if (!drag.moved && drag.button === 0) {
      onSelect({ kind: "point", at: screenToWorld(point, view, measured) })
    } else if (drag.moved && drag.action === "draw") {
      onSelect({
        kind: mode === "box" ? "box" : "line",
        from: screenToWorld(drag.start, view, measured),
        to: screenToWorld(point, view, measured),
      })
    }
    setDraft(undefined)
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLCanvasElement>) => {
    if (!size) return
    const step = 80
    const centre = { x: size.width / 2, y: size.height / 2 }
    const next: Record<string, () => MapView> = {
      ArrowLeft: () => panBy(view, size, step, 0),
      ArrowRight: () => panBy(view, size, -step, 0),
      ArrowUp: () => panBy(view, size, 0, step),
      ArrowDown: () => panBy(view, size, 0, -step),
      "+": () => zoomAt(view, size, centre, 0.5),
      "=": () => zoomAt(view, size, centre, 0.5),
      "-": () => zoomAt(view, size, centre, -0.5),
    }
    const action = next[event.key]
    if (action) {
      event.preventDefault()
      onViewChange(action())
    } else if (event.key === "Escape") {
      dragRef.current = null
      setDraft(undefined)
    }
  }

  return (
    <canvas
      ref={canvasRef}
      data-testid="city-map"
      tabIndex={0}
      aria-label="City map. Drag to move, scroll to zoom, click to pick a point. Arrow keys move, plus and minus zoom."
      className="block size-full cursor-crosshair touch-none outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={() => {
        dragRef.current = null
        setDraft(undefined)
      }}
      onPointerLeave={() => onHover(undefined)}
      onContextMenu={(event) => event.preventDefault()}
      onKeyDown={handleKeyDown}
    />
  )
}
