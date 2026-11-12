import { useEffect, useMemo, useRef } from "react"

import { useActivity } from "@/features/activity/use-activity"
import { clampStep, replayMarkers, replayView, sessionView, stepAt } from "@/lib/replay"
import { findSession } from "@/lib/sessions"
import type { MapView } from "@/lib/world"

/**
 * The replay of one session, from the map's `replay` (session key) and `step` search params:
 * the session, the numbered markers, and the pan to the current step whenever the step changes
 * (not on every history refresh, and not when the user drags the map in between).
 */
export function useReplay({
  replay,
  step,
  view,
  onPan,
}: {
  replay: string | undefined
  step: number | undefined
  view: MapView
  onPan: (view: MapView) => void
}) {
  const { sessions } = useActivity()
  const session = useMemo(() => findSession(sessions ?? [], replay), [sessions, replay])
  const markers = useMemo(() => (session ? replayMarkers(session) : []), [session])
  const current = session ? clampStep(session, step) : 1

  const latest = useRef({ view, onPan })
  useEffect(() => {
    latest.current = { view, onPan }
  })

  const key = session?.key
  const framed = useRef<string>(undefined)
  useEffect(() => {
    if (!session) return
    let target = replayView(stepAt(session, current), latest.current.view)
    // Arriving on a step without a position: show the whole session instead of an empty map.
    if (!target && framed.current !== session.key) target = sessionView(session)
    framed.current = session.key
    if (target) latest.current.onPan(target)
    // Only when the session or the step changes: a refreshed history gives a new `session` object.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, current])

  return {
    active: replay !== undefined,
    loading: sessions === undefined,
    session,
    markers,
    current,
  }
}
