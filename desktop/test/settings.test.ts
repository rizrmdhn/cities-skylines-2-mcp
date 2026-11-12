import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { z } from "zod"

import { createLogger, createMemorySink } from "../src/logger.ts"
import { openSettingsStore, SettingsValidationError, type SecretCodec } from "../src/settings.ts"

let dir: string
let file: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cs2mcp-settings-"))
  file = join(dir, "settings.json")
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

/** Reversible "encryption" that never contains the plain text. */
const fakeCodec: SecretCodec = {
  isAvailable: async () => true,
  encrypt: async (plain) => Buffer.from(`enc:${Buffer.from(plain).toString("hex")}`),
  decrypt: async (data) => ({ result: Buffer.from(data.toString().slice(4), "hex").toString() }),
}

function readStored() {
  return JSON.parse(readFileSync(file, "utf8")) as { version: number; values: Record<string, unknown> }
}

describe("settings store", () => {
  it("returns defaults, persists set values and reads them back", async () => {
    const store = await openSettingsStore({ file })
    const volume = store.define("demo.volume", { schema: z.number().min(0).max(1), default: 0.5 })
    expect(volume.get()).toBe(0.5)
    expect(existsSync(file)).toBe(false)

    await volume.set(0.8)
    expect(volume.get()).toBe(0.8)
    expect(store.get("demo.volume")).toBe(0.8)
    expect(readStored()).toEqual({ version: 1, values: { "demo.volume": 0.8 } })

    const reopened = await openSettingsStore({ file })
    expect(reopened.define("demo.volume", { schema: z.number(), default: 0 }).get()).toBe(0.8)
  })

  it("applies a change at once and tells listeners, only when the value changes", async () => {
    const store = await openSettingsStore({ file })
    const name = store.define("demo.name", { schema: z.string(), default: "a" })
    const listener = vi.fn()
    const unsubscribe = name.onChange(listener)

    const pending = name.set("b")
    expect(name.get()).toBe("b")
    expect(listener).toHaveBeenCalledWith("b", "a")
    await pending
    await name.set("b")
    expect(listener).toHaveBeenCalledTimes(1)

    unsubscribe()
    await name.set("c")
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it("validates and applies transforms", async () => {
    const store = await openSettingsStore({ file })
    const name = store.define("demo.name", { schema: z.string().trim().min(1), default: "x" })
    await expect(name.set(42)).rejects.toBeInstanceOf(SettingsValidationError)
    await expect(name.set("   ")).rejects.toThrow(/demo\.name/)
    await name.set("  padded  ")
    expect(name.get()).toBe("padded")
  })

  it("resets to the default and removes the key from the file", async () => {
    const store = await openSettingsStore({ file })
    const flag = store.define("demo.flag", { schema: z.boolean(), default: true })
    await flag.set(false)
    await flag.reset()
    expect(flag.get()).toBe(true)
    expect(readStored().values).toEqual({})
  })

  it("keeps keys nobody defined and ignores invalid stored values", async () => {
    writeFileSync(
      file,
      JSON.stringify({ version: 1, values: { "gone.feature": [1, 2], "demo.count": "not a number" } })
    )
    const lines: string[] = []
    const store = await openSettingsStore({ file, log: createLogger(createMemorySink(lines)) })
    const count = store.define("demo.count", { schema: z.number(), default: 3 })
    expect(count.get()).toBe(3)
    expect(lines.join("\n")).toContain("ignoring the stored value of \"demo.count\"")

    await count.set(4)
    expect(readStored().values).toEqual({ "gone.feature": [1, 2], "demo.count": 4 })
  })

  it("starts from defaults when the file is corrupt and keeps the broken file aside", async () => {
    writeFileSync(file, "{ this is not json")
    const store = await openSettingsStore({ file })
    expect(store.define("demo.flag", { schema: z.boolean(), default: true }).get()).toBe(true)
    expect(readdirSync(dir).some((name) => name.startsWith("settings.json.corrupt-"))).toBe(true)
    await store.set("demo.flag", false)
    expect(readStored().values).toEqual({ "demo.flag": false })
  })

  it("writes atomically: no temporary file is left behind", async () => {
    const store = await openSettingsStore({ file })
    const count = store.define("demo.count", { schema: z.number(), default: 0 })
    await Promise.all([count.set(1), count.set(2), count.set(3)])
    await store.flush()
    expect(readdirSync(dir)).toEqual(["settings.json"])
    expect(readStored().values["demo.count"]).toBe(3)
  })

  it("refuses bad keys and double definitions", async () => {
    const store = await openSettingsStore()
    expect(() => store.define("Bad Key", { schema: z.string(), default: "" })).toThrow(/invalid setting key/)
    store.define("demo.x", { schema: z.string(), default: "" })
    expect(() => store.define("demo.x", { schema: z.string(), default: "" })).toThrow(/defined twice/)
    expect(() => store.get("demo.unknown")).toThrow(/not defined/)
  })
})

describe("secrets", () => {
  const secretSchema = z.string().nullable()

  it("encrypts secrets at rest and decrypts them on open", async () => {
    const store = await openSettingsStore({ file, codec: fakeCodec })
    expect(store.secretsEncrypted).toBe(true)
    const token = store.define("token", { schema: secretSchema, default: null, secret: true })
    await token.set("hunter2")
    const text = readFileSync(file, "utf8")
    expect(text).not.toContain("hunter2")
    expect(readStored().values.token).toMatchObject({ $secret: "safeStorage" })

    const reopened = await openSettingsStore({ file, codec: fakeCodec })
    expect(reopened.define("token", { schema: secretSchema, default: null, secret: true }).get()).toBe("hunter2")
  })

  it("falls back to plain text without a codec and re-encrypts once one is available", async () => {
    const plain = await openSettingsStore({ file })
    expect(plain.secretsEncrypted).toBe(false)
    await plain.define("token", { schema: secretSchema, default: null, secret: true }).set("abc")
    expect(readStored().values.token).toEqual({ $secret: "plain", data: "abc" })

    const encrypted = await openSettingsStore({ file, codec: fakeCodec })
    expect(encrypted.define("token", { schema: secretSchema, default: null, secret: true }).get()).toBe("abc")
    await encrypted.flush()
    expect(readFileSync(file, "utf8")).not.toContain("abc")
  })

  it("drops a secret that cannot be decrypted", async () => {
    writeFileSync(file, JSON.stringify({ version: 1, values: { token: { $secret: "safeStorage", data: "AAAA" } } }))
    const broken: SecretCodec = { ...fakeCodec, decrypt: async () => Promise.reject(new Error("wrong user")) }
    const store = await openSettingsStore({ file, codec: broken })
    expect(store.define("token", { schema: secretSchema, default: null, secret: true }).get()).toBeNull()
  })

  it("shows secrets only as <key>Set and hides unexposed settings", async () => {
    const store = await openSettingsStore({ codec: fakeCodec })
    const token = store.define("token", { schema: secretSchema, default: null, secret: true })
    store.define("bridgeUrl", { schema: z.string().nullable(), default: null })
    store.define("window.main", { schema: z.unknown(), default: null, expose: false })
    expect(store.toPublic()).toEqual({ tokenSet: false, bridgeUrl: null })
    await token.set("hunter2")
    expect(store.toPublic()).toEqual({ tokenSet: true, bridgeUrl: null })
    expect(JSON.stringify(store.toPublic())).not.toContain("hunter2")
  })
})

describe("update", () => {
  it("applies a valid partial update", async () => {
    const store = await openSettingsStore({ file })
    store.define("a", { schema: z.number(), default: 1 })
    store.define("b", { schema: z.string(), default: "x" })
    await store.update({ a: 2 })
    expect(store.get("a")).toBe(2)
    expect(store.get("b")).toBe("x")
  })

  it("changes nothing when any entry is invalid, unknown or unexposed", async () => {
    const store = await openSettingsStore({ file })
    store.define("a", { schema: z.number(), default: 1 })
    store.define("hidden", { schema: z.number(), default: 1, expose: false })
    const error = await store.update({ a: 5, b: 1, hidden: 2 }).catch((err: unknown) => err)
    expect(error).toBeInstanceOf(SettingsValidationError)
    expect((error as SettingsValidationError).issues).toEqual(["unknown setting: b", "unknown setting: hidden"])
    expect(store.get("a")).toBe(1)

    await expect(store.update({ a: "five" })).rejects.toThrow(/^a: /)
    await expect(store.update([1])).rejects.toThrow(/JSON object/)
    expect(existsSync(file)).toBe(false)
  })
})
