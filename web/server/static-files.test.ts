import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { NOT_BUILT_MESSAGE, resolveStaticFile } from "./static-files.ts"

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cs2mcp-static-"))
  writeFileSync(join(root, "index.html"), "<!doctype html>")
  writeFileSync(join(root, "favicon.svg"), "<svg/>")
  mkdirSync(join(root, "assets"))
  writeFileSync(join(root, "assets", "app.js"), "1")
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

describe("resolveStaticFile", () => {
  it("answers files with their content type and cache policy", () => {
    const asset = resolveStaticFile(root, "GET", "/assets/app.js")
    expect(asset).toMatchObject({ kind: "file", status: 200, file: join(root, "assets", "app.js") })
    expect(asset.headers["Content-Type"]).toBe("text/javascript; charset=utf-8")
    expect(asset.headers["Cache-Control"]).toContain("immutable")

    const icon = resolveStaticFile(root, "HEAD", "/favicon.svg")
    expect(icon.headers["Content-Type"]).toBe("image/svg+xml")
    expect(icon.headers["Cache-Control"]).toBe("no-cache")
  })

  it("falls back to index.html for client routes", () => {
    for (const path of ["/", "/activity", "/map/deep/route"]) {
      const res = resolveStaticFile(root, "GET", path)
      expect(res, path).toMatchObject({ kind: "file", file: join(root, "index.html") })
      expect(res.headers["Content-Type"]).toBe("text/html; charset=utf-8")
    }
  })

  it("answers 404 for a missing file with an extension", () => {
    expect(resolveStaticFile(root, "GET", "/assets/missing.js")).toMatchObject({
      kind: "error",
      status: 404,
    })
  })

  it("refuses paths outside the folder", () => {
    for (const path of ["/%2e%2e/%2e%2e/package.json", "/..%2f..%2fpackage.json", "/%2e%2e"]) {
      expect(resolveStaticFile(root, "GET", path).status, path).toBe(403)
    }
  })

  it("refuses methods other than GET and HEAD and malformed paths", () => {
    expect(resolveStaticFile(root, "POST", "/")).toMatchObject({
      status: 405,
      headers: { Allow: "GET, HEAD" },
    })
    expect(resolveStaticFile(root, "GET", "/%E0%A4%A").status).toBe(400)
  })

  it("explains when the app is not built", () => {
    const empty = mkdtempSync(join(tmpdir(), "cs2mcp-empty-"))
    try {
      expect(resolveStaticFile(empty, "GET", "/")).toMatchObject({
        status: 503,
        body: NOT_BUILT_MESSAGE,
      })
    } finally {
      rmSync(empty, { recursive: true, force: true })
    }
  })
})
