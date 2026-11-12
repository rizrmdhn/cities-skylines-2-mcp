/**
 * World <-> screen math for the 2D map. The playable world is a square from -7168 to 7168 m on
 * x and z. On screen +x points right and +z points up.
 */
export const WORLD_HALF = 7168
export const WORLD_SIZE = WORLD_HALF * 2
export const MIN_ZOOM = 0
export const MAX_ZOOM = 7
/** The bridge's road-graph radius limit. */
export const MAX_ROAD_RADIUS = 2000

export interface WorldPoint {
  x: number
  z: number
}

export interface ScreenPoint {
  x: number
  y: number
}

export interface Size {
  width: number
  height: number
}

/** cx/cz = world point at the centre of the canvas; zoom 0 fits the whole world. */
export interface MapView {
  cx: number
  cz: number
  zoom: number
}

export const DEFAULT_VIEW: MapView = { cx: 0, cz: 0, zoom: 0 }

/** Pixels per metre. */
export function scaleFor(view: MapView, size: Size) {
  return (Math.min(size.width, size.height) / WORLD_SIZE) * 2 ** view.zoom
}

export function worldToScreen(point: WorldPoint, view: MapView, size: Size): ScreenPoint {
  const scale = scaleFor(view, size)
  return {
    x: size.width / 2 + (point.x - view.cx) * scale,
    y: size.height / 2 - (point.z - view.cz) * scale,
  }
}

export function screenToWorld(point: ScreenPoint, view: MapView, size: Size): WorldPoint {
  const scale = scaleFor(view, size)
  return {
    x: view.cx + (point.x - size.width / 2) / scale,
    z: view.cz - (point.y - size.height / 2) / scale,
  }
}

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value))

export function clampView(view: MapView): MapView {
  return {
    cx: clamp(view.cx, -WORLD_HALF, WORLD_HALF),
    cz: clamp(view.cz, -WORLD_HALF, WORLD_HALF),
    zoom: clamp(view.zoom, MIN_ZOOM, MAX_ZOOM),
  }
}

/** Zoom by `delta` levels keeping the world point under `anchor` where it is. */
export function zoomAt(view: MapView, size: Size, anchor: ScreenPoint, delta: number): MapView {
  const zoom = clamp(view.zoom + delta, MIN_ZOOM, MAX_ZOOM)
  const before = screenToWorld(anchor, view, size)
  const scale = scaleFor({ ...view, zoom }, size)
  return clampView({
    zoom,
    cx: before.x - (anchor.x - size.width / 2) / scale,
    cz: before.z + (anchor.y - size.height / 2) / scale,
  })
}

/** Move the view so the content follows a drag of (dx, dy) pixels. */
export function panBy(view: MapView, size: Size, dx: number, dy: number): MapView {
  const scale = scaleFor(view, size)
  return clampView({ ...view, cx: view.cx - dx / scale, cz: view.cz + dy / scale })
}

/** Half the canvas diagonal in metres: everything visible is within this distance of the centre. */
export function visibleRadius(view: MapView, size: Size) {
  return Math.hypot(size.width, size.height) / 2 / scaleFor(view, size)
}

/**
 * Roads load per fixed tile so every tile is fetched once and then cached: 7 x 7 tiles of 2048 m
 * cover the world, and the circle around a tile (1449 m) stays inside the bridge's 2000 m limit.
 */
export const ROAD_TILE_SIZE = 2048
export const ROAD_TILES_PER_SIDE = WORLD_SIZE / ROAD_TILE_SIZE
/** Roads are drawn once the view is this close (half its diagonal, in metres). */
export const ROAD_VIEW_RADIUS = 3000

export interface RoadTile {
  tx: number
  tz: number
}

/** The road-graph request covering a tile: its centre and the radius of its circumscribed circle. */
export function tileArea(tile: RoadTile) {
  return {
    x: -WORLD_HALF + (tile.tx + 0.5) * ROAD_TILE_SIZE,
    z: -WORLD_HALF + (tile.tz + 0.5) * ROAD_TILE_SIZE,
    radius: Math.min(MAX_ROAD_RADIUS, Math.ceil((ROAD_TILE_SIZE / 2) * Math.SQRT2)),
  }
}

/** The tiles the view overlaps, or null while it is too far out to draw roads. */
export function roadTilesFor(view: MapView, size: Size): RoadTile[] | null {
  const radius = visibleRadius(view, size)
  if (!Number.isFinite(radius) || radius > ROAD_VIEW_RADIUS) return null
  const scale = scaleFor(view, size)
  const toTile = (metres: number) =>
    clamp(Math.floor((metres + WORLD_HALF) / ROAD_TILE_SIZE), 0, ROAD_TILES_PER_SIDE - 1)
  const halfWidth = size.width / 2 / scale
  const halfHeight = size.height / 2 / scale
  const tiles: RoadTile[] = []
  for (let tz = toTile(view.cz - halfHeight); tz <= toTile(view.cz + halfHeight); tz++) {
    for (let tx = toTile(view.cx - halfWidth); tx <= toTile(view.cx + halfWidth); tx++) {
      tiles.push({ tx, tz })
    }
  }
  return tiles
}

export function isInWorld(point: WorldPoint) {
  return Math.abs(point.x) <= WORLD_HALF && Math.abs(point.z) <= WORLD_HALF
}

export function roundPoint(point: WorldPoint): WorldPoint {
  return { x: Math.round(point.x), z: Math.round(point.z) }
}
