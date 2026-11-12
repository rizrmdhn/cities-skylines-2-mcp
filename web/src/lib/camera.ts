/**
 * What the map can say about the game camera from the /camera payload: where it is, which way it
 * looks and (approximately) which patch of ground it shows. Pure; features/map/draw.ts draws it.
 *
 * The payload has no field of view or window aspect ratio, so the footprint assumes the game's
 * defaults (ASSUMED_FOV vertical, 16:9). It is a guide to "roughly this area", not a measurement.
 */
import type { Camera } from "@/lib/bridge-types"
import type { WorldPoint } from "@/lib/world"

/** Vertical field of view of the gameplay camera, degrees (assumed). */
export const ASSUMED_FOV = 60
export const ASSUMED_ASPECT = 16 / 9
/** Rays that never reach the ground (above the horizon) are cut at this horizontal distance, metres. */
export const MAX_FOOTPRINT_REACH = 6000

const COMPASS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"] as const

/** Compass heading in degrees, 0 = north (+z, up on the map), clockwise, in [0, 360). */
export function cameraHeading(camera: Camera): number {
  const heading = camera.angle.x % 360
  return heading < 0 ? heading + 360 : heading
}

export function compassLabel(degrees: number): string {
  const normalised = ((degrees % 360) + 360) % 360
  return COMPASS[Math.round(normalised / 45) % 8]
}

/** The ground quadrilateral in view (near-left, near-right, far-right, far-left), or undefined when the camera is not above the ground. */
export function cameraFootprint(
  camera: Camera,
  { fov = ASSUMED_FOV, aspect = ASSUMED_ASPECT, reach = MAX_FOOTPRINT_REACH } = {}
): WorldPoint[] | undefined {
  const { position, pivot } = camera
  if (![position.x, position.y, position.z, pivot.y].every(Number.isFinite)) return undefined
  const groundY = pivot.y
  if (position.y - groundY < 1) return undefined

  const yaw = (camera.angle.x * Math.PI) / 180
  const pitch = (camera.angle.y * Math.PI) / 180
  const forward = [Math.sin(yaw) * Math.cos(pitch), -Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch)]
  const right = [Math.cos(yaw), 0, -Math.sin(yaw)]
  const up = [Math.sin(yaw) * Math.sin(pitch), Math.cos(pitch), Math.cos(yaw) * Math.sin(pitch)]
  const halfHeight = Math.tan((fov * Math.PI) / 360)
  const halfWidth = halfHeight * aspect

  const corners: [number, number][] = [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ]
  const points: WorldPoint[] = []
  for (const [sx, sy] of corners) {
    const d = forward.map((f, i) => f + sx * halfWidth * right[i] + sy * halfHeight * up[i])
    const horizontal = Math.hypot(d[0], d[2])
    let t: number
    if (d[1] < -1e-6) {
      t = (groundY - position.y) / d[1]
      if (horizontal * t > reach) t = reach / horizontal
    } else if (horizontal > 1e-6) {
      t = reach / horizontal
    } else {
      return undefined
    }
    points.push({ x: position.x + d[0] * t, z: position.z + d[2] * t })
  }
  return points
}
