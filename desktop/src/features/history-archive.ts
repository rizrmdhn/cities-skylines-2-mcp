/**
 * Keeps the AI change log across game restarts. The bridge's /history lives in game memory and
 * holds the newest 300 entries, so it is gone when the game closes. This feature polls it, appends
 * every entry it has not seen to a file per city under <userData>/history-archive/, and serves the
 * merged archive on GET /api/desktop/history-archive (the activity page prefers it).
 *
 * - Identity of an entry: `<id>|<timeUtc>|<path>`. The bridge's ids restart at 1 when the game
 *   restarts, the start time (second precision) tells the runs apart.
 * - The file keeps entries oldest first, in the order they were first seen, capped at
 *   `history-archive.maxEntries` (oldest dropped first).
 * - A file that cannot be read or has the wrong shape is moved aside as `<file>.corrupt-<time>`
 *   and the city starts empty again.
 */
import { mkdirSync, readdirSync, readFileSync, renameSync, statSync } from "node:fs"
import { rename, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { z } from "zod"

import { BridgeError } from "../bridge.ts"
import { defineFeature } from "../context.ts"
import { RouteError } from "../routes.ts"

export const ARCHIVE_VERSION = 1
/** Entries the bridge keeps (its cap), and so the most one poll can bring. */
const BRIDGE_LIMIT = 300

declare module "../settings.ts" {
  interface SettingValues {
    "history-archive.intervalSeconds": number
    "history-archive.maxEntries": number
  }
}

const entrySchema = z.object({
  id: z.number().int(),
  timeUtc: z.string(),
  gameTime: z.string().nullable().catch(null),
  path: z.string(),
  query: z.record(z.string(), z.string()).nullable().catch(null),
  status: z.number(),
  ok: z.boolean(),
  batchChild: z.boolean().catch(false),
  moneyDelta: z.number().catch(0),
  result: z.string().nullable().catch(null),
})
export type ArchivedEntry = z.infer<typeof entrySchema>

const fileSchema = z.object({
  version: z.literal(ARCHIVE_VERSION),
  city: z.string(),
  entries: z.array(z.unknown()),
})

export function entryKey(entry: Pick<ArchivedEntry, "id" | "timeUtc" | "path">) {
  return `${entry.id}|${entry.timeUtc}|${entry.path}`
}

/** A file name for a city: lowercase letters and digits, never empty. */
export function cityFileName(city: string) {
  const slug = city.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60)
  return `${slug || "city"}.json`
}

/**
 * Appends the entries of `live` (the bridge's order: newest first) that `archive` (oldest first)
 * does not have, oldest first, and keeps at most `max` entries. Returns the same array when
 * nothing changed.
 */
export function mergeLive(archive: ArchivedEntry[], live: readonly ArchivedEntry[], max: number) {
  const seen = new Set(archive.map(entryKey))
  const fresh: ArchivedEntry[] = []
  for (const entry of [...live].reverse()) {
    const key = entryKey(entry)
    if (seen.has(key)) continue
    seen.add(key)
    fresh.push(entry)
  }
  if (fresh.length === 0 && archive.length <= max) return archive
  const merged = [...archive, ...fresh]
  return merged.length > max ? merged.slice(merged.length - max) : merged
}

/** Entries of a stored file, or undefined when the file is not an archive. Bad entries are dropped. */
export function parseArchive(text: string): { city: string; entries: ArchivedEntry[] } | undefined {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return undefined
  }
  const file = fileSchema.safeParse(raw)
  if (!file.success) return undefined
  const seen = new Set<string>()
  const entries: ArchivedEntry[] = []
  for (const candidate of file.data.entries) {
    const parsed = entrySchema.safeParse(candidate)
    if (!parsed.success) continue
    const key = entryKey(parsed.data)
    if (seen.has(key)) continue
    seen.add(key)
    entries.push(parsed.data)
  }
  return { city: file.data.city, entries }
}

export default defineFeature({
  id: "history-archive",
  setup(ctx) {
    const interval = ctx.settings.define("history-archive.intervalSeconds", {
      schema: z.number().int().min(5).max(3600),
      default: 30,
    })
    const maxEntries = ctx.settings.define("history-archive.maxEntries", {
      schema: z.number().int().min(100).max(100_000),
      default: 5000,
    })

    const dir = join(ctx.paths.userData, "history-archive")
    /** Entries per city file name, oldest first; loaded from disk the first time a city is seen. */
    const cache = new Map<string, { city: string; entries: ArchivedEntry[] }>()
    let currentFile: string | undefined
    let timer: NodeJS.Timeout | undefined
    let polling: Promise<void> | undefined
    let writes: Promise<void> = Promise.resolve()

    function load(file: string, city: string) {
      const cached = cache.get(file)
      if (cached) return cached
      const path = join(dir, file)
      let loaded: { city: string; entries: ArchivedEntry[] } | undefined
      let text: string | undefined
      try {
        text = readFileSync(path, "utf8")
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") ctx.log.warn(`cannot read ${file}: ${String(err)}`)
      }
      if (text !== undefined) {
        loaded = parseArchive(text)
        if (!loaded) {
          const aside = `${path}.corrupt-${Date.now()}`
          try {
            renameSync(path, aside)
            ctx.log.warn(`${file} is not a history archive: moved to ${aside}`)
          } catch (err) {
            ctx.log.warn(`${file} is not a history archive and could not be moved aside: ${String(err)}`)
          }
        }
      }
      const state = loaded ?? { city, entries: [] }
      cache.set(file, state)
      return state
    }

    function save(file: string, state: { city: string; entries: ArchivedEntry[] }) {
      const text = JSON.stringify({ version: ARCHIVE_VERSION, city: state.city, entries: state.entries })
      // One write at a time, each atomic (temp file + rename).
      writes = writes.then(async () => {
        const path = join(dir, file)
        const tmp = `${path}.tmp`
        try {
          mkdirSync(dir, { recursive: true })
          await writeFile(tmp, text, "utf8")
          await rename(tmp, path)
        } catch (err) {
          ctx.log.warn(`cannot write ${file}: ${String(err)}`)
          await rm(tmp, { force: true }).catch(() => {})
        }
      })
      return writes
    }

    /** The city file written most recently: what to show when the game is not running. */
    function newestFile() {
      try {
        return readdirSync(dir)
          .filter((name) => name.endsWith(".json"))
          .map((name) => ({ name, time: statSync(join(dir, name)).mtimeMs }))
          .sort((a, b) => b.time - a.time)[0]?.name
      } catch {
        return undefined
      }
    }

    async function pollOnce() {
      try {
        const [overview, history] = await Promise.all([
          ctx.bridge.get<{ cityName: string | null }>("/city/overview"),
          ctx.bridge.get<{ entries: unknown[] }>("/history", { limit: BRIDGE_LIMIT }),
        ])
        const city = overview.cityName?.trim() || "Unnamed city"
        const file = cityFileName(city)
        currentFile = file
        const live = (history.entries ?? []).flatMap((raw) => {
          const parsed = entrySchema.safeParse(raw)
          return parsed.success ? [parsed.data] : []
        })
        const state = load(file, city)
        const merged = mergeLive(state.entries, live, maxEntries.get())
        if (merged !== state.entries) {
          state.entries = merged
          state.city = city
          await save(file, state)
        }
      } catch (err) {
        // The game is not running or no city is loaded: nothing to archive now.
        if (!(err instanceof BridgeError)) throw err
        ctx.log.debug(`history not archived: ${err.message}`)
      }
    }

    /** One poll at a time; a caller during a poll waits for it. */
    function poll() {
      polling ??= pollOnce().finally(() => {
        polling = undefined
      })
      return polling
    }

    function schedule() {
      clearInterval(timer)
      timer = setInterval(() => void poll().catch((err) => ctx.log.error(`poll failed: ${String(err)}`)), interval.get() * 1000)
    }

    ctx.routes.get("/desktop/history-archive", async () => {
      await poll().catch((err) => ctx.log.error(`poll failed: ${String(err)}`))
      const file = currentFile ?? newestFile()
      if (!file) throw new RouteError(503, "no city has been seen yet: is the game running?")
      const state = load(file, "")
      return {
        city: state.city,
        total: state.entries.length,
        maxEntries: maxEntries.get(),
        // newest first, like the bridge's /history
        entries: [...state.entries].reverse(),
      }
    })

    interval.onChange(schedule)
    ctx.onReady(() => {
      schedule()
      void poll().catch((err) => ctx.log.error(`poll failed: ${String(err)}`))
    })
    ctx.onBeforeQuit(async () => {
      clearInterval(timer)
      await polling?.catch(() => {})
      await writes
    })
  },
})
