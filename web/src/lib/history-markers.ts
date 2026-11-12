import type { HistoryEntry } from "@/lib/bridge-types"
import type { WorldPoint } from "@/lib/world"

export type MarkerShape =
  | { kind: "point"; at: WorldPoint }
  | { kind: "segment"; from: WorldPoint; to: WorldPoint }

export interface HistoryMarker {
  entryId: number
  path: string
  ok: boolean
  shape: MarkerShape
}

/** Most markers drawn on the map. */
export const MAX_MARKERS = 50

function numberParam(query: Record<string, string>, name: string) {
  const raw = query[name]
  if (raw === undefined || raw.trim() === "") return undefined
  const value = Number(raw)
  return Number.isFinite(value) ? value : undefined
}

function pointFrom(query: Record<string, string>, xName: string, zName: string) {
  const x = numberParam(query, xName)
  const z = numberParam(query, zName)
  return x !== undefined && z !== undefined ? { x, z } : undefined
}

/**
 * Where a change happened, from its request parameters: x/z, then x1/z1 to x2/z2 (a road or an
 * area), then cx/cz (a centre). Undefined when the request carries no position.
 */
export function markerShapeFor(entry: HistoryEntry): MarkerShape | undefined {
  const query = entry.query ?? {}
  const point = pointFrom(query, "x", "z")
  if (point) return { kind: "point", at: point }
  const from = pointFrom(query, "x1", "z1")
  const to = pointFrom(query, "x2", "z2")
  if (from && to) return { kind: "segment", from, to }
  if (from) return { kind: "point", at: from }
  const centre = pointFrom(query, "cx", "cz")
  if (centre) return { kind: "point", at: centre }
  return undefined
}

export function markerCentre(shape: MarkerShape): WorldPoint {
  return shape.kind === "point"
    ? shape.at
    : { x: (shape.from.x + shape.to.x) / 2, z: (shape.from.z + shape.to.z) / 2 }
}

/** Markers for the newest entries that have a position (entries arrive newest first). */
export function historyMarkers(entries: readonly HistoryEntry[], limit = MAX_MARKERS) {
  const markers: HistoryMarker[] = []
  for (const entry of entries) {
    if (markers.length >= limit) break
    const shape = markerShapeFor(entry)
    if (shape) markers.push({ entryId: entry.id, path: entry.path, ok: entry.ok, shape })
  }
  return markers
}
