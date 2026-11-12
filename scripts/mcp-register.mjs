#!/usr/bin/env node
/**
 * Registers (or with --remove, unregisters) the cs2 MCP server with Claude Code at user scope,
 * so it is available in every project, not just this repository.
 *
 *   npm run mcp:register      # add or update
 *   npm run mcp:unregister    # remove
 */
import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { fileURLToPath } from "node:url"

const NAME = "cs2"
const entry = fileURLToPath(new URL("../mcp-server/dist/index.js", import.meta.url))
const remove = process.argv.includes("--remove")

/** Runs the Claude Code CLI; falls back to a shell for an npm-installed claude.cmd on Windows. */
function claude(args, { quiet = false } = {}) {
  const stdio = quiet ? "pipe" : "inherit"
  let result = spawnSync("claude", args, { stdio })
  if (result.error?.code === "ENOENT" && process.platform === "win32") {
    const quoted = args.map((arg) => (/[\s"&|<>^]/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg))
    result = spawnSync("claude", quoted, { stdio, shell: true })
  }
  if (result.error?.code === "ENOENT") {
    console.error("Claude Code CLI (claude) was not found on PATH. Install Claude Code first.")
    process.exit(1)
  }
  if (result.error) throw result.error
  return result.status ?? 1
}

// Replace any earlier user-scope registration (an old path, for instance). Absent is fine.
claude(["mcp", "remove", NAME, "--scope", "user"], { quiet: true })

if (remove) {
  console.log(`Removed the user-scope "${NAME}" MCP server (if it was registered).`)
  process.exit(0)
}

if (!existsSync(entry)) {
  console.error(`${entry} does not exist yet. Build the MCP server first: npm run build:mcp`)
  process.exit(1)
}

const status = claude(["mcp", "add", "--scope", "user", NAME, "--", "node", entry])
if (status !== 0) process.exit(status)
console.log(
  `\nRegistered "${NAME}" for every project. Restart open Claude Code sessions to pick it up.\n` +
    `Settings come from mcp-server/.env, whichever project Claude Code is opened in.`
)
