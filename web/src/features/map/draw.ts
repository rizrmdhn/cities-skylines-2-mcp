import type { Camera } from "@/lib/bridge-types"
import type { RoadNetwork } from "@/features/map/use-roads"
import type { HistoryMarker } from "@/lib/history-markers"
import type { Selection } from "@/lib/selection"
import {
  scaleFor,
  WORLD_HALF,
  worldToScreen,
  type MapView,
  type Size,
  type WorldPoint,
} from "@/lib/world"

/**
 * Fixed map hues: they sit on top of the viridis heatmap, so they are picked to stay readable
 * on it in both themes (each line also gets a dark casing).
 */
export const MAP_COLOURS = {
  roadFree: "#f8fafc",
  roadSlow: "#fbbf24",
  roadJammed: "#ef4444",
  roadOther: "#94a3b8",
  casing: "rgba(10, 12, 20, 0.75)",
  markerOk: "#22d3ee",
  markerFailed: "#f43f5e",
  camera: "#e879f9",
  selection: "#ffffff",
}

export interface ThemeColours {
  background: string
  muted: string
  border: string
}

export function readThemeColours(): ThemeColours {
  const style = getComputedStyle(document.documentElement)
  const read = (name: string, fallback: string) =>
    style.getPropertyValue(name).trim() || fallback
  return {
    background: read("--background", "#ffffff"),
    muted: read("--muted", "#f4f4f5"),
    border: read("--border", "#e4e4e7"),
  }
}

export interface MapScene {
  view: MapView
  size: Size
  heatmap: CanvasImageSource | null
  roads: RoadNetwork | undefined
  markers: readonly HistoryMarker[]
  camera: Camera | undefined
  selection: Selection | undefined
  draft: Selection | undefined
  theme: ThemeColours
}

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value))

function line(ctx: CanvasRenderingContext2D, a: WorldPoint, b: WorldPoint, scene: MapScene) {
  const p = worldToScreen(a, scene.view, scene.size)
  const q = worldToScreen(b, scene.view, scene.size)
  ctx.beginPath()
  ctx.moveTo(p.x, p.y)
  ctx.lineTo(q.x, q.y)
  ctx.stroke()
}

function dot(ctx: CanvasRenderingContext2D, at: WorldPoint, radius: number, scene: MapScene) {
  const p = worldToScreen(at, scene.view, scene.size)
  ctx.beginPath()
  ctx.arc(p.x, p.y, radius, 0, Math.PI * 2)
  ctx.fill()
  ctx.stroke()
}

const ROAD_COLOURS = [
  MAP_COLOURS.roadOther,
  MAP_COLOURS.roadJammed,
  MAP_COLOURS.roadSlow,
  MAP_COLOURS.roadFree,
] as const

/** Index into ROAD_COLOURS: not a road, jammed (< 45%), slow (< 75%), flowing. */
function roadColourIndex(flow: number | null) {
  if (flow === null) return 0
  if (flow >= 75) return 3
  if (flow >= 45) return 2
  return 1
}

function drawRoads(ctx: CanvasRenderingContext2D, scene: MapScene, roads: RoadNetwork) {
  const { view, size } = scene
  const scale = scaleFor(view, size)
  const sx = (x: number) => size.width / 2 + (x - view.cx) * scale
  const sy = (z: number) => size.height / 2 - (z - view.cz) * scale
  const margin = 20

  // One path per colour: a few strokes for the whole city instead of one per segment.
  const paths = ROAD_COLOURS.map(() => new Path2D())
  const all = new Path2D()
  for (const road of roads.roads) {
    const ax = sx(road.sx), ay = sy(road.sz)
    const mx = sx(road.mx), my = sy(road.mz)
    const bx = sx(road.ex), by = sy(road.ez)
    if (
      Math.max(ax, mx, bx) < -margin || Math.min(ax, mx, bx) > size.width + margin ||
      Math.max(ay, my, by) < -margin || Math.min(ay, my, by) > size.height + margin
    ) {
      continue
    }
    // Quadratic curve through the segment's midpoint: control = 2 * middle - (start + end) / 2.
    const cx = 2 * mx - (ax + bx) / 2
    const cy = 2 * my - (ay + by) / 2
    for (const path of [paths[roadColourIndex(road.flow)], all]) {
      path.moveTo(ax, ay)
      path.quadraticCurveTo(cx, cy, bx, by)
    }
  }

  // Zoomed out the city is a fine web of lines; zoomed in, roads get their width and a casing.
  const width = clamp(scale * 8, 0.75, 7)
  ctx.lineCap = "round"
  ctx.lineJoin = "round"
  if (width >= 1.5) {
    ctx.strokeStyle = MAP_COLOURS.casing
    ctx.lineWidth = width + 2.5
    ctx.stroke(all)
  }
  ctx.lineWidth = width
  ROAD_COLOURS.forEach((colour, i) => {
    ctx.strokeStyle = colour
    ctx.stroke(paths[i])
  })

  if (scale < 0.35) return
  ctx.lineWidth = 1.5
  ctx.strokeStyle = MAP_COLOURS.casing
  for (const junction of roads.junctions) {
    const at = { x: junction.x, z: junction.z }
    if (junction.trafficLights) {
      ctx.fillStyle = MAP_COLOURS.roadSlow
      dot(ctx, at, 3.5, scene)
    } else if (junction.roundabout) {
      ctx.fillStyle = MAP_COLOURS.roadFree
      dot(ctx, at, 4.5, scene)
    } else if (junction.outsideConnection) {
      const p = worldToScreen(at, scene.view, scene.size)
      ctx.fillStyle = MAP_COLOURS.camera
      ctx.beginPath()
      ctx.moveTo(p.x, p.y - 6)
      ctx.lineTo(p.x + 6, p.y)
      ctx.lineTo(p.x, p.y + 6)
      ctx.lineTo(p.x - 6, p.y)
      ctx.closePath()
      ctx.fill()
      ctx.stroke()
    }
  }
}

function drawMarkers(ctx: CanvasRenderingContext2D, scene: MapScene) {
  ctx.lineWidth = 1.5
  // oldest first so the newest ends up on top
  for (const marker of [...scene.markers].reverse()) {
    const colour = marker.ok ? MAP_COLOURS.markerOk : MAP_COLOURS.markerFailed
    ctx.fillStyle = colour
    ctx.strokeStyle = MAP_COLOURS.casing
    if (marker.shape.kind === "point") {
      dot(ctx, marker.shape.at, 5, scene)
    } else {
      ctx.save()
      ctx.setLineDash([6, 4])
      ctx.lineWidth = 2.5
      ctx.strokeStyle = colour
      line(ctx, marker.shape.from, marker.shape.to, scene)
      ctx.restore()
      dot(ctx, marker.shape.from, 3.5, scene)
      dot(ctx, marker.shape.to, 3.5, scene)
    }
  }
}

function drawCamera(ctx: CanvasRenderingContext2D, scene: MapScene, camera: Camera) {
  const p = worldToScreen(camera.pivot, scene.view, scene.size)
  // angle.x is the compass heading in degrees; 0 looks along +z (up on the map)
  const heading = (camera.angle.x * Math.PI) / 180
  const dx = Math.sin(heading)
  const dy = -Math.cos(heading)
  const tip = { x: p.x + dx * 26, y: p.y + dy * 26 }

  ctx.lineCap = "round"
  ctx.strokeStyle = MAP_COLOURS.casing
  ctx.lineWidth = 5
  ctx.beginPath()
  ctx.moveTo(p.x, p.y)
  ctx.lineTo(tip.x, tip.y)
  ctx.stroke()
  ctx.strokeStyle = MAP_COLOURS.camera
  ctx.lineWidth = 2.5
  ctx.stroke()

  ctx.fillStyle = MAP_COLOURS.camera
  ctx.beginPath()
  ctx.moveTo(tip.x + dx * 6, tip.y + dy * 6)
  ctx.lineTo(tip.x - dy * 5, tip.y + dx * 5)
  ctx.lineTo(tip.x + dy * 5, tip.y - dx * 5)
  ctx.closePath()
  ctx.fill()

  ctx.strokeStyle = MAP_COLOURS.casing
  ctx.lineWidth = 2
  ctx.beginPath()
  ctx.arc(p.x, p.y, 6, 0, Math.PI * 2)
  ctx.fill()
  ctx.stroke()
}

function drawSelection(
  ctx: CanvasRenderingContext2D,
  scene: MapScene,
  selection: Selection,
  draft: boolean
) {
  ctx.save()
  if (draft) ctx.setLineDash([5, 4])
  const strokeTwice = (path: () => void) => {
    ctx.strokeStyle = MAP_COLOURS.casing
    ctx.lineWidth = 4
    path()
    ctx.stroke()
    ctx.strokeStyle = MAP_COLOURS.selection
    ctx.lineWidth = 2
    ctx.stroke()
  }

  if (selection.kind === "point") {
    const p = worldToScreen(selection.at, scene.view, scene.size)
    strokeTwice(() => {
      ctx.beginPath()
      ctx.arc(p.x, p.y, 8, 0, Math.PI * 2)
    })
    ctx.fillStyle = MAP_COLOURS.selection
    ctx.beginPath()
    ctx.arc(p.x, p.y, 2.5, 0, Math.PI * 2)
    ctx.fill()
  } else if (selection.kind === "box") {
    const a = worldToScreen(selection.from, scene.view, scene.size)
    const b = worldToScreen(selection.to, scene.view, scene.size)
    const x = Math.min(a.x, b.x)
    const y = Math.min(a.y, b.y)
    const w = Math.abs(a.x - b.x)
    const h = Math.abs(a.y - b.y)
    ctx.fillStyle = "rgba(255, 255, 255, 0.18)"
    ctx.fillRect(x, y, w, h)
    strokeTwice(() => {
      ctx.beginPath()
      ctx.rect(x, y, w, h)
    })
  } else {
    const a = worldToScreen(selection.from, scene.view, scene.size)
    const b = worldToScreen(selection.to, scene.view, scene.size)
    strokeTwice(() => {
      ctx.beginPath()
      ctx.moveTo(a.x, a.y)
      ctx.lineTo(b.x, b.y)
    })
    ctx.fillStyle = MAP_COLOURS.selection
    for (const p of [a, b]) {
      ctx.beginPath()
      ctx.arc(p.x, p.y, 4, 0, Math.PI * 2)
      ctx.fill()
    }
  }
  ctx.restore()
}

/** Draws the whole map; `ctx` is already scaled for the device pixel ratio. */
export function drawMap(ctx: CanvasRenderingContext2D, scene: MapScene) {
  const { size, view, theme } = scene
  ctx.clearRect(0, 0, size.width, size.height)
  ctx.fillStyle = theme.background
  ctx.fillRect(0, 0, size.width, size.height)

  const topLeft = worldToScreen({ x: -WORLD_HALF, z: WORLD_HALF }, view, size)
  const bottomRight = worldToScreen({ x: WORLD_HALF, z: -WORLD_HALF }, view, size)
  const worldWidth = bottomRight.x - topLeft.x
  const worldHeight = bottomRight.y - topLeft.y

  if (scene.heatmap) {
    ctx.imageSmoothingEnabled = view.zoom < 4
    ctx.drawImage(scene.heatmap, topLeft.x, topLeft.y, worldWidth, worldHeight)
  } else {
    ctx.fillStyle = theme.muted
    ctx.fillRect(topLeft.x, topLeft.y, worldWidth, worldHeight)
  }

  // 1 km grid once it is useful for judging distance
  const scale = scaleFor(view, size)
  if (scale * 1000 >= 60) {
    ctx.strokeStyle = "rgba(255, 255, 255, 0.12)"
    ctx.lineWidth = 1
    ctx.beginPath()
    for (let k = -7; k <= 7; k++) {
      const v = worldToScreen({ x: k * 1000, z: k * 1000 }, view, size)
      ctx.moveTo(v.x, topLeft.y)
      ctx.lineTo(v.x, bottomRight.y)
      ctx.moveTo(topLeft.x, v.y)
      ctx.lineTo(bottomRight.x, v.y)
    }
    ctx.stroke()
  }

  ctx.strokeStyle = theme.border
  ctx.lineWidth = 1
  ctx.strokeRect(topLeft.x, topLeft.y, worldWidth, worldHeight)

  if (scene.roads) drawRoads(ctx, scene, scene.roads)
  if (scene.markers.length > 0) drawMarkers(ctx, scene)
  if (scene.camera) drawCamera(ctx, scene, scene.camera)
  if (scene.selection) drawSelection(ctx, scene, scene.selection, false)
  if (scene.draft) drawSelection(ctx, scene, scene.draft, true)
}
