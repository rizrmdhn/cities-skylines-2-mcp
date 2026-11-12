/**
 * Which bridge the app talks to and with which token. Precedence, per value:
 *   1. process environment (CS2_BRIDGE_URL, CS2MCP_TOKEN)
 *   2. the settings store (bridgeUrl, token)
 *   3. when not packaged: web/.env, then mcp-server/.env (the files the browser companion reads)
 *   4. defaults: http://127.0.0.1:8642, no token
 * Empty or whitespace-only values count as unset.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"

import { parse as parseDotenv } from "dotenv"
import { z } from "zod"

import type { SettingsStore, Setting } from "./settings.ts"

export const DEFAULT_BRIDGE_URL = "http://127.0.0.1:8642"

export type ConfigSource = "env" | "settings" | "dotenv" | "default"

export interface BridgeConfig {
  bridgeUrl: string
  /** Never leaves the main process. */
  token: string
  bridgeUrlSource: ConfigSource
  tokenSource: ConfigSource
}

/** What may be shown to the renderer and to features: everything but the token. */
export interface PublicBridgeConfig {
  bridgeUrl: string
  bridgeUrlSource: ConfigSource
  tokenSet: boolean
  tokenSource: ConfigSource
}

export interface ConfigLayers {
  env: Record<string, string | undefined>
  settings: { bridgeUrl: string | null; token: string | null }
  dotenv: Record<string, string | undefined>
}

function clean(value: string | null | undefined) {
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
}

function pick(
  layers: [ConfigSource, string | null | undefined][],
  fallback: string
): [string, ConfigSource] {
  for (const [source, value] of layers) {
    const cleaned = clean(value)
    if (cleaned !== undefined) return [cleaned, source]
  }
  return [fallback, "default"]
}

export function resolveBridgeConfig({ env, settings, dotenv }: ConfigLayers): BridgeConfig {
  const [bridgeUrl, bridgeUrlSource] = pick(
    [
      ["env", env.CS2_BRIDGE_URL],
      ["settings", settings.bridgeUrl],
      ["dotenv", dotenv.CS2_BRIDGE_URL],
    ],
    DEFAULT_BRIDGE_URL
  )
  const [token, tokenSource] = pick(
    [
      ["env", env.CS2MCP_TOKEN],
      ["settings", settings.token],
      ["dotenv", dotenv.CS2MCP_TOKEN],
    ],
    ""
  )
  return {
    bridgeUrl: bridgeUrl.replace(/\/+$/, ""),
    token,
    bridgeUrlSource,
    tokenSource,
  }
}

export function publicBridgeConfig(config: BridgeConfig): PublicBridgeConfig {
  return {
    bridgeUrl: config.bridgeUrl,
    bridgeUrlSource: config.bridgeUrlSource,
    tokenSet: config.token !== "",
    tokenSource: config.tokenSource,
  }
}

/**
 * The repo's dotenv files, parsed without touching process.env (so they rank below the store).
 * The first file wins for a variable, like the browser companion's loadConfig.
 */
export function readRepoDotenv(repoRoot: string): Record<string, string> {
  const result: Record<string, string> = {}
  for (const file of [join(repoRoot, "web", ".env"), join(repoRoot, "mcp-server", ".env")]) {
    let text: string
    try {
      text = readFileSync(file, "utf8")
    } catch {
      continue
    }
    for (const [name, value] of Object.entries(parseDotenv(text))) {
      if (!(name in result)) result[name] = value
    }
  }
  return result
}

/** Empty strings clear a value: the form field was emptied. */
const emptyToNull = (value: unknown) =>
  typeof value === "string" && value.trim() === "" ? null : value

export const bridgeUrlSchema = z.preprocess(
  emptyToNull,
  z
    .string()
    .trim()
    .refine((value) => {
      try {
        const url = new URL(value)
        return (url.protocol === "http:" || url.protocol === "https:") && url.hostname !== ""
      } catch {
        return false
      }
    }, "must be an http:// or https:// URL")
    .transform((value) => value.replace(/\/+$/, ""))
    .nullable()
)

export const tokenSchema = z.preprocess(emptyToNull, z.string().trim().max(4096).nullable())

export interface CoreSettings {
  bridgeUrl: Setting<string | null>
  token: Setting<string | null>
}

/** The settings the core itself needs. */
export function defineCoreSettings(store: SettingsStore): CoreSettings {
  return {
    bridgeUrl: store.define<string | null>("bridgeUrl", { schema: bridgeUrlSchema, default: null }),
    token: store.define<string | null>("token", { schema: tokenSchema, default: null, secret: true }),
  }
}
