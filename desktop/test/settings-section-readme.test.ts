import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

import { describe, expect, it } from "vitest"

const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8").replace(/\r\n/g, "\n")

/**
 * README.md ("Adding a settings section") shows a section file verbatim. That file lives in the web
 * app (web/src/test/city-watch-section.example.tsx), where tsc checks it against the real API;
 * this keeps the README in step with it.
 */
describe("README settings section example", () => {
  it("is the type-checked file in the web app", () => {
    const example = read("../../web/src/test/city-watch-section.example.tsx").trim()
    expect(read("../README.md")).toContain(example)
  })
})
