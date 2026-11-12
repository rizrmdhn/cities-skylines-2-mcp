/**
 * Typed settings persisted as JSON in <userData>/settings.json. Electron-free: secrets are
 * encrypted through an injected SecretCodec (Electron safeStorage in the app, a fake in tests).
 *
 * File format: { "version": 1, "values": { "<key>": <value> | { "$secret": "safeStorage" | "plain", "data": "..." } } }
 * Keys nobody defined (a feature that was removed, a newer version) are kept untouched.
 */
import { mkdirSync, readFileSync, renameSync } from "node:fs"
import { rename, rm, writeFile } from "node:fs/promises"
import { dirname } from "node:path"

import type { z } from "zod"

import type { Logger } from "./logger.ts"

/** Encrypts secrets at rest; matches the async half of Electron's safeStorage. */
export interface SecretCodec {
  isAvailable(): Promise<boolean>
  encrypt(plain: string): Promise<Buffer>
  decrypt(data: Buffer): Promise<{ result: string; shouldReEncrypt?: boolean }>
}

/**
 * Value types of the settings defined by the core, for store.get("bridgeUrl"). Features usually
 * keep the handle that define() returns instead; they may also add their keys here with
 * `declare module "../settings.ts" { interface SettingValues { "tray.closeToTray": boolean } }`.
 */
export interface SettingValues {
  bridgeUrl: string | null
  token: string | null
  "window.main": WindowState | null
}

/** Saved main window placement (core setting "window.main", not exposed to the renderer). */
export interface WindowState {
  x?: number
  y?: number
  width: number
  height: number
  maximized: boolean
}

export interface SettingDefinition<T> {
  /** Validates stored values, set() and POST /api/desktop/settings. Transforms are applied. */
  schema: z.ZodType<T>
  /** Used while nothing valid is stored. */
  default: T
  /**
   * Encrypted at rest. get() still returns the plain value (main process only), but the
   * settings route reports only `<key>Set: boolean`. The schema must produce string | null.
   */
  secret?: boolean
  /** Readable and writable through /api/desktop/settings. Default true. */
  expose?: boolean
}

export type Unsubscribe = () => void

/** Handle to one setting, returned by define(): typed by its schema. */
export interface Setting<T> {
  readonly key: string
  get(): T
  /** Validates, applies at once (get() and listeners see it immediately) and persists. */
  set(value: unknown): Promise<void>
  /** Back to the default; the key is removed from the file. */
  reset(): Promise<void>
  onChange(listener: (value: T, previous: T) => void): Unsubscribe
}

export interface SettingsStore {
  /**
   * Declares a setting. Keys are namespaced by feature: "<featureId>.<name>" (the core uses
   * bare names). Defining a key twice throws.
   */
  define<T>(key: string, definition: SettingDefinition<T>): Setting<T>
  get<K extends keyof SettingValues>(key: K): SettingValues[K]
  get(key: string): unknown
  set(key: string, value: unknown): Promise<void>
  onChange(key: string, listener: (value: unknown, previous: unknown) => void): Unsubscribe
  isDefined(key: string): boolean
  /** Exposed settings for the renderer: secrets replaced by `<key>Set: boolean`. */
  toPublic(): Record<string, unknown>
  /**
   * Validated partial update of exposed settings (the body of POST /api/desktop/settings).
   * All-or-nothing: throws SettingsValidationError and changes nothing if any entry is invalid.
   */
  update(patch: unknown): Promise<void>
  /** Whether secrets are encrypted on disk (false: stored as plain text, e.g. no OS keystore). */
  readonly secretsEncrypted: boolean
  /** Resolves once every pending write reached the disk. */
  flush(): Promise<void>
}

/** One rejected entry of an update: the setting key (null when the body as a whole is wrong). */
export interface SettingIssue {
  key: string | null
  message: string
}

export class SettingsValidationError extends Error {
  readonly issues: string[]
  /** The same issues per setting key; the 400 answer of POST /api/desktop/settings carries them. */
  readonly fields: SettingIssue[]
  constructor(issues: string[], fields: SettingIssue[] = []) {
    super(issues.join("; "))
    this.name = "SettingsValidationError"
    this.issues = issues
    this.fields = fields
  }
}

export interface OpenSettingsOptions {
  /** JSON file; omit for an in-memory store (tests). */
  file?: string
  /** Omit to store secrets as plain text (tests). */
  codec?: SecretCodec
  log?: Logger
}

const KEY_PATTERN = /^[A-Za-z][\w-]*(\.[A-Za-z][\w-]*)*$/
const FILE_VERSION = 1

interface SecretEnvelope {
  $secret: "safeStorage" | "plain"
  data: string
}

function isEnvelope(value: unknown): value is SecretEnvelope {
  return (
    typeof value === "object" &&
    value !== null &&
    ((value as SecretEnvelope).$secret === "safeStorage" ||
      (value as SecretEnvelope).$secret === "plain") &&
    typeof (value as SecretEnvelope).data === "string"
  )
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function same(a: unknown, b: unknown) {
  return JSON.stringify(a) === JSON.stringify(b)
}

function describeIssues(key: string, error: z.ZodError) {
  return error.issues.map((issue) =>
    issue.path.length ? `${key}.${issue.path.join(".")}: ${issue.message}` : `${key}: ${issue.message}`
  )
}

function fieldIssues(key: string, error: z.ZodError): SettingIssue[] {
  return error.issues.map((issue) => ({
    key,
    message: issue.path.length ? `${issue.path.join(".")}: ${issue.message}` : issue.message,
  }))
}

interface Entry {
  definition: SettingDefinition<unknown>
  value: unknown
  /** Set explicitly (stored in the file) rather than the default. */
  stored: boolean
  listeners: Set<(value: unknown, previous: unknown) => void>
}

function readFile(file: string, log?: Logger): Record<string, unknown> {
  let text: string
  try {
    text = readFileSync(file, "utf8")
  } catch {
    return {}
  }
  try {
    const parsed = JSON.parse(text) as unknown
    if (isPlainObject(parsed) && isPlainObject(parsed.values)) return { ...parsed.values }
    throw new Error("not a settings file")
  } catch (err) {
    const aside = `${file}.corrupt-${Date.now()}`
    log?.warn(`settings file is unreadable, starting with defaults; kept it as ${aside}`, err)
    try {
      renameSync(file, aside)
    } catch {
      // nothing more to do: the next write replaces it
    }
    return {}
  }
}

/** Opens (or creates) the store. Async because stored secrets are decrypted up front. */
export async function openSettingsStore(options: OpenSettingsOptions = {}): Promise<SettingsStore> {
  const { file, codec, log } = options
  const raw: Record<string, unknown> = file ? readFile(file, log) : {}
  const encrypted = codec ? await codec.isAvailable().catch(() => false) : false

  /** Plain values of every secret in the file, decrypted once. */
  const secrets = new Map<string, string | null>()
  let reEncrypt = false
  for (const [key, value] of Object.entries(raw)) {
    if (!isEnvelope(value)) continue
    if (value.$secret === "plain") {
      secrets.set(key, value.data)
      if (encrypted) reEncrypt = true
      continue
    }
    try {
      if (!codec) throw new Error("no secret codec")
      const { result, shouldReEncrypt } = await codec.decrypt(Buffer.from(value.data, "base64"))
      secrets.set(key, result)
      if (shouldReEncrypt) reEncrypt = true
    } catch (err) {
      // e.g. the settings were copied from another Windows account: the secret is lost
      log?.warn(`cannot decrypt the stored setting "${key}"; it is ignored until set again`, err)
      secrets.set(key, null)
    }
  }

  const entries = new Map<string, Entry>()
  let writing: Promise<void> = Promise.resolve()
  let dirtySecrets = reEncrypt

  async function encode(entry: Entry): Promise<unknown> {
    if (!entry.definition.secret) return entry.value
    const plain = entry.value as string
    if (encrypted && codec) {
      return {
        $secret: "safeStorage",
        data: (await codec.encrypt(plain)).toString("base64"),
      } satisfies SecretEnvelope
    }
    return { $secret: "plain", data: plain } satisfies SecretEnvelope
  }

  async function writeNow() {
    if (!file) return
    const values: Record<string, unknown> = { ...raw }
    for (const [key, entry] of entries) {
      if (!entry.stored || (entry.definition.secret && entry.value === null)) delete values[key]
      else values[key] = await encode(entry)
    }
    const text = JSON.stringify({ version: FILE_VERSION, values }, null, 2) + "\n"
    mkdirSync(dirname(file), { recursive: true })
    const tmp = `${file}.${process.pid}.tmp`
    await writeFile(tmp, text, "utf8")
    // Windows: a scanner or indexer may hold the file for a moment.
    for (let attempt = 0; ; attempt++) {
      try {
        await rename(tmp, file)
        break
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code
        if (attempt >= 5 || (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES")) {
          await rm(tmp, { force: true })
          throw err
        }
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 50 * (attempt + 1)))
      }
    }
    // keep raw in step so keys removed by reset() stay removed
    for (const key of Object.keys(raw)) if (!(key in values)) delete raw[key]
    Object.assign(raw, values)
  }

  function persist(): Promise<void> {
    const next = writing.then(writeNow)
    writing = next.catch((err: unknown) => {
      log?.error("could not write the settings file", err)
    })
    return next
  }

  function entryOf(key: string): Entry {
    const entry = entries.get(key)
    if (!entry) throw new Error(`setting "${key}" is not defined`)
    return entry
  }

  function validate(key: string, entry: Entry, value: unknown): unknown {
    const result = entry.definition.schema.safeParse(value)
    if (!result.success) {
      throw new SettingsValidationError(describeIssues(key, result.error), fieldIssues(key, result.error))
    }
    return result.data
  }

  /** Applies a validated value; returns whether it changed. Listeners run after all values are applied. */
  function apply(entry: Entry, value: unknown, stored: boolean) {
    const previous = entry.value
    entry.value = value
    entry.stored = stored
    return same(previous, value) ? undefined : () => notify(entry, value, previous)
  }

  function notify(entry: Entry, value: unknown, previous: unknown) {
    for (const listener of entry.listeners) {
      try {
        listener(value, previous)
      } catch (err) {
        log?.error("a settings listener failed", err)
      }
    }
  }

  async function setValue(key: string, value: unknown) {
    const entry = entryOf(key)
    const notifyChange = apply(entry, validate(key, entry, value), true)
    const written = persist()
    notifyChange?.()
    await written
  }

  const store: SettingsStore = {
    secretsEncrypted: encrypted,

    define<T>(key: string, definition: SettingDefinition<T>): Setting<T> {
      if (!KEY_PATTERN.test(key)) throw new Error(`invalid setting key "${key}"`)
      if (entries.has(key)) throw new Error(`setting "${key}" is defined twice`)
      const entry: Entry = {
        definition: definition as SettingDefinition<unknown>,
        value: definition.default,
        stored: false,
        listeners: new Set(),
      }
      const storedValue = definition.secret ? secrets.get(key) : raw[key]
      if (storedValue !== undefined && (definition.secret || !isEnvelope(storedValue))) {
        const result = definition.schema.safeParse(storedValue)
        if (result.success) {
          entry.value = result.data
          entry.stored = true
        } else {
          log?.warn(`ignoring the stored value of "${key}": ${describeIssues(key, result.error).join("; ")}`)
        }
      }
      entries.set(key, entry)
      if (definition.secret && dirtySecrets && entry.stored) {
        dirtySecrets = false
        void persist().catch(() => {})
      }

      return {
        key,
        get: () => entry.value as T,
        set: (value) => setValue(key, value),
        reset: async () => {
          const notifyChange = apply(entry, definition.default, false)
          const written = persist()
          notifyChange?.()
          await written
        },
        onChange: (listener) => store.onChange(key, listener as (value: unknown, previous: unknown) => void),
      }
    },

    get(key: string) {
      return entryOf(key).value as never
    },

    set: setValue,

    onChange(key, listener) {
      const entry = entryOf(key)
      entry.listeners.add(listener)
      return () => entry.listeners.delete(listener)
    },

    isDefined: (key) => entries.has(key),

    toPublic() {
      const result: Record<string, unknown> = {}
      for (const [key, entry] of entries) {
        if (entry.definition.expose === false) continue
        if (entry.definition.secret) {
          result[`${key}Set`] = typeof entry.value === "string" && entry.value !== ""
        } else {
          result[key] = entry.value
        }
      }
      return result
    },

    async update(patch) {
      if (!isPlainObject(patch)) {
        const message = "expected a JSON object of settings"
        throw new SettingsValidationError([message], [{ key: null, message }])
      }
      const issues: string[] = []
      const fields: SettingIssue[] = []
      const accepted: [Entry, unknown][] = []
      for (const [key, value] of Object.entries(patch)) {
        const entry = entries.get(key)
        if (!entry || entry.definition.expose === false) {
          issues.push(`unknown setting: ${key}`)
          fields.push({ key, message: "unknown setting" })
          continue
        }
        const result = entry.definition.schema.safeParse(value)
        if (result.success) accepted.push([entry, result.data])
        else {
          issues.push(...describeIssues(key, result.error))
          fields.push(...fieldIssues(key, result.error))
        }
      }
      if (issues.length) throw new SettingsValidationError(issues, fields)
      const notifications = accepted.map(([entry, value]) => apply(entry, value, true))
      const written = persist()
      for (const notifyChange of notifications) notifyChange?.()
      await written
    },

    flush: () => writing,
  }
  return store
}
