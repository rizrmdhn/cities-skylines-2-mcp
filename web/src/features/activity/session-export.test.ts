import { describe, expect, it } from "vitest"

import {
  entryError,
  exportFileName,
  historyJsonExport,
  historyMarkdown,
  sessionJsonExport,
  sessionMarkdown,
} from "@/features/activity/session-export"
import { groupSessions } from "@/lib/sessions"
import { sessionEntries } from "@/test/fixtures"

const sessions = groupSessions(sessionEntries)
const context = { city: "Riverside", now: new Date("2026-11-12T10:00:00Z") }

describe("session export", () => {
  it("writes a session as a Markdown report", async () => {
    await expect(sessionMarkdown(sessions[0], context)).toMatchFileSnapshot("__snapshots__/session-2.md")
  })

  it("writes the whole history as one Markdown report", async () => {
    await expect(
      historyMarkdown(sessions, { ...context, filters: { status: "failed", kind: undefined } })
    ).toMatchFileSnapshot("__snapshots__/activity.md")
  })

  it("writes a session as JSON with the entries exactly as the bridge logged them", async () => {
    const text = sessionJsonExport(sessions[0], context)
    await expect(text).toMatchFileSnapshot("__snapshots__/session-2.json")
    const parsed = JSON.parse(text)
    expect(parsed.sessions[0].steps[1].entry).toEqual(sessionEntries.find((e) => e.id === 9))
    expect(parsed.sessions[0].steps[1].parts.map((p: { id: number }) => p.id)).toEqual([5, 6, 8])
  })

  it("writes the whole history as JSON, newest session first, with the filters", () => {
    const parsed = JSON.parse(historyJsonExport(sessions, { ...context, filters: { status: "all", kind: "/build/road" } }))
    expect(parsed).toMatchObject({
      format: "cs2mcp-ai-sessions",
      version: 1,
      exportedAt: "2026-11-12T10:00:00.000Z",
      city: "Riverside",
      filters: { status: "all", kind: "/build/road" },
    })
    expect(parsed.sessions.map((s: { number: number }) => s.number)).toEqual([2, 1])
    expect(parsed.sessions[1]).toMatchObject({ spent: 12000, succeeded: 2, failed: 1, durationSeconds: 120 })
  })

  it("names files after the city, session and start time", () => {
    expect(exportFileName({ session: sessions[0] }, "md", context)).toBe(
      "cs2mcp-riverside-session-2-20261111-0900.md"
    )
    expect(exportFileName({ sessions }, "json", { now: context.now })).toBe("cs2mcp-activity-20261112-1000.json")
  })

  it("reads the bridge's error message from a failed entry", () => {
    expect(entryError(sessionEntries.find((e) => e.id === 3)!)).toBe("area is not zonable")
    expect(entryError({ ...sessionEntries[0], ok: false, status: 0, result: null })).toBe(
      "no result: the operation never completed"
    )
    expect(entryError({ ...sessionEntries[0], ok: false, status: 500, result: "boom" })).toBe("boom")
    expect(entryError(sessionEntries[0])).toBeUndefined()
  })
})
