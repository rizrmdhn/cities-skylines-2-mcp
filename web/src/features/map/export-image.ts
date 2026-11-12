/**
 * Draws a PNG export of the map. The map itself goes through the same `drawMap` as the screen,
 * under a canvas transform of `scale`, so a 4x export is re-rendered at 4x (sharp lines, real
 * heatmap pixels) and not an upscaled screenshot. Sizes and layout come from lib/map-export.ts.
 */
import { createHeatmap } from "@/features/map/map-canvas"
import { drawMap, type ThemeColours } from "@/features/map/draw"
import { formatLayerValue } from "@/features/map/layers"
import type { Camera, GridMap } from "@/lib/bridge-types"
import { PALETTE_CSS, valueRange } from "@/lib/heatmap"
import type { HistoryMarker } from "@/lib/history-markers"
import type { Box, ExportBackground, ExportPlan } from "@/lib/map-export"
import type { Selection } from "@/lib/selection"
import type { RoadNetwork } from "@/features/map/use-roads"

/** What the picture shows. */
export interface ExportContent {
  grid: GridMap | undefined
  roads: RoadNetwork | undefined
  markers: readonly HistoryMarker[]
  camera: Camera | undefined
  selection: Selection | undefined
}

/** Texts of the caption strip. */
export interface ExportCaption {
  city: string
  /** Game date, or null when the game did not say. */
  date: string | null
  layerLabel: string
}

interface Scheme {
  map: ThemeColours
  strip: string
  rule: string
  text: string
  muted: string
}

const LIGHT: Scheme = {
  map: { background: "#ffffff", muted: "#e4e4e7", border: "#a1a1aa" },
  strip: "#ffffff",
  rule: "#d4d4d8",
  text: "#18181b",
  muted: "#52525b",
}
const DARK: Scheme = {
  map: { background: "#09090b", muted: "#27272a", border: "#52525b" },
  strip: "#18181b",
  rule: "#3f3f46",
  text: "#fafafa",
  muted: "#a1a1aa",
}
/** No background: the map outside the world square stays see-through, and there is no strip. */
const TRANSPARENT_MAP: ThemeColours = { background: "transparent", muted: "#e4e4e7", border: "#a1a1aa" }

const FONT = 'ui-sans-serif, system-ui, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif'

/** Lets the browser paint (a "rendering" state) before the synchronous drawing blocks it. */
const nextTask = () => new Promise<void>((resolve) => setTimeout(resolve, 30))

function fit(ctx: CanvasRenderingContext2D, text: string, maxWidth: number) {
  if (ctx.measureText(text).width <= maxWidth) return text
  let end = text.length
  while (end > 1 && ctx.measureText(`${text.slice(0, end)}…`).width > maxWidth) end--
  return `${text.slice(0, end)}…`
}

function drawCaption(
  ctx: CanvasRenderingContext2D,
  plan: ExportPlan,
  scheme: Scheme,
  caption: ExportCaption,
  grid: GridMap | undefined
) {
  const layout = plan.caption
  if (!layout) return
  const top = plan.frame.size.height
  const width = plan.frame.size.width
  const place = (box: Box) => ({ x: box.x, y: top + box.y, width: box.width, height: box.height })

  ctx.fillStyle = scheme.strip
  ctx.fillRect(0, top, width, layout.height)
  ctx.fillStyle = scheme.rule
  ctx.fillRect(0, top, width, 1)
  ctx.textBaseline = "alphabetic"
  ctx.textAlign = "left"

  const title = place(layout.title)
  ctx.fillStyle = scheme.text
  ctx.font = `600 15px ${FONT}`
  ctx.fillText(fit(ctx, caption.city, title.width), title.x, title.y + 15)
  ctx.fillStyle = scheme.muted
  ctx.font = `11px ${FONT}`
  ctx.fillText(fit(ctx, caption.date ?? "Game date unknown", title.width), title.x, title.y + 32)

  const legend = place(layout.legend)
  ctx.fillStyle = scheme.text
  ctx.font = `600 11px ${FONT}`
  const unit = grid?.unit ?? ""
  const unitWidth = unit ? Math.min(legend.width / 2, ctx.measureText(unit).width) : 0
  ctx.fillText(fit(ctx, caption.layerLabel, legend.width - unitWidth - 8), legend.x, legend.y + 11)
  if (unit) {
    ctx.fillStyle = scheme.muted
    ctx.font = `11px ${FONT}`
    ctx.textAlign = "right"
    ctx.fillText(fit(ctx, unit, legend.width / 2), legend.x + legend.width, legend.y + 11)
    ctx.textAlign = "left"
  }
  const gradient = ctx.createLinearGradient(legend.x, 0, legend.x + legend.width, 0)
  PALETTE_CSS.forEach((colour, i) => gradient.addColorStop(i / (PALETTE_CSS.length - 1), colour))
  ctx.fillStyle = gradient
  ctx.beginPath()
  ctx.roundRect(legend.x, legend.y + 17, legend.width, 8, 4)
  ctx.fill()
  const range = grid ? valueRange(grid.values) : undefined
  ctx.fillStyle = scheme.muted
  ctx.font = `11px ${FONT}`
  ctx.fillText(range ? formatLayerValue(range.min) : "-", legend.x, legend.y + 38)
  ctx.textAlign = "right"
  ctx.fillText(range ? formatLayerValue(range.max) : "-", legend.x + legend.width, legend.y + 38)
  ctx.textAlign = "left"

  if (layout.scaleBar && plan.scaleBar) {
    const box = place(layout.scaleBar)
    const length = Math.min(plan.scaleBar.width, box.width)
    ctx.fillStyle = scheme.muted
    ctx.font = `11px ${FONT}`
    ctx.fillText(plan.scaleBar.label, box.x, box.y + 11)
    ctx.strokeStyle = scheme.text
    ctx.lineWidth = 2
    ctx.lineCap = "butt"
    ctx.beginPath()
    ctx.moveTo(box.x, box.y + 18)
    ctx.lineTo(box.x, box.y + 27)
    ctx.moveTo(box.x, box.y + 27)
    ctx.lineTo(box.x + length, box.y + 27)
    ctx.moveTo(box.x + length, box.y + 18)
    ctx.lineTo(box.x + length, box.y + 27)
    ctx.stroke()
  }
}

/**
 * The picture for `plan`. Throws an Error with a user-readable message when the browser cannot
 * make a canvas that large. `plan.problem` is checked again here so no caller can skip the guard.
 */
export async function renderMapExport({
  plan,
  content,
  caption,
  background,
  signal,
}: {
  plan: ExportPlan
  content: ExportContent
  caption: ExportCaption
  background: ExportBackground
  signal?: AbortSignal
}): Promise<HTMLCanvasElement> {
  if (plan.problem) throw new Error(plan.problem)
  await nextTask()
  signal?.throwIfAborted()

  const canvas = document.createElement("canvas")
  canvas.width = plan.pixels.width
  canvas.height = plan.pixels.height
  const ctx = canvas.getContext("2d")
  if (!ctx) {
    throw new Error(
      `The browser could not allocate a ${plan.pixels.width} × ${plan.pixels.height} px canvas. Pick a smaller scale.`
    )
  }
  const scheme = background === "dark" ? DARK : LIGHT
  ctx.scale(plan.scale, plan.scale)

  drawMap(ctx, {
    view: plan.frame.view,
    size: plan.frame.size,
    heatmap: content.grid ? createHeatmap(content.grid) : null,
    roads: content.roads,
    markers: content.markers,
    camera: content.camera,
    selection: content.selection,
    draft: undefined,
    theme: background === "transparent" ? TRANSPARENT_MAP : scheme.map,
  })
  drawCaption(ctx, plan, scheme, caption, content.grid)
  return canvas
}

export function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("The browser could not encode the image as PNG."))),
      "image/png"
    )
  })
}
