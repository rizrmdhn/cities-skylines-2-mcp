import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import historyArchive, {
  cityFileName,
  mergeLive,
  parseArchive,
  type ArchivedEntry,
} from "../src/features/history-archive.ts"
import settingsApi from "../src/features/settings-api.ts"
import { createTestContext } from "../src/testing.ts"

function entry(id: number, time: string, partial: Partial<ArchivedEntry> = {}): ArchivedEntry {
  return {
    id,
    timeUtc: `2026-11-11T${time}Z`,
    gameTime: null,
    path: "/build/place",
    query: { x: "1", z: "2" },
    status: 200,
    ok: true,
    batchChild: false,
    moneyDelta: -100,
    result: null,
    ...partial,
  }
}

const newestFirst = (...entries: ArchivedEntry[]) => entries.reverse()

describe("mergeLive", () => {
  it("appends unseen entries oldest first and ignores the ones it has", () => {
    const archive = [entry(1, "08:00:00"), entry(2, "08:01:00")]
    const merged = mergeLive(archive, newestFirst(entry(2, "08:01:00"), entry(3, "08:02:00"), entry(4, "08:03:00")), 100)
    expect(merged.map((e) => e.id)).toEqual([1, 2, 3, 4])
  })

  it("returns the very same array when nothing is new", () => {
    const archive = [entry(1, "08:00:00")]
    expect(mergeLive(archive, [entry(1, "08:00:00")], 100)).toBe(archive)
  })

  it("keeps entries of an earlier game run whose ids restarted", () => {
    const archive = [entry(1, "08:00:00"), entry(2, "08:01:00")]
    const merged = mergeLive(archive, newestFirst(entry(1, "09:30:00"), entry(2, "09:31:00")), 100)
    expect(merged.map((e) => [e.id, e.timeUtc.slice(11, 19)])).toEqual([
      [1, "08:00:00"],
      [2, "08:01:00"],
      [1, "09:30:00"],
      [2, "09:31:00"],
    ])
  })

  it("keeps at most `max` entries, dropping the oldest", () => {
    const archive = [entry(1, "08:00:00"), entry(2, "08:01:00"), entry(3, "08:02:00")]
    const merged = mergeLive(archive, newestFirst(entry(4, "08:03:00"), entry(5, "08:04:00")), 4)
    expect(merged.map((e) => e.id)).toEqual([2, 3, 4, 5])
    expect(mergeLive(merged, [], 2).map((e) => e.id)).toEqual([4, 5])
  })

  it("tells a repeated id with another start time apart", () => {
    const merged = mergeLive([entry(1, "08:00:00")], [entry(1, "08:00:01")], 100)
    expect(merged).toHaveLength(2)
  })
})

describe("parseArchive", () => {
  it("reads a stored archive and drops bad and duplicate entries", () => {
    const text = JSON.stringify({
      version: 1,
      city: "Riverside",
      entries: [entry(1, "08:00:00"), { id: "x" }, 7, entry(1, "08:00:00"), entry(2, "08:01:00")],
    })
    expect(parseArchive(text)?.entries.map((e) => e.id)).toEqual([1, 2])
  })

  it("refuses anything that is not an archive", () => {
    expect(parseArchive("not json")).toBeUndefined()
    expect(parseArchive("[]")).toBeUndefined()
    expect(parseArchive(JSON.stringify({ version: 2, city: "A", entries: [] }))).toBeUndefined()
    expect(parseArchive(JSON.stringify({ version: 1, city: "A" }))).toBeUndefined()
  })
})

describe("cityFileName", () => {
  it("makes a safe file name", () => {
    expect(cityFileName("Riverside")).toBe("riverside.json")
    expect(cityFileName("../../Évry & Co.")).toBe("vry-co.json")
    expect(cityFileName("   ")).toBe("city.json")
  })
})

describe("history-archive feature", () => {
  let userData: string
  beforeEach(() => {
    userData = mkdtempSync(join(tmpdir(), "cs2mcp-archive-"))
  })
  afterEach(() => rmSync(userData, { recursive: true, force: true }))

  /** A bridge whose log the test controls (newest first). */
  function bridge(state: { city: string | null; entries: ArchivedEntry[]; down?: boolean }) {
    return (async (input: RequestInfo | URL) => {
      if (state.down) throw new TypeError("fetch failed")
      const path = new URL(String(input)).pathname
      if (path === "/city/overview") return Response.json({ cityName: state.city })
      if (path === "/history") return Response.json({ entries: state.entries, total: state.entries.length })
      return Response.json({ error: "no" }, { status: 404 })
    }) as typeof fetch
  }

  async function start(state: Parameters<typeof bridge>[0]) {
    return createTestContext({ features: [historyArchive, settingsApi], userData, bridgeFetch: bridge(state) })
  }

  function files() {
    return readdirSync(join(userData, "history-archive")).sort()
  }

  it("serves the bridge's log and keeps it after the game restarted", async () => {
    const state = { city: "Riverside", entries: newestFirst(entry(1, "08:00:00"), entry(2, "08:01:00")) }
    const t = await start(state)
    const first = await t.request<{ city: string; total: number; entries: ArchivedEntry[] }>("GET", "/api/desktop/history-archive")
    expect(first.status).toBe(200)
    expect(first.body).toMatchObject({ city: "Riverside", total: 2 })
    expect(first.body.entries.map((e) => e.id)).toEqual([2, 1]) // newest first

    // the game restarted: the bridge starts again at id 1
    state.entries = newestFirst(entry(1, "09:30:00"))
    const second = await t.request<{ total: number; entries: ArchivedEntry[] }>("GET", "/api/desktop/history-archive")
    expect(second.body.total).toBe(3)
    expect(second.body.entries.map((e) => e.timeUtc.slice(11, 16))).toEqual(["09:30", "08:01", "08:00"])
  })

  it("writes one file per city, atomically, and a new run reads it back with the game off", async () => {
    const state = { city: "Riverside", entries: newestFirst(entry(1, "08:00:00"), entry(2, "08:01:00")) }
    const t = await start(state)
    await t.request("GET", "/api/desktop/history-archive")
    await t.lifecycle.runBeforeQuit()
    expect(files()).toEqual(["riverside.json"]) // no leftover temp file
    expect(JSON.parse(readFileSync(join(userData, "history-archive", "riverside.json"), "utf8"))).toMatchObject({
      version: 1,
      city: "Riverside",
    })

    // the app starts again while the game is not running
    const offline = await start({ city: null, entries: [], down: true })
    const res = await offline.request<{ city: string; total: number }>("GET", "/api/desktop/history-archive")
    expect(res).toMatchObject({ status: 200, body: { city: "Riverside", total: 2 } })
  })

  it("keeps the cities apart", async () => {
    const state = { city: "Riverside", entries: [entry(1, "08:00:00")] }
    const t = await start(state)
    await t.request("GET", "/api/desktop/history-archive")
    state.city = "Hilltop"
    state.entries = [entry(5, "10:00:00")]
    const res = await t.request<{ city: string; total: number }>("GET", "/api/desktop/history-archive")
    expect(res.body).toMatchObject({ city: "Hilltop", total: 1 })
    await t.lifecycle.runBeforeQuit()
    expect(files()).toEqual(["hilltop.json", "riverside.json"])
  })

  it("moves a corrupt file aside and starts over", async () => {
    mkdirSync(join(userData, "history-archive"))
    writeFileSync(join(userData, "history-archive", "riverside.json"), "{ this is not json")
    const t = await start({ city: "Riverside", entries: [entry(1, "08:00:00")] })
    const res = await t.request<{ total: number }>("GET", "/api/desktop/history-archive")
    expect(res.body.total).toBe(1)
    await t.lifecycle.runBeforeQuit()
    expect(files().filter((f) => f.includes(".corrupt-"))).toHaveLength(1)
    expect(t.logs.join("\n")).toMatch(/not a history archive/)
  })

  it("stays within the configured size", async () => {
    const t = await start({
      city: "Riverside",
      entries: newestFirst(...Array.from({ length: 150 }, (_, i) => entry(i + 1, "08:00:00", { path: `/p/${i}` }))),
    })
    const set = await t.request("POST", "/api/desktop/settings", { "history-archive.maxEntries": 100 })
    expect(set.status).toBe(200)
    const res = await t.request<{ total: number; entries: ArchivedEntry[] }>("GET", "/api/desktop/history-archive")
    expect(res.body.total).toBe(100)
    expect(res.body.entries[0].id).toBe(150) // the oldest 50 were dropped
  })

  it("answers 503 while there is neither a game nor an archive", async () => {
    const t = await start({ city: null, entries: [], down: true })
    const res = await t.request<{ kind: string }>("GET", "/api/desktop/history-archive")
    expect(res).toMatchObject({ status: 503, body: { kind: "companion" } })
  })

  it("polls on a timer once the app is ready", async () => {
    const state = { city: "Riverside", entries: [entry(1, "08:00:00")] }
    const t = await start(state)
    await t.lifecycle.runReady()
    await new Promise((resolve) => setTimeout(resolve, 50))
    await t.lifecycle.runBeforeQuit()
    expect(files()).toEqual(["riverside.json"])
  })
})
