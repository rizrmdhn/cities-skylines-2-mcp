import { describe, expect, it } from "vitest"

import appFolders, { createAppFolders } from "../src/features/app-folders.ts"
import { createTestContext } from "../src/testing.ts"

describe("app-folders", () => {
  it("lists the fixed log and settings folders", async () => {
    const t = await createTestContext({ features: [createAppFolders(async () => "")] })
    expect(t.featureIds).toEqual(["app-folders"])
    const res = await t.request("GET", "/api/desktop/app-folders")
    expect(res).toMatchObject({
      status: 200,
      body: { logs: t.ctx.paths.logs, settings: t.ctx.paths.userData },
    })
  })

  it("opens only the known folders, whatever the request carries", async () => {
    const opened: string[] = []
    const t = await createTestContext({
      features: [
        createAppFolders(async (path) => {
          opened.push(path)
          return ""
        }),
      ],
    })
    const logs = await t.request("POST", "/api/desktop/app-folders/open-logs", { path: "C:\\Windows" })
    const settings = await t.request("POST", "/api/desktop/app-folders/open-settings", { path: "/etc" })
    expect(logs).toMatchObject({ status: 200, body: { ok: true } })
    expect(settings).toMatchObject({ status: 200, body: { ok: true } })
    expect(opened).toEqual([t.ctx.paths.logs, t.ctx.paths.userData])

    // no route takes a path; GET on an action and unknown actions are refused
    expect((await t.request("GET", "/api/desktop/app-folders/open-logs")).status).toBe(405)
    expect((await t.request("POST", "/api/desktop/app-folders/open", { path: "/" })).status).toBe(404)
    expect(opened).toHaveLength(2)
  })

  it("answers 500 with the shell's message when the folder cannot be opened", async () => {
    const t = await createTestContext({ features: [createAppFolders(async () => "Access is denied.")] })
    const res = await t.request("POST", "/api/desktop/app-folders/open-logs")
    expect(res).toMatchObject({
      status: 500,
      body: { kind: "companion", error: "could not open the logs folder: Access is denied." },
    })
    expect(t.logs.some((line) => line.includes("could not open the logs folder"))).toBe(true)
  })

  it("turns a throwing opener into the same 500", async () => {
    const t = await createTestContext({
      features: [
        createAppFolders(async () => {
          throw new Error("boom")
        }),
      ],
    })
    const res = await t.request("POST", "/api/desktop/app-folders/open-settings")
    expect(res).toMatchObject({ status: 500, body: { error: "could not open the settings folder: boom" } })
  })

  it("loads in plain Node without Electron (the shell is imported only when opening)", () => {
    expect(appFolders.id).toBe("app-folders")
  })
})
