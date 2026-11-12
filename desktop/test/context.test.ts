import { describe, expect, it, vi } from "vitest"

import { defineFeature, setupFeatures } from "../src/context.ts"
import { createTestContext } from "../src/testing.ts"

describe("features", () => {
  it("sets features up with a log scoped to their id and lists them in /desktop/info", async () => {
    const seen: string[] = []
    const t = await createTestContext({
      version: "9.9.9",
      features: [
        defineFeature({ id: "alpha", setup: (ctx) => ctx.log.info("hello") }),
        defineFeature({ id: "beta", setup: () => void seen.push("beta") }),
      ],
    })
    expect(t.featureIds).toEqual(["alpha", "beta"])
    expect(seen).toEqual(["beta"])
    expect(t.logs.some((line) => line.includes("[alpha] hello"))).toBe(true)

    const info = await t.request("GET", "/api/desktop/info")
    expect(info.status).toBe(200)
    expect(info.body).toEqual({
      desktop: true,
      version: "9.9.9",
      platform: process.platform,
      packaged: false,
      features: ["alpha", "beta"],
    })
  })

  it("keeps starting the others when one feature fails", async () => {
    const t = await createTestContext({
      features: [
        defineFeature({
          id: "broken",
          setup: () => {
            throw new Error("boom")
          },
        }),
        defineFeature({ id: "fine", setup: () => {} }),
      ],
    })
    expect(t.featureIds).toEqual(["fine"])
    expect(t.logs.join("\n")).toContain('feature "broken" failed to start')
  })

  it("refuses duplicate and badly named ids", async () => {
    const t = await createTestContext()
    const noop = () => {}
    await expect(setupFeatures(t.ctx, [{ id: "a", setup: noop }, { id: "a", setup: noop }])).rejects.toThrow(/twice/)
    await expect(setupFeatures(t.ctx, [{ id: "Bad_Id", setup: noop }])).rejects.toThrow(/kebab-case/)
  })

  it("does not let a feature take over a core route", async () => {
    const t = await createTestContext({
      features: [defineFeature({ id: "thief", setup: (ctx) => ctx.routes.get("/desktop/info", () => ({})) })],
    })
    expect(t.featureIds).toEqual([])
  })
})

describe("lifecycle", () => {
  it("runs ready and before-quit hooks, isolating failures", async () => {
    const t = await createTestContext()
    const order: string[] = []
    t.ctx.onReady(() => void order.push("ready"))
    t.ctx.onReady(() => {
      throw new Error("ready failed")
    })
    t.ctx.onBeforeQuit(async () => {
      expect(t.ctx.isQuitting()).toBe(true)
      order.push("quit")
    })
    await t.lifecycle.runReady()
    expect(t.ctx.isQuitting()).toBe(false)
    await t.lifecycle.runBeforeQuit()
    expect(order).toEqual(["ready", "quit"])
    expect(t.logs.join("\n")).toContain("ready hook failed")
  })

  it("does not wait forever for a before-quit hook", async () => {
    vi.useFakeTimers()
    try {
      const t = await createTestContext()
      t.ctx.onBeforeQuit(() => new Promise(() => {}))
      const done = t.lifecycle.runBeforeQuit(1_000)
      await vi.advanceTimersByTimeAsync(1_000)
      await done
      expect(t.logs.join("\n")).toContain("quitting anyway")
    } finally {
      vi.useRealTimers()
    }
  })

  it("quits when the last window closes unless a decider keeps the app running", async () => {
    const t = await createTestContext()
    expect(t.lifecycle.shouldQuitWhenAllClosed()).toBe(true)
    const stop = t.ctx.onWindowAllClosed(() => "keep-running")
    t.ctx.onWindowAllClosed(() => "quit")
    expect(t.lifecycle.shouldQuitWhenAllClosed()).toBe(false)
    stop()
    expect(t.lifecycle.shouldQuitWhenAllClosed()).toBe(true)
  })

  it("reports a --hidden launch", async () => {
    expect((await createTestContext({ argv: ["electron", ".", "--hidden"] })).ctx.launch.hidden).toBe(true)
    expect((await createTestContext()).ctx.launch.hidden).toBe(false)
  })
})
