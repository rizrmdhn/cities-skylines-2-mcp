import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

import {
  bridgeUrlSchema,
  DEFAULT_BRIDGE_URL,
  publicBridgeConfig,
  readRepoDotenv,
  resolveBridgeConfig,
  tokenSchema,
} from "../src/config.ts"

const none = { bridgeUrl: null, token: null }

describe("resolveBridgeConfig", () => {
  it("falls back to the defaults", () => {
    expect(resolveBridgeConfig({ env: {}, settings: none, dotenv: {} })).toEqual({
      bridgeUrl: DEFAULT_BRIDGE_URL,
      token: "",
      bridgeUrlSource: "default",
      tokenSource: "default",
    })
  })

  it("ranks env over settings over .env, per value", () => {
    const dotenv = { CS2_BRIDGE_URL: "http://dotenv:1", CS2MCP_TOKEN: "dotenv-token" }
    const settings = { bridgeUrl: "http://settings:2", token: "settings-token" }
    expect(resolveBridgeConfig({ env: {}, settings: none, dotenv })).toMatchObject({
      bridgeUrl: "http://dotenv:1",
      bridgeUrlSource: "dotenv",
      token: "dotenv-token",
      tokenSource: "dotenv",
    })
    expect(resolveBridgeConfig({ env: {}, settings, dotenv })).toMatchObject({
      bridgeUrl: "http://settings:2",
      bridgeUrlSource: "settings",
      token: "settings-token",
    })
    expect(
      resolveBridgeConfig({ env: { CS2MCP_TOKEN: "env-token", CS2_BRIDGE_URL: "  " }, settings, dotenv })
    ).toMatchObject({
      bridgeUrl: "http://settings:2",
      token: "env-token",
      tokenSource: "env",
    })
    expect(resolveBridgeConfig({ env: { CS2_BRIDGE_URL: "http://env:3//" }, settings, dotenv }).bridgeUrl).toBe(
      "http://env:3"
    )
  })

  it("never puts the token in the public view", () => {
    const config = resolveBridgeConfig({ env: { CS2MCP_TOKEN: "hunter2" }, settings: none, dotenv: {} })
    const view = publicBridgeConfig(config)
    expect(view).toEqual({ bridgeUrl: DEFAULT_BRIDGE_URL, bridgeUrlSource: "default", tokenSet: true, tokenSource: "env" })
    expect(JSON.stringify(view)).not.toContain("hunter2")
  })
})

describe("readRepoDotenv", () => {
  it("reads web/.env before mcp-server/.env without touching process.env", () => {
    const repo = mkdtempSync(join(tmpdir(), "cs2mcp-repo-"))
    try {
      mkdirSync(join(repo, "web"))
      mkdirSync(join(repo, "mcp-server"))
      writeFileSync(join(repo, "web", ".env"), "CS2_BRIDGE_URL=http://web:1\n")
      writeFileSync(join(repo, "mcp-server", ".env"), "CS2_BRIDGE_URL=http://mcp:2\nCS2MCP_TOKEN=from-mcp\n")
      expect(readRepoDotenv(repo)).toEqual({ CS2_BRIDGE_URL: "http://web:1", CS2MCP_TOKEN: "from-mcp" })
      expect(process.env.CS2MCP_TOKEN).not.toBe("from-mcp")
      expect(readRepoDotenv(join(repo, "missing"))).toEqual({})
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })
})

describe("setting schemas", () => {
  it("accepts http(s) bridge URLs, trims trailing slashes and clears on empty", () => {
    expect(bridgeUrlSchema.parse("http://127.0.0.1:9000/")).toBe("http://127.0.0.1:9000")
    expect(bridgeUrlSchema.parse(" https://host:1 ")).toBe("https://host:1")
    expect(bridgeUrlSchema.parse("")).toBeNull()
    expect(bridgeUrlSchema.parse(null)).toBeNull()
    for (const bad of ["ftp://x", "not a url", "javascript:alert(1)", 5]) {
      expect(bridgeUrlSchema.safeParse(bad).success, String(bad)).toBe(false)
    }
  })

  it("trims tokens and clears on empty", () => {
    expect(tokenSchema.parse("  abc ")).toBe("abc")
    expect(tokenSchema.parse("")).toBeNull()
    expect(tokenSchema.safeParse(12).success).toBe(false)
  })
})

describe("version", () => {
  it("matches the web app's version", () => {
    const read = (path: string) =>
      (JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8")) as { version: string }).version
    expect(read("../package.json")).toBe(read("../../web/package.json"))
  })
})
