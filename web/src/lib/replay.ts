import type { MarkerShape } from "@/lib/history-markers"
import { stepCentre, type Session, type Step } from "@/lib/sessions"
import { clampView, MAX_ZOOM, WORLD_SIZE, type MapView, type WorldPoint } from "@/lib/world"

/*
 * Replay of one session on the map. The stepper walks every step of the session (so the numbers
 * match the timeline); a step without a position keeps the map where it is and says so.
 */

/** Time one step stays on screen while playing. */
export const REPLAY_STEP_MS = 1500

export interface ReplayMarker {
  /** The step's number in its session: 1-based, as in the timeline. */
  step: number
  ok: boolean
  shapes: MarkerShape[]
  centre: WorldPoint
}

/** Markers of every step that has a position, in order. */
export function replayMarkers(session: Session): ReplayMarker[] {
  return session.steps.flatMap((step) => {
    const centre = stepCentre(step)
    return centre ? [{ step: step.index, ok: step.ok, shapes: step.shapes, centre }] : []
  })
}

/** The step number kept within 1..steps.length (1 for a missing or bad number). */
export function clampStep(session: Session, step: number | undefined) {
  if (step === undefined || !Number.isFinite(step)) return 1
  return Math.min(session.steps.length, Math.max(1, Math.trunc(step)))
}

export function stepAt(session: Session, step: number | undefined): Step {
  return session.steps[clampStep(session, step) - 1]
}

/** Previous/next step; stays at the ends. */
export function stepBy(session: Session, current: number | undefined, delta: 1 | -1) {
  return clampStep(session, clampStep(session, current) + delta)
}

/** What the "play" button does after `current`: the next step, or nothing at the end. */
export function nextPlayStep(session: Session, current: number | undefined) {
  const now = clampStep(session, current)
  return now >= session.steps.length ? undefined : now + 1
}

/** Zoom that shows an extent (metres) in about 60% of the map; undefined for a single spot. */
function fitZoomFor(extent: number) {
  return extent < 1 ? undefined : Math.log2((0.6 * WORLD_SIZE) / extent)
}

function fitZoom(step: Step) {
  const points = step.shapes.flatMap((shape) =>
    shape.kind === "point" ? [shape.at] : [shape.from, shape.to]
  )
  const xs = points.map((p) => p.x)
  const zs = points.map((p) => p.z)
  return fitZoomFor(Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...zs) - Math.min(...zs)))
}

/** The whole session on the map: centred on all its positions, zoomed to fit them. Undefined without any position. */
export function sessionView(session: Session): MapView | undefined {
  const place = session.place
  if (!place) return undefined
  const fit = fitZoomFor(Math.max(place.max.x - place.min.x, place.max.z - place.min.z))
  const zoom = fit === undefined ? 4 : Math.min(Math.max(fit, 2), 6)
  return clampView({ cx: Math.round(place.centre.x), cz: Math.round(place.centre.z), zoom: Math.floor(zoom * 4) / 4 })
}

/** Where the map goes for a step: centred on it, zoomed in enough to see it. Undefined without a position. */
export function replayView(step: Step, current: MapView): MapView | undefined {
  const centre = stepCentre(step)
  if (!centre) return undefined
  const fit = fitZoom(step)
  const zoom = fit === undefined ? Math.max(current.zoom, 4) : Math.min(fit, 6)
  return clampView({ cx: Math.round(centre.x), cz: Math.round(centre.z), zoom: Math.round(Math.min(zoom, MAX_ZOOM) * 4) / 4 })
}
