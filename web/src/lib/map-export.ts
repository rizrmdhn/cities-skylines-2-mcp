/**
 * Geometry of a PNG export of the 2D map: which world area goes into the image, its size in
 * pixels at each scale, the caption strip's layout, the scale bar, the canvas-size guard and the
 * file name. Pure (no DOM), so every number here is unit-tested; features/map/export-image.ts
 * does the drawing.
 */
import type { HistoryMarker } from "@/lib/history-markers"
import { scaleFor, WORLD_HALF, WORLD_SIZE, type MapView, type Size } from "@/lib/world"

export const EXPORT_SCALES = [1, 2, 4] as const
export type ExportScale = (typeof EXPORT_SCALES)[number]

/** view = what the map shows now; city = everything built (roads, AI changes); map = the whole playable square. */
export const EXPORT_AREAS = ["view", "city", "map"] as const
export type ExportArea = (typeof EXPORT_AREAS)[number]

/** light/dark: map background and caption strip in that scheme; transparent: no strip, no background. */
export const EXPORT_BACKGROUNDS = ["light", "dark", "transparent"] as const
export type ExportBackground = (typeof EXPORT_BACKGROUNDS)[number]

/**
 * Chromium allows 32,767 px per side and 268 megapixels, but a canvas that large needs 1 GB of
 * memory and other engines stop earlier (Safari: 16,777,216 px). Stay well inside both.
 */
export const MAX_EXPORT_SIDE = 16_384
export const MAX_EXPORT_PIXELS = 8_192 * 8_192

/** A world area and the map size (CSS pixels, before the export scale) it is drawn at. */
export interface ExportFrame {
  view: MapView
  size: Size
}

export interface WorldBounds {
  minX: number
  minZ: number
  maxX: number
  maxZ: number
}

/** The current view, as large as it is on screen. */
export function viewFrame(view: MapView, size: Size): ExportFrame {
  return { view: { ...view }, size: { width: Math.round(size.width), height: Math.round(size.height) } }
}

/** The whole world as a square as large as the shorter side of the on-screen map (zoom 0 on screen). */
export function wholeMapFrame(size: Size): ExportFrame {
  const side = Math.max(1, Math.round(Math.min(size.width, size.height)))
  return { view: { cx: 0, cz: 0, zoom: 0 }, size: { width: side, height: side } }
}

/** Smallest area drawn for the built-up area, so a single road does not fill the whole image. */
export const MIN_CITY_EXTENT = 1_000
/** Margin around the built-up area, as a share of its larger side. */
export const CITY_PADDING = 0.06

/** Bounding box of the roads and change markers, or undefined when there is nothing. */
export function cityBounds(
  roads: { roads: readonly { sx: number; sz: number; mx: number; mz: number; ex: number; ez: number }[] } | undefined,
  markers: readonly HistoryMarker[] = []
): WorldBounds | undefined {
  let minX = Infinity
  let minZ = Infinity
  let maxX = -Infinity
  let maxZ = -Infinity
  const add = (x: number, z: number) => {
    if (!Number.isFinite(x) || !Number.isFinite(z)) return
    minX = Math.min(minX, x)
    maxX = Math.max(maxX, x)
    minZ = Math.min(minZ, z)
    maxZ = Math.max(maxZ, z)
  }
  for (const road of roads?.roads ?? []) {
    add(road.sx, road.sz)
    add(road.mx, road.mz)
    add(road.ex, road.ez)
  }
  for (const marker of markers) {
    if (marker.shape.kind === "point") add(marker.shape.at.x, marker.shape.at.z)
    else {
      add(marker.shape.from.x, marker.shape.from.z)
      add(marker.shape.to.x, marker.shape.to.z)
    }
  }
  return Number.isFinite(minX) ? { minX, minZ, maxX, maxZ } : undefined
}

/**
 * `bounds` (padded, at least MIN_CITY_EXTENT on each side, inside the world) fitted into the
 * on-screen map size with its own aspect ratio.
 */
export function boundsFrame(bounds: WorldBounds, size: Size): ExportFrame {
  const pad = Math.max(bounds.maxX - bounds.minX, bounds.maxZ - bounds.minZ) * CITY_PADDING
  const grow = (min: number, max: number) => {
    const half = Math.max(MIN_CITY_EXTENT, max - min + 2 * pad) / 2
    const centre = (min + max) / 2
    const lo = Math.max(-WORLD_HALF, centre - half)
    const hi = Math.min(WORLD_HALF, centre + half)
    return { lo, hi }
  }
  const x = grow(bounds.minX, bounds.maxX)
  const z = grow(bounds.minZ, bounds.maxZ)
  const metresWide = x.hi - x.lo
  const metresHigh = z.hi - z.lo
  const pxPerMetre = Math.min(size.width / metresWide, size.height / metresHigh)
  const out = {
    width: Math.max(1, Math.round(metresWide * pxPerMetre)),
    height: Math.max(1, Math.round(metresHigh * pxPerMetre)),
  }
  // scaleFor(view, out) === pxPerMetre
  const zoom = Math.log2((pxPerMetre * WORLD_SIZE) / Math.min(out.width, out.height))
  return { view: { cx: (x.lo + x.hi) / 2, cz: (z.lo + z.hi) / 2, zoom }, size: out }
}

/* ---------------------------------------------------------------- caption strip */

/** Caption strip metrics, in CSS pixels (multiplied by the export scale when drawn). */
export const CAPTION = {
  padding: 14,
  titleSize: 15,
  textSize: 11,
  /** Title line + subtitle line. */
  titleHeight: 36,
  /** Legend: label, gradient bar, min/max labels. */
  legendHeight: 40,
  legendWidth: 168,
  /** Longest scale bar; the label sits above it. */
  scaleBarWidth: 120,
  gap: 24,
  rowGap: 12,
  /** The title block gets at least this much room before the strip goes to two rows. */
  minTitleWidth: 180,
}

export interface Box {
  x: number
  y: number
  width: number
  height: number
}

export interface CaptionLayout {
  height: number
  /** True when the legend and scale bar go below the title instead of beside it. */
  stacked: boolean
  title: Box
  legend: Box
  scaleBar: Box | null
}

/** Where the caption's parts go in a strip `width` px wide (positions relative to the strip). */
export function captionLayout(width: number, { scaleBar }: { scaleBar: boolean }): CaptionLayout {
  const c = CAPTION
  const inner = Math.max(0, width - 2 * c.padding)
  const legendWidth = Math.min(c.legendWidth, inner)
  const barWidth = scaleBar ? c.scaleBarWidth : 0
  const rightWidth = legendWidth + (scaleBar ? c.gap + barWidth : 0)

  if (inner >= c.minTitleWidth + c.gap + rightWidth) {
    // one row: title on the left, legend and scale bar on the right
    const rowHeight = Math.max(c.titleHeight, c.legendHeight)
    const legendX = c.padding + inner - rightWidth
    return {
      height: rowHeight + 2 * c.padding,
      stacked: false,
      title: { x: c.padding, y: c.padding, width: inner - rightWidth - c.gap, height: c.titleHeight },
      legend: { x: legendX, y: c.padding, width: legendWidth, height: c.legendHeight },
      scaleBar: scaleBar
        ? { x: legendX + legendWidth + c.gap, y: c.padding, width: barWidth, height: c.legendHeight }
        : null,
    }
  }

  // stacked: title, then legend (+ scale bar beside it when it fits, else on its own row)
  const legendY = c.padding + c.titleHeight + c.rowGap
  const barBeside = scaleBar && inner >= rightWidth
  const barY = barBeside ? legendY : legendY + c.legendHeight + c.rowGap
  const bottom = scaleBar ? barY + c.legendHeight : legendY + c.legendHeight
  return {
    height: bottom + c.padding,
    stacked: true,
    title: { x: c.padding, y: c.padding, width: inner, height: c.titleHeight },
    legend: { x: c.padding, y: legendY, width: legendWidth, height: c.legendHeight },
    scaleBar: scaleBar
      ? {
          x: barBeside ? c.padding + legendWidth + c.gap : c.padding,
          y: barY,
          width: Math.min(barWidth, inner),
          height: c.legendHeight,
        }
      : null,
  }
}

export interface ScaleBar {
  metres: number
  /** Length in CSS pixels at the frame's scale. */
  width: number
  label: string
}

/** The longest 1-2-5 distance that fits in `maxWidth` px at `pxPerMetre`. */
export function scaleBarFor(pxPerMetre: number, maxWidth: number): ScaleBar | null {
  if (!(pxPerMetre > 0) || !Number.isFinite(pxPerMetre) || !(maxWidth > 0)) return null
  const maxMetres = maxWidth / pxPerMetre
  if (maxMetres < 1) return null
  const power = 10 ** Math.floor(Math.log10(maxMetres))
  const step = [5, 2, 1].find((s) => s * power <= maxMetres) ?? 1
  const metres = step * power
  return {
    metres,
    width: metres * pxPerMetre,
    label: metres >= 1000 ? `${metres / 1000} km` : `${metres} m`,
  }
}

/* ---------------------------------------------------------------- size plan and guard */

export interface ExportPlan {
  frame: ExportFrame
  scale: ExportScale
  /** Caption strip height in CSS pixels (0 without a strip). */
  captionHeight: number
  caption: CaptionLayout | null
  scaleBar: ScaleBar | null
  /** Map + strip in CSS pixels. */
  logical: Size
  /** The PNG's size. */
  pixels: Size
  /** Why this export cannot be drawn (too large), or undefined. */
  problem: string | undefined
}

const thousands = (n: number) => n.toLocaleString("en-US")

/** Undefined when a canvas of `pixels` can be drawn, else the reason. */
export function canvasSizeProblem(pixels: Size): string | undefined {
  if (pixels.width < 1 || pixels.height < 1) return "The map has no size yet."
  const tooLong = Math.max(pixels.width, pixels.height) > MAX_EXPORT_SIDE
  const tooMany = pixels.width * pixels.height > MAX_EXPORT_PIXELS
  if (!tooLong && !tooMany) return undefined
  return (
    `${thousands(pixels.width)} × ${thousands(pixels.height)} px is too large to draw ` +
    `(at most ${thousands(MAX_EXPORT_SIDE)} px per side and ` +
    `${Math.round(MAX_EXPORT_PIXELS / 1e6)} megapixels). Pick a smaller scale.`
  )
}

export function planExport({
  frame,
  scale,
  background,
}: {
  frame: ExportFrame
  scale: ExportScale
  background: ExportBackground
}): ExportPlan {
  const withCaption = background !== "transparent"
  const pxPerMetre = scaleFor(frame.view, frame.size)
  const scaleBar = withCaption ? scaleBarFor(pxPerMetre, CAPTION.scaleBarWidth) : null
  const caption = withCaption ? captionLayout(frame.size.width, { scaleBar: scaleBar !== null }) : null
  const captionHeight = caption?.height ?? 0
  const logical = { width: frame.size.width, height: frame.size.height + captionHeight }
  const pixels = { width: Math.round(logical.width * scale), height: Math.round(logical.height * scale) }
  return {
    frame,
    scale,
    captionHeight,
    caption,
    scaleBar,
    logical,
    pixels,
    problem: canvasSizeProblem(pixels),
  }
}

/* ---------------------------------------------------------------- file name */

const RESERVED_WINDOWS_NAMES = /^(con|prn|aux|nul|com\d|lpt\d)$/i

/** One part of a file name: no path or reserved characters, runs of separators collapsed. */
export function fileNamePart(text: string, maxLength = 60): string {
  const cleaned = text
    .normalize("NFC")
    // eslint-disable-next-line no-control-regex
    .replace(/[<>:"/\\|?*\u0000-\u001f\u007f]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-{2,}/g, "-")
  // by code point, so a long name is never cut inside a surrogate pair
  return Array.from(cleaned)
    .slice(0, maxLength)
    .join("")
    .replace(/^[-._]+|[-._ ]+$/g, "")
}

/** `<city>-<layer>-<game date>.png`, safe on Windows, macOS and Linux. */
export function exportFileName({
  city,
  layer,
  date,
  extension = "png",
}: {
  city: string | null | undefined
  layer: string
  date: string | null | undefined
  extension?: string
}): string {
  const parts = [
    fileNamePart(city ?? "") || "city",
    fileNamePart(layer.toLowerCase()) || "map",
    date ? fileNamePart(date) : "",
  ].filter(Boolean)
  let base = parts.join("-")
  if (RESERVED_WINDOWS_NAMES.test(base)) base = `_${base}`
  return `${base}.${extension}`
}
