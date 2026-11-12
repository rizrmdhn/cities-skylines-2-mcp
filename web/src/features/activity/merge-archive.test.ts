import { describe, expect, it } from "vitest"

import { mergeArchive } from "@/features/activity/merge-archive"
import type { HistoryEntry } from "@/lib/bridge-types"
import { groupSessions } from "@/lib/sessions"

function e(id: number, time: string): HistoryEntry {
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
  }
}

describe("mergeArchive", () => {
  it("is the live log without an archive", () => {
    const live = [e(2, "08:01:00"), e(1, "08:00:00")]
    expect(mergeArchive(undefined, live)).toEqual(live)
    expect(mergeArchive(undefined, undefined)).toEqual([])
  })

  it("is the archive when the bridge cannot be reached", () => {
    const archive = [e(2, "08:01:00"), e(1, "08:00:00")]
    expect(mergeArchive(archive, undefined)).toEqual(archive)
  })

  it("adds live entries the archive has not polled yet, as the newest", () => {
    const archive = [e(2, "08:01:00"), e(1, "08:00:00")]
    const live = [e(4, "08:03:00"), e(3, "08:02:00"), e(2, "08:01:00")]
    expect(mergeArchive(archive, live).map((x) => x.id)).toEqual([4, 3, 2, 1])
  })

  it("keeps earlier game runs apart from a live log whose ids restarted", () => {
    const archive = [e(2, "08:01:00"), e(1, "08:00:00")]
    const live = [e(2, "20:01:00"), e(1, "20:00:00")]
    const merged = mergeArchive(archive, live)
    expect(merged.map((x) => x.timeUtc.slice(11, 16))).toEqual(["20:01", "20:00", "08:01", "08:00"])
    // and the restart splits the sessions
    expect(groupSessions(merged)).toHaveLength(2)
  })
})
