/**
 * The "Adding a feature" example of desktop/README.md, kept here so it is known to compile and
 * work. A real feature lives in src/features/<id>.ts and its test in test/<id>.test.ts.
 */
import { describe, expect, it } from "vitest"
import { z } from "zod"

import { BridgeError } from "../src/bridge.ts"
import { defineFeature } from "../src/context.ts"
import { RouteError } from "../src/routes.ts"
import { createTestContext } from "../src/testing.ts"

// ---- src/features/city-watch.ts -------------------------------------------------------------

interface Overview {
  cityName: string
  population: number
}

const cityWatch = defineFeature({
  id: "city-watch",
  setup(ctx) {
    // Namespaced, validated, persisted; shows up in GET /api/desktop/settings.
    const interval = ctx.settings.define("city-watch.intervalSeconds", {
      schema: z.number().int().min(5).max(3600),
      default: 60,
    })
    let last: Overview | null = null
    let timer: NodeJS.Timeout | undefined

    async function poll() {
      try {
        last = await ctx.bridge.get<Overview>("/city/overview")
      } catch (err) {
        if (!(err instanceof BridgeError)) throw err
        ctx.log.debug(`overview unavailable: ${err.message}`)
      }
    }
    function schedule() {
      clearInterval(timer)
      timer = setInterval(() => void poll(), interval.get() * 1000)
    }

    ctx.routes.get("/desktop/city-watch", () => ({ last, intervalSeconds: interval.get() }))
    ctx.routes.post("/desktop/city-watch/refresh", async () => {
      await poll()
      if (!last) throw new RouteError(503, "no city data yet")
      return last
    })

    interval.onChange(schedule)
    ctx.onReady(() => {
      schedule()
      void poll()
    })
    ctx.onBeforeQuit(() => clearInterval(timer))
  },
})

// ---- test/city-watch.test.ts ----------------------------------------------------------------

describe("city-watch", () => {
  it("polls the bridge on demand and reports the last overview", async () => {
    const t = await createTestContext({
      features: [cityWatch],
      bridgeFetch: async () => Response.json({ cityName: "Riverside", population: 12345 }),
    })
    expect(t.featureIds).toContain("city-watch")

    const refreshed = await t.request("POST", "/api/desktop/city-watch/refresh")
    expect(refreshed).toMatchObject({ status: 200, body: { cityName: "Riverside" } })

    const state = await t.request("GET", "/api/desktop/city-watch")
    expect(state.body).toEqual({ last: { cityName: "Riverside", population: 12345 }, intervalSeconds: 60 })
  })

  it("answers 503 while the bridge is down", async () => {
    const t = await createTestContext({ features: [cityWatch] }) // default: bridge unreachable
    const res = await t.request("POST", "/api/desktop/city-watch/refresh")
    expect(res).toMatchObject({ status: 503, body: { error: "no city data yet", kind: "companion" } })
  })

  it("exposes and validates its setting through the settings store", async () => {
    const t = await createTestContext({ features: [cityWatch] })
    expect(t.ctx.settings.toPublic()["city-watch.intervalSeconds"]).toBe(60)
    await expect(t.ctx.settings.update({ "city-watch.intervalSeconds": 1 })).rejects.toThrow(/intervalSeconds/)
    await t.ctx.settings.update({ "city-watch.intervalSeconds": 30 })
    expect(t.ctx.settings.get("city-watch.intervalSeconds")).toBe(30)
  })
})
