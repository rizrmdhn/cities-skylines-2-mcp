import type { GridMap } from "@/lib/bridge-types"
import type { WorldPoint } from "@/lib/world"

/** Viridis: perceptually even and readable with colour-vision deficiency. Low -> high. */
const PALETTE: readonly [number, number, number][] = [
  [68, 1, 84],
  [72, 40, 120],
  [62, 74, 137],
  [49, 104, 142],
  [38, 130, 142],
  [31, 158, 137],
  [53, 183, 121],
  [109, 205, 89],
  [180, 222, 44],
  [253, 231, 37],
]

export const PALETTE_CSS = PALETTE.map(([r, g, b]) => `rgb(${r} ${g} ${b})`)

export interface ValueRange {
  min: number
  max: number
}

/** 2nd to 98th percentile, so a few extreme cells do not flatten the rest of the map. */
export function valueRange(values: readonly number[]): ValueRange {
  if (values.length === 0) return { min: 0, max: 0 }
  const sorted = Float64Array.from(values).sort()
  const at = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1)))]
  return { min: at(0.02), max: at(0.98) }
}

export function colourFor(value: number, range: ValueRange): [number, number, number] {
  const span = range.max - range.min
  const t = span > 0 ? Math.min(1, Math.max(0, (value - range.min) / span)) : 0
  const scaled = t * (PALETTE.length - 1)
  const i = Math.min(PALETTE.length - 2, Math.floor(scaled))
  const f = scaled - i
  const a = PALETTE[i]
  const b = PALETTE[i + 1]
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f]
}

/**
 * RGBA pixels, textureSize x textureSize, top row = highest z (the map draws +z up; the grid's
 * row 0 is the lowest z).
 */
export function heatmapPixels(grid: GridMap, range: ValueRange): Uint8ClampedArray<ArrayBuffer> {
  const size = grid.textureSize
  const pixels = new Uint8ClampedArray(new ArrayBuffer(size * size * 4))
  for (let row = 0; row < size; row++) {
    const y = size - 1 - row
    for (let col = 0; col < size; col++) {
      const [r, g, b] = colourFor(grid.values[row * size + col] ?? 0, range)
      const o = (y * size + col) * 4
      pixels[o] = r
      pixels[o + 1] = g
      pixels[o + 2] = b
      pixels[o + 3] = 255
    }
  }
  return pixels
}

/** The grid value of the cell under a world point, or undefined outside the grid. */
export function valueAt(grid: GridMap, point: WorldPoint): number | undefined {
  const col = Math.floor((point.x - grid.worldMin) / grid.cellSize)
  const row = Math.floor((point.z - grid.worldMin) / grid.cellSize)
  if (col < 0 || row < 0 || col >= grid.textureSize || row >= grid.textureSize) return undefined
  return grid.values[row * grid.textureSize + col]
}
