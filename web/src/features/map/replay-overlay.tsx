import { useEffect, useRef } from "react"

import { MAP_COLOURS } from "@/features/map/draw"
import { useThemeVersion } from "@/hooks/use-theme-version"
import type { ReplayMarker } from "@/lib/replay"
import { worldToScreen, type MapView, type Size } from "@/lib/world"

/** The current step: white with a dark casing, which reads on the dark and the bright end of the heatmap. */
const CURRENT = "#ffffff"

function drawReplay(
  ctx: CanvasRenderingContext2D,
  markers: readonly ReplayMarker[],
  current: number,
  view: MapView,
  size: Size
) {
  const at = (point: { x: number; z: number }) => worldToScreen(point, view, size)
  ctx.lineCap = "round"
  ctx.lineJoin = "round"

  // The route the AI took: a thin dashed line from marker to marker, up to the current step.
  const walked = markers.filter((marker) => marker.step <= current)
  if (walked.length > 1) {
    ctx.save()
    ctx.setLineDash([3, 5])
    ctx.lineWidth = 1.5
    ctx.strokeStyle = "rgba(248, 250, 252, 0.8)"
    ctx.beginPath()
    walked.forEach((marker, i) => {
      const p = at(marker.centre)
      if (i === 0) ctx.moveTo(p.x, p.y)
      else ctx.lineTo(p.x, p.y)
    })
    ctx.stroke()
    ctx.restore()
  }

  // Later steps first, so the current one ends up on top.
  for (const marker of [...markers].sort((a, b) => Math.abs(b.step - current) - Math.abs(a.step - current))) {
    const isCurrent = marker.step === current
    const colour = isCurrent ? CURRENT : marker.ok ? MAP_COLOURS.markerOk : MAP_COLOURS.markerFailed
    const upcoming = marker.step > current

    for (const shape of marker.shapes) {
      ctx.strokeStyle = MAP_COLOURS.casing
      ctx.fillStyle = colour
      if (shape.kind === "segment") {
        const from = at(shape.from)
        const to = at(shape.to)
        ctx.lineWidth = isCurrent ? 8 : 5
        ctx.setLineDash(upcoming ? [8, 5] : [])
        ctx.beginPath()
        ctx.moveTo(from.x, from.y)
        ctx.lineTo(to.x, to.y)
        ctx.stroke()
        ctx.strokeStyle = colour
        ctx.lineWidth = isCurrent ? 5 : 2.5
        ctx.stroke()
        ctx.setLineDash([])
      }
    }

    // The badge sits at the step's centre and carries the step's number.
    const p = at(marker.centre)
    const radius = isCurrent ? 13 : upcoming ? 8 : 10
    ctx.lineWidth = 2
    ctx.strokeStyle = MAP_COLOURS.casing
    ctx.fillStyle = colour
    ctx.beginPath()
    ctx.arc(p.x, p.y, radius, 0, Math.PI * 2)
    ctx.fill()
    ctx.stroke()
    ctx.fillStyle = "#0b1020"
    ctx.font = `700 ${isCurrent ? 13 : 10}px ui-sans-serif, system-ui, sans-serif`
    ctx.textAlign = "center"
    ctx.textBaseline = "middle"
    ctx.fillText(String(marker.step), p.x, p.y + 0.5)

    if (isCurrent) {
      // A ring in the result's colour (done / failed) around the current step's badge.
      ctx.beginPath()
      ctx.arc(p.x, p.y, 19, 0, Math.PI * 2)
      ctx.lineWidth = 6
      ctx.strokeStyle = MAP_COLOURS.casing
      ctx.stroke()
      ctx.lineWidth = 3
      ctx.strokeStyle = marker.ok ? MAP_COLOURS.markerOk : MAP_COLOURS.markerFailed
      ctx.stroke()
    }
  }
}

/**
 * A transparent canvas above the map that draws one session's steps as numbered markers.
 * It is separate from the map canvas on purpose: the map stays untouched and keeps its input.
 */
export function ReplayOverlay({
  markers,
  current,
  view,
  size,
}: {
  markers: readonly ReplayMarker[]
  current: number
  view: MapView
  size: Size | undefined
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const themeVersion = useThemeVersion()

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !size || size.width === 0 || size.height === 0) return
    const dpr = window.devicePixelRatio || 1
    canvas.width = Math.round(size.width * dpr)
    canvas.height = Math.round(size.height * dpr)
    const ctx = canvas.getContext("2d")
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    drawReplay(ctx, markers, current, view, size)
  }, [markers, current, view, size, themeVersion])

  return (
    <canvas
      ref={canvasRef}
      data-testid="replay-overlay"
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 block size-full"
    />
  )
}
