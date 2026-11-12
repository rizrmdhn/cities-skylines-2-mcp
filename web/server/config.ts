import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { config as loadDotenv } from "dotenv"

/** The web package folder, both from server/ (dev, tests) and dist-server/ (built). */
export const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url))

export interface CompanionConfig {
  bridgeUrl: string
  token: string
  port: number
  version: string
}

export const DEFAULT_PORT = 8643

/**
 * Same variables as the MCP server. Values come from the environment first, then web/.env,
 * then mcp-server/.env, so one .env file configures both.
 */
export function loadConfig(): CompanionConfig {
  loadDotenv({ path: fileURLToPath(new URL("../.env", import.meta.url)), quiet: true })
  loadDotenv({
    path: fileURLToPath(new URL("../../mcp-server/.env", import.meta.url)),
    quiet: true,
  })

  const rawPort = process.env.CS2MCP_WEB_PORT?.trim()
  const port = rawPort ? Number(rawPort) : DEFAULT_PORT
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`CS2MCP_WEB_PORT must be a port number, got "${rawPort}"`)
  }

  return {
    bridgeUrl: (process.env.CS2_BRIDGE_URL ?? "http://127.0.0.1:8642").replace(/\/+$/, ""),
    token: process.env.CS2MCP_TOKEN?.trim() ?? "",
    port,
    version: readVersion(),
  }
}

export function readVersion(): string {
  const pkg = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8")
  ) as { version: string }
  return pkg.version
}
