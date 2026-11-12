import { useState } from "react"

export type Trend = "up" | "down" | "flat"

interface Seen {
  key: string
  value: number | undefined
  trend: Trend
}

/** The next state after a new value: the direction of the last change, kept while the value stands still (a paused game). */
export function nextSeen(seen: Seen, value: number | undefined, key: string): Seen {
  if (seen.key !== key) return { key, value, trend: "flat" }
  if (value === undefined || value === seen.value) return seen
  const trend: Trend = seen.value === undefined ? "flat" : value > seen.value ? "up" : "down"
  return { key, value, trend }
}

/**
 * Which way a polled number moved the last time it changed. `key` identifies what is measured
 * (the city): another key starts over with "flat".
 */
export function useTrend(value: number | undefined, key: string): Trend {
  const [seen, setSeen] = useState<Seen>({ key, value, trend: "flat" })
  const next = nextSeen(seen, value, key)
  if (next !== seen) setSeen(next)
  return next.trend
}
