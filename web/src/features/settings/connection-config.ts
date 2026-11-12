import type { ConfigSource } from "@/lib/desktop"

export const DEFAULT_BRIDGE_URL = "http://127.0.0.1:8642"

/** Where a configured value comes from, as the settings page words it. */
export const SOURCE_LABEL: Record<ConfigSource, string> = {
  env: "environment variable",
  settings: "saved here",
  dotenv: ".env file (development)",
  default: "default",
}

/** The same rule as the desktop app's schema for `bridgeUrl`, checked before sending. */
export function bridgeUrlProblem(value: string): string | undefined {
  if (value === "") return undefined
  try {
    const url = new URL(value)
    if ((url.protocol === "http:" || url.protocol === "https:") && url.hostname !== "") return undefined
  } catch {
    // fall through
  }
  return "Enter an http:// or https:// URL, e.g. http://127.0.0.1:8642."
}
