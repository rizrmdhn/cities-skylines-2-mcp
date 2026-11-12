import { useEffect, useRef, useState } from "react"

import type { WorldPoint } from "@/lib/world"

/** Time constant of the glide, ms: the map covers ~63% of the remaining distance in this time. */
const GLIDE_MS = 180
/** Farther than this the camera was teleported (new city, jump to a place): do not glide across the map. */
const SNAP_DISTANCE = 3000
/** Closer than this (metres) the map has arrived. */
const ARRIVED = 0.05

/**
 * The map centre while following the game camera. `target` is the camera's look-at point as the
 * latest poll reported it (undefined = not following); the returned point glides there from
 * `from` (where the map was) instead of jumping once per poll. Undefined while not following.
 * `prefers-reduced-motion` turns the glide into plain jumps.
 */
export function useSmoothFollow(target: WorldPoint | undefined, from: WorldPoint): WorldPoint | undefined {
  const [position, setPosition] = useState<WorldPoint>()
  const targetRef = useRef(target)
  const fromRef = useRef(from)
  useEffect(() => {
    targetRef.current = target
    fromRef.current = from
  })

  const following = target !== undefined
  useEffect(() => {
    if (!following) return
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false
    let current = fromRef.current
    let last = performance.now()
    let frame = 0
    const tick = (now: number) => {
      const goal = targetRef.current
      if (goal) {
        const dx = goal.x - current.x
        const dz = goal.z - current.z
        const distance = Math.hypot(dx, dz)
        if (distance > ARRIVED) {
          const k = reduced || distance > SNAP_DISTANCE ? 1 : 1 - Math.exp(-Math.min(now - last, 100) / GLIDE_MS)
          current = k >= 1 || distance * (1 - k) < ARRIVED ? goal : { x: current.x + dx * k, z: current.z + dz * k }
          setPosition(current)
        }
      }
      last = now
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => {
      cancelAnimationFrame(frame)
      setPosition(undefined) // the next follow starts from where the map is then
    }
  }, [following])

  // Until the first frame the map stays where it was; afterwards it is the glide's position.
  return following ? (position ?? from) : undefined
}
