import { describe, expect, it } from "vitest"

import {
  clampStep,
  nextPlayStep,
  replayMarkers,
  replayView,
  sessionView,
  stepAt,
  stepBy,
} from "@/lib/replay"
import { groupSessions } from "@/lib/sessions"
import { stepDetail, stepSummary } from "@/lib/step-text"
import { sessionEntries } from "@/test/fixtures"

// Newest session, by when each step started: 1 school (place), 2 batch of 3 road pieces (one failed),
// 3 tax change without a position (logged between the batch's parts), 4 park (place).
const [latest] = groupSessions(sessionEntries)

describe("replay stepping", () => {
  it("walks the steps of the session in order and stops at the ends", () => {
    expect(latest.steps.map((s) => s.index)).toEqual([1, 2, 3, 4])
    expect(stepBy(latest, 1, 1)).toBe(2)
    expect(stepBy(latest, 4, 1)).toBe(4)
    expect(stepBy(latest, 1, -1)).toBe(1)
  })

  it("clamps a bad step number from the URL", () => {
    expect(clampStep(latest, undefined)).toBe(1)
    expect(clampStep(latest, 0)).toBe(1)
    expect(clampStep(latest, 99)).toBe(4)
    expect(clampStep(latest, 2.7)).toBe(2)
    expect(clampStep(latest, NaN)).toBe(1)
    expect(stepAt(latest, 99).index).toBe(4)
  })

  it("plays forward and ends after the last step", () => {
    expect(nextPlayStep(latest, 1)).toBe(2)
    expect(nextPlayStep(latest, 3)).toBe(4)
    expect(nextPlayStep(latest, 4)).toBeUndefined()
  })
})

describe("replay markers", () => {
  it("numbers the steps that have a position and skips the rest", () => {
    const markers = replayMarkers(latest)
    expect(markers.map((m) => m.step)).toEqual([1, 2, 4])
    expect(markers[1]).toMatchObject({ ok: false, centre: { x: 300, z: 300 } })
    expect(markers[1].shapes).toHaveLength(3)
  })
})

describe("replay view", () => {
  const view = { cx: 0, cz: 0, zoom: 0 }

  it("centres a point and zooms in to at least 4", () => {
    expect(replayView(stepAt(latest, 4), view)).toEqual({ cx: 500, cz: 100, zoom: 4 })
    expect(replayView(stepAt(latest, 4), { ...view, zoom: 6 })?.zoom).toBe(6)
  })

  it("fits a batch's whole extent", () => {
    const fitted = replayView(stepAt(latest, 2), view)
    expect(fitted).toMatchObject({ cx: 300, cz: 300 })
    // 600 m wide: 0.6 * 14336 / 600 = 14.3 -> zoom 3.84, rounded to quarters
    expect(fitted?.zoom).toBe(3.75)
  })

  it("stays put for a step without a position", () => {
    expect(replayView(stepAt(latest, 3), view)).toBeUndefined()
  })
})

describe("session view", () => {
  it("fits every position of the session", () => {
    // x 0..600, z -340..300 around (300, -20): 640 m -> zoom 3.749, rounded down to a quarter: 3.5
    expect(sessionView(latest)).toEqual({ cx: 300, cz: -20, zoom: 3.5 })
  })

  it("is undefined for a session without positions", () => {
    const [taxes] = groupSessions(sessionEntries.filter((e) => e.path === "/city/taxes/set").slice(0, 1))
    expect(sessionView(taxes)).toBeUndefined()
  })
})

describe("step text", () => {
  it("names what a batch ran and what a single step used", () => {
    expect(stepDetail(stepAt(latest, 2))).toBe("road connect × 3")
    expect(stepDetail(stepAt(latest, 4))).toBe("Park01")
  })

  it("summarises a step on one line", () => {
    expect(stepSummary(stepAt(latest, 4))).toBe("place · Park01 — done — -¢5,000")
    expect(stepSummary(stepAt(latest, 2))).toBe("batch (3 parts) — failed (1 of 3 parts) — -¢30,000")
  })
})
