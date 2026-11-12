import { describe, expect, it } from "vitest"

import type { HistoryEntry } from "@/lib/bridge-types"
import {
  formatDuration,
  groupSessions,
  groupSteps,
  sessionOfEntry,
  stepCentre,
  stepMatches,
} from "@/lib/sessions"
import { sessionEntries } from "@/test/fixtures"

function e(id: number, time: string, partial: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    id,
    timeUtc: `2026-11-11T${time}Z`,
    gameTime: null,
    path: "/build/place",
    query: null,
    status: 200,
    ok: true,
    batchChild: false,
    moneyDelta: 0,
    result: null,
    ...partial,
  }
}

/** Oldest first is easier to write; the bridge sends newest first. */
const newestFirst = (...entries: HistoryEntry[]) => entries.reverse()

describe("groupSessions", () => {
  it("splits sessions at a pause longer than 15 minutes, newest first", () => {
    const sessions = groupSessions(sessionEntries)
    expect(sessions.map((s) => s.key)).toEqual(["4-1794387605", "1-1794384000"])
    expect(sessions.map((s) => s.number)).toEqual([2, 1])
    expect(sessions[1].steps.map((s) => s.entry?.id)).toEqual([1, 2, 3])
  })

  it("keeps steps exactly 15 minutes apart together and splits one second later", () => {
    expect(groupSessions(newestFirst(e(1, "08:00:00"), e(2, "08:15:00")))).toHaveLength(1)
    expect(groupSessions(newestFirst(e(1, "08:00:00"), e(2, "08:15:01")))).toHaveLength(2)
  })

  it("measures the pause from the latest start so far, not the session's first step", () => {
    const sessions = groupSessions(
      newestFirst(e(1, "08:00:00"), e(2, "08:14:00"), e(3, "08:28:00"), e(4, "08:42:00"))
    )
    expect(sessions).toHaveLength(1)
    expect(sessions[0].durationMs).toBe(42 * 60 * 1000)
  })

  it("starts a new session when the ids go backwards (the game restarted)", () => {
    const sessions = groupSessions(newestFirst(e(7, "08:00:00"), e(8, "08:01:00"), e(1, "08:02:00")))
    expect(sessions.map((s) => s.steps.map((step) => step.entry?.id))).toEqual([[1], [7, 8]])
  })

  it("reads a batch as one step with its parts, at the place it started", () => {
    const [newest] = groupSessions(sessionEntries)
    expect(newest.steps.map((s) => [s.kind, s.entry?.id, s.parts.map((p) => p.id)])).toEqual([
      ["single", 4, []],
      ["batch", 9, [5, 6, 8]],
      ["single", 7, []],
      ["single", 10, []],
    ])
    expect(newest.steps.map((s) => s.index)).toEqual([1, 2, 3, 4])
    const batch = newest.steps[1]
    expect(batch.startMs).toBe(Date.parse("2026-11-11T09:05:00Z"))
    expect(batch.shapes).toHaveLength(3)
  })

  it("fails a batch that answered 200 when one of its parts failed", () => {
    const batch = groupSessions(sessionEntries)[0].steps[1]
    expect(batch.entry?.ok).toBe(true)
    expect(batch.ok).toBe(false)
    expect(batch.failedParts).toBe(1)
  })

  it("counts a batch's money once, from the batch entry", () => {
    const [newest, oldest] = groupSessions(sessionEntries)
    expect(newest.steps[1].moneyDelta).toBe(-30000)
    expect(newest.spent).toBe(48000 + 30000 + 5000)
    expect(newest.netMoney).toBe(-83000)
    expect(oldest.spent).toBe(12000)
  })

  it("counts refunds in the net change but not in the money spent", () => {
    const [session] = groupSessions(
      newestFirst(
        e(1, "08:00:00", { moneyDelta: -1000 }),
        e(2, "08:01:00", { path: "/build/demolish", moneyDelta: 400 })
      )
    )
    expect(session.spent).toBe(1000)
    expect(session.netMoney).toBe(-600)
  })

  it("summarises results, actions, assets, place and game time", () => {
    const [newest, oldest] = groupSessions(sessionEntries)
    expect([newest.succeeded, newest.failed]).toEqual([3, 1])
    expect([oldest.succeeded, oldest.failed]).toEqual([2, 1])
    expect(newest.entryCount).toBe(7)
    expect(newest.actions).toEqual([
      { name: "/build/road/connect", count: 3 },
      { name: "/build/place", count: 2 },
      { name: "/city/taxes/set", count: 1 },
    ])
    expect(newest.prefabs).toEqual([
      { name: "Small Road", count: 3 },
      { name: "ElementarySchool01", count: 1 },
      { name: "Park01", count: 1 },
    ])
    expect(newest.place).toEqual({
      centre: { x: 300, z: -20 },
      min: { x: 0, z: -340 },
      max: { x: 600, z: 300 },
      steps: 3,
    })
    expect([newest.gameTimeStart, newest.gameTimeEnd]).toEqual(["2026-03-15 09:00", "2026-03-15 11:00"])
    expect(oldest.place?.steps).toBe(2)
  })

  it("keeps parts without their batch entry as a running batch when the bridge says so", () => {
    const entries = newestFirst(
      e(1, "08:00:00"),
      e(2, "08:00:01", { batchChild: true, path: "/build/road/connect", moneyDelta: -10 }),
      e(3, "08:00:02", { batchChild: true, path: "/build/road/connect", moneyDelta: -20 })
    )
    const [running] = groupSessions(entries, { batchRunning: true })
    expect(running.steps[1]).toMatchObject({
      kind: "batch",
      entry: undefined,
      path: "/build/batch",
      moneyDelta: -30,
    })
    expect(running.running).toBe(true)
    expect(groupSessions(entries)[0].running).toBe(false)
  })

  it("treats a batch request without parts (refused before it ran) as a single step", () => {
    const steps = groupSteps(newestFirst(e(1, "08:00:00", { path: "/build/batch", ok: false, status: 409 })))
    expect(steps[0].step).toMatchObject({ kind: "single", ok: false, parts: [] })
  })

  it("does not join parts across a game restart to a later batch entry", () => {
    const steps = groupSteps(
      newestFirst(
        e(5, "08:00:00", { batchChild: true, path: "/build/road/connect" }),
        e(1, "09:00:00", { batchChild: true, path: "/build/road/connect" }),
        e(2, "09:00:05", { path: "/build/batch" })
      )
    )
    expect(steps.map(({ step, run }) => [run, step.entry?.id, step.parts.map((p) => p.id)])).toEqual([
      [0, undefined, [5]],
      [1, 2, [1]],
    ])
  })

  it("returns nothing for an empty log", () => {
    expect(groupSessions([])).toEqual([])
  })
})

describe("session helpers", () => {
  const sessions = groupSessions(sessionEntries)

  it("finds the session of an entry, batch parts included", () => {
    expect(sessionOfEntry(sessions, 6)?.number).toBe(2)
    expect(sessionOfEntry(sessions, 2)?.number).toBe(1)
    expect(sessionOfEntry(sessions, 99)).toBeUndefined()
  })

  it("filters steps by result and action, a batch matching through its parts", () => {
    const batch = sessions[0].steps[1]
    expect(stepMatches(batch, "failed", undefined)).toBe(true)
    expect(stepMatches(batch, "ok", undefined)).toBe(false)
    expect(stepMatches(batch, "all", "/build/road/connect")).toBe(true)
    expect(stepMatches(batch, "all", "/build/batch")).toBe(true)
    expect(stepMatches(batch, "all", "/build/place")).toBe(false)
  })

  it("centres a step on the middle of its positions", () => {
    expect(stepCentre(sessions[0].steps[1])).toEqual({ x: 300, z: 300 })
    expect(stepCentre(sessions[0].steps[2])).toBeUndefined()
  })

  it("formats durations", () => {
    expect([0, 40_000, 12 * 60_000, 60 * 60_000, 65 * 60_000].map(formatDuration)).toEqual([
      "0 s",
      "40 s",
      "12 min",
      "1 h",
      "1 h 5 min",
    ])
  })
})
