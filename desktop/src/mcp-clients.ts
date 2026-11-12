/**
 * Everything the setup wizard needs to know about MCP clients, Electron-free (Node only):
 *   - where the bundled MCP server file is and the exact command an MCP client runs for it,
 *   - which clients are installed and where their config lives,
 *   - reading one client's JSON config, adding / removing only our server entry, writing it back
 *     atomically with a backup next to it,
 *   - the copy-paste snippets for clients we do not edit.
 *
 * The launch command is the app's own Electron binary used as Node, so a client needs no Node.js:
 *
 *   command: "<install dir>\CS2MCP Companion.exe"          (dev: ...\node_modules\electron\dist\electron.exe)
 *   args:    ["<install dir>\resources\app.asar.unpacked\dist\mcp-server\bin\index.mjs"]
 *   env:     { "ELECTRON_RUN_AS_NODE": "1", [ "CS2_BRIDGE_URL": ..., "CS2MCP_TOKEN": ... ] }
 *
 * The server file must be a real file (a client starts a separate process, which cannot read from
 * inside app.asar), so see locateBundledServer for where it is looked for.
 */
import { randomBytes } from "node:crypto"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

/** The name the server is registered under; scripts/mcp-register.mjs and .mcp.json use the same. */
export const SERVER_NAME = "cs2"
/** Where the bundled server file sits below desktop/dist (and below resources/ or app.asar.unpacked/dist when packaged). */
export const SERVER_FILE_PARTS = ["mcp-server", "bin", "index.mjs"] as const
export const DEFAULT_BRIDGE_URL = "http://127.0.0.1:8642"

// ---------------------------------------------------------------------------------------------
// The bundled server and the command that starts it
// ---------------------------------------------------------------------------------------------

export interface ServerLocation {
  /** Absolute path of a bundled server file that exists on the real filesystem, or null. */
  file: string | null
  /** Every place that was tried, in order. */
  searched: string[]
  /** Why no file was found, for the wizard to show; null when found. */
  problem: string | null
}

export interface LocateOptions {
  /** The folder holding main.cjs (dist/); inside app.asar when packaged. */
  distDir: string
  isPackaged: boolean
  /** process.resourcesPath (the electron-builder `extraResources` target). */
  resourcesPath?: string
  exists?: (path: string) => boolean
}

/** A path that points into an asar archive: another process cannot open it. */
export function isInsideAsar(path: string) {
  return /\.asar(?=[\\/]|$)/i.test(path)
}

/**
 * Candidates, first existing real file wins:
 *   1. <resources>/mcp-server/bin/index.mjs              electron-builder `extraResources` (packaged only)
 *   2. <app>/app.asar.unpacked/dist/mcp-server/bin/...   electron-builder `asarUnpack: dist/mcp-server/**` (packaged only)
 *   3. <dist>/mcp-server/bin/index.mjs                   a normal build (`npm run desktop`), never inside an archive
 */
export function locateBundledServer({ distDir, isPackaged, resourcesPath, exists = existsSync }: LocateOptions): ServerLocation {
  const candidates: string[] = []
  const rel = join(...SERVER_FILE_PARTS)
  if (isPackaged && resourcesPath) candidates.push(join(resourcesPath, rel))
  if (isInsideAsar(distDir)) {
    candidates.push(join(distDir.replace(/\.asar(?=[\\/]|$)/i, ".asar.unpacked"), rel))
  } else {
    candidates.push(join(distDir, rel))
  }
  const real = candidates.filter((candidate) => !isInsideAsar(candidate))
  const file = real.find((candidate) => exists(candidate)) ?? null
  return {
    file,
    searched: real,
    problem: file
      ? null
      : isPackaged
        ? "The bundled MCP server file is missing from this installation. The packaging has to ship dist/mcp-server outside app.asar " +
          "(electron-builder asarUnpack \"dist/mcp-server/**\" or extraResources). Reinstall a build that includes it."
        : "The bundled MCP server is not built. Run `npm run desktop:build` (or `node scripts/build.mjs` in desktop/) first.",
  }
}

export interface Launch {
  command: string
  args: string[]
  env: Record<string, string>
}

export interface SharedSettings {
  /** Only passed when the user agreed and it differs from the default. */
  bridgeUrl?: string
  token?: string
}

/** The stdio command an MCP client runs. `env` carries ELECTRON_RUN_AS_NODE and, if shared, the bridge URL and token. */
export function buildLaunch(execPath: string, serverFile: string, shared: SharedSettings = {}): Launch {
  const env: Record<string, string> = { ELECTRON_RUN_AS_NODE: "1" }
  if (shared.bridgeUrl && shared.bridgeUrl !== DEFAULT_BRIDGE_URL) env.CS2_BRIDGE_URL = shared.bridgeUrl
  if (shared.token) env.CS2MCP_TOKEN = shared.token
  return { command: execPath, args: [serverFile], env }
}

// ---------------------------------------------------------------------------------------------
// Clients
// ---------------------------------------------------------------------------------------------

export type ClientId = "claude-desktop" | "claude-code" | "codex" | "gemini-cli" | "cursor" | "vscode"

export interface ClientDefinition {
  id: ClientId
  name: string
  /** "json": we edit the file. "command": the client has its own CLI, we hand out the command. */
  mode: "json" | "command"
  /** Top-level object holding the servers. */
  key: "mcpServers" | "servers"
  /** The entry carries `"type": "stdio"` (Cursor and VS Code document it as required). */
  typeField: boolean
}

export const CLIENTS: readonly ClientDefinition[] = [
  { id: "claude-desktop", name: "Claude Desktop", mode: "json", key: "mcpServers", typeField: false },
  { id: "claude-code", name: "Claude Code", mode: "command", key: "mcpServers", typeField: false },
  { id: "codex", name: "Codex (OpenAI)", mode: "command", key: "mcpServers", typeField: false },
  { id: "gemini-cli", name: "Gemini CLI", mode: "command", key: "mcpServers", typeField: false },
  { id: "cursor", name: "Cursor", mode: "json", key: "mcpServers", typeField: true },
  { id: "vscode", name: "VS Code (default profile)", mode: "json", key: "servers", typeField: true },
]

export function clientById(id: string): ClientDefinition | undefined {
  return CLIENTS.find((client) => client.id === id)
}

export interface ClientEnvironment {
  home: string
  appData: string
  localAppData: string
  /** CLAUDE_CONFIG_DIR, which relocates Claude Code's ~/.claude.json */
  claudeConfigDir?: string
  /** CODEX_HOME, which relocates Codex's ~/.codex folder */
  codexHome?: string
}

export function currentEnvironment(env: Record<string, string | undefined> = process.env): ClientEnvironment {
  const home = env.USERPROFILE || env.HOME || homedir()
  return {
    home,
    appData: env.APPDATA || join(home, "AppData", "Roaming"),
    localAppData: env.LOCALAPPDATA || join(home, "AppData", "Local"),
    claudeConfigDir: env.CLAUDE_CONFIG_DIR || undefined,
    codexHome: env.CODEX_HOME || undefined,
  }
}

export interface ClientLocation {
  /** The config file we read and, for "json" clients, write. */
  configPath: string
  /** The client looks installed (its settings folder exists). Registration is refused when false. */
  detected: boolean
  /** Shown next to the client when relevant. */
  note?: string
}

export interface FsProbe {
  exists(path: string): boolean
  list(path: string): string[]
}

export const realFs: FsProbe = {
  exists: (path) => existsSync(path),
  list: (path) => {
    try {
      return readdirSync(path)
    } catch {
      return []
    }
  },
}

/**
 * Default config locations on Windows, from each client's documentation:
 *   Claude Desktop  %APPDATA%\Claude\claude_desktop_config.json              (modelcontextprotocol.io "Connect to local MCP servers")
 *                   Microsoft Store (MSIX) installs read a virtualised copy instead:
 *                   %LOCALAPPDATA%\Packages\Claude_*\LocalCache\Roaming\Claude\claude_desktop_config.json   (anthropics/claude-code#26073, user reports)
 *   Claude Code     user scope lives in ~/.claude.json (code.claude.com/docs/en/mcp); we only read it
 *   Codex           ~/.codex/config.toml (CODEX_HOME relocates it), table [mcp_servers.<name>]; `codex mcp add` writes it; we only read it
 *   Gemini CLI      ~/.gemini/settings.json, "mcpServers"; `gemini mcp add` writes it; we only read it
 *   Cursor          ~/.cursor/mcp.json                                       (cursor.com/docs/context/mcp)
 *   VS Code         %APPDATA%\Code\User\mcp.json, top-level "servers"       (code.visualstudio.com mcp docs name the "servers" key and the
 *                   "MCP: Open User Configuration" command; the folder is the default profile's user data folder)
 */
export function locateClient(client: ClientDefinition, env: ClientEnvironment, fs: FsProbe = realFs): ClientLocation {
  switch (client.id) {
    case "claude-desktop": {
      const standard = join(env.appData, "Claude")
      const packages = join(env.localAppData, "Packages")
      const msix = fs
        .list(packages)
        .filter((name) => /^Claude_/i.test(name))
        .map((name) => join(packages, name, "LocalCache", "Roaming", "Claude"))
        .filter((dir) => fs.exists(dir))
      const file = (dir: string) => join(dir, "claude_desktop_config.json")
      const chosen =
        msix.find((dir) => fs.exists(file(dir))) ??
        (fs.exists(file(standard)) ? standard : undefined) ??
        msix[0] ??
        standard
      const isMsix = msix.includes(chosen)
      return {
        configPath: file(chosen),
        detected: fs.exists(chosen),
        note: isMsix
          ? "Microsoft Store install: Claude Desktop reads the copy under %LOCALAPPDATA%\\Packages, not %APPDATA%\\Claude."
          : undefined,
      }
    }
    case "claude-code": {
      const base = env.claudeConfigDir ?? env.home
      const configPath = join(base, ".claude.json")
      return {
        configPath,
        detected: fs.exists(configPath) || fs.exists(join(env.claudeConfigDir ?? join(env.home, ".claude"))),
      }
    }
    case "codex": {
      const dir = env.codexHome ?? join(env.home, ".codex")
      return { configPath: join(dir, "config.toml"), detected: fs.exists(dir) }
    }
    case "gemini-cli": {
      const dir = join(env.home, ".gemini")
      return { configPath: join(dir, "settings.json"), detected: fs.exists(dir) }
    }
    case "cursor":
      return { configPath: join(env.home, ".cursor", "mcp.json"), detected: fs.exists(join(env.home, ".cursor")) }
    case "vscode": {
      const dir = join(env.appData, "Code", "User")
      return {
        configPath: join(dir, "mcp.json"),
        detected: fs.exists(dir),
        note: "Only the default profile. Other profiles and workspace .vscode/mcp.json files are not touched.",
      }
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Reading and editing a client's JSON config
// ---------------------------------------------------------------------------------------------

/** The file cannot be edited safely (not JSON, unexpected shape). The message says what to do. */
export class ConfigFileError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ConfigFileError"
  }
}

type Json = Record<string, unknown>
const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value)

interface Parsed {
  root: Json
  bom: boolean
  indent: string | number
  eol: string
}

function parseConfig(text: string): Parsed {
  const bom = text.charCodeAt(0) === 0xfeff
  const body = bom ? text.slice(1) : text
  const eol = body.includes("\r\n") ? "\r\n" : "\n"
  // First indented line decides the indentation style; a new or one-line file gets 2 spaces.
  const lead = /^([ \t]+)\S/m.exec(body)?.[1]
  const indent: string | number = lead ? (lead.startsWith("\t") ? "\t" : lead.length) : 2
  if (body.trim() === "") return { root: {}, bom, indent, eol }
  let value: unknown
  try {
    value = JSON.parse(body)
  } catch (err) {
    throw new ConfigFileError(
      `The file is not valid JSON (${(err as Error).message}). It was not changed. Fix it (comments are not allowed), ` +
        `or copy the snippet and add it yourself.`
    )
  }
  if (!isObject(value)) throw new ConfigFileError("The file does not contain a JSON object at the top level. It was not changed.")
  return { root: value, bom, indent, eol }
}

function serialize({ root, bom, indent, eol }: Parsed) {
  return (bom ? "﻿" : "") + JSON.stringify(root, null, indent).replace(/\n/g, eol) + eol
}

/** What goes into the client's server list for this launch. */
export function serverEntry(client: ClientDefinition, launch: Launch): Json {
  return {
    ...(client.typeField ? { type: "stdio" } : {}),
    command: launch.command,
    args: launch.args,
    env: launch.env,
  }
}

export type EntryState = "none" | "current" | "outdated"

export interface EntrySummary {
  command: string | null
  args: string[]
  /** Names only: env values may be a token. */
  envKeys: string[]
}

export interface Inspection {
  state: EntryState
  entry?: EntrySummary
}

const sameText = (a: string, b: string, caseInsensitive: boolean) =>
  caseInsensitive ? a.toLowerCase() === b.toLowerCase() : a === b

/** Looks for our entry in parsed text. `current` = the same command and server file as `launch`. */
export function inspectConfigText(text: string, client: ClientDefinition, launch: Launch | null, windows = true): Inspection {
  const { root } = parseConfig(text)
  const servers = root[client.key]
  if (servers === undefined) return { state: "none" }
  if (!isObject(servers)) throw new ConfigFileError(`"${client.key}" in the file is not an object. It was not changed.`)
  const entry = servers[SERVER_NAME]
  if (entry === undefined) return { state: "none" }
  const record = isObject(entry) ? entry : {}
  const args = Array.isArray(record.args) ? record.args.map(String) : []
  const command = typeof record.command === "string" ? record.command : null
  const summary: EntrySummary = { command, args, envKeys: isObject(record.env) ? Object.keys(record.env) : [] }
  const current =
    launch !== null &&
    command !== null &&
    sameText(command, launch.command, windows) &&
    args.length === launch.args.length &&
    args.every((arg, index) => sameText(arg, launch.args[index], windows))
  return { state: current ? "current" : "outdated", entry: summary }
}

export interface EditResult {
  text: string
  change: "added" | "updated" | "removed" | "unchanged"
}

/**
 * Adds, replaces (`entry` given) or removes (`entry` null) only the `cs2` server in the client's
 * server list. Every other key and entry is kept in its order; indentation, line endings and a BOM
 * are kept. Throws ConfigFileError for text that is not a JSON object.
 */
export function editConfigText(text: string, client: ClientDefinition, entry: Json | null): EditResult {
  const parsed = parseConfig(text)
  const { root } = parsed
  const existing = root[client.key]
  if (existing !== undefined && !isObject(existing)) {
    throw new ConfigFileError(`"${client.key}" in the file is not an object. It was not changed.`)
  }
  const servers: Json = existing ?? {}
  const previous = servers[SERVER_NAME]
  if (entry === null) {
    if (previous === undefined) return { text, change: "unchanged" }
    delete servers[SERVER_NAME]
    return { text: serialize(parsed), change: "removed" }
  }
  if (previous !== undefined && JSON.stringify(previous) === JSON.stringify(entry)) return { text, change: "unchanged" }
  servers[SERVER_NAME] = entry
  root[client.key] = servers
  return { text: serialize(parsed), change: previous === undefined ? "added" : "updated" }
}

// ---------------------------------------------------------------------------------------------
// Writing: backup next to the file, atomic replace
// ---------------------------------------------------------------------------------------------

export function backupName(path: string, now = new Date()) {
  const pad = (n: number) => String(n).padStart(2, "0")
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-` +
    `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  return `${path}.cs2mcp-backup-${stamp}`
}

/** Reads a config file; null when it does not exist. */
export async function readConfigFile(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8")
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null
    throw err
  }
}

export interface WriteOutcome {
  backup: string | null
}

/**
 * Replaces `path` with `text` through a temp file in the same folder and a rename. The original
 * is copied to `<file>.cs2mcp-backup-<time>` first. `expected` is the text that was read: if the
 * file changed meanwhile (the client rewrote it) nothing is written.
 */
export async function writeConfigAtomically(path: string, text: string, expected: string | null, now = new Date()): Promise<WriteOutcome> {
  await mkdir(dirname(path), { recursive: true })
  let backup: string | null = null
  if (expected !== null) {
    backup = backupName(path, now)
    await copyFile(path, backup)
  }
  const temp = `${path}.cs2mcp-tmp-${process.pid}-${randomBytes(3).toString("hex")}`
  try {
    await writeFile(temp, text, "utf8")
    if ((await readConfigFile(path)) !== expected) {
      throw new ConfigFileError("The file changed while it was being edited (the client rewrote it?). Nothing was written; try again.")
    }
    await rename(temp, path)
  } catch (err) {
    await rm(temp, { force: true })
    throw err
  }
  return { backup }
}

// ---------------------------------------------------------------------------------------------
// Claude Code (its own CLI) and copy-paste snippets
// ---------------------------------------------------------------------------------------------

/** TOML string literals ("basic" with escapes, or 'literal') in order of appearance. */
function tomlStrings(text: string): string[] {
  const out: string[] = []
  for (const match of text.matchAll(/"((?:[^"\\\n]|\\.)*)"|'([^'\n]*)'/g)) {
    if (match[2] !== undefined) out.push(match[2])
    else {
      try {
        out.push(JSON.parse(`"${match[1]}"`) as string)
      } catch {
        out.push(match[1])
      }
    }
  }
  return out
}

/**
 * Looks for `[mcp_servers.cs2]` in Codex's config.toml (read only; not a TOML parser, just enough
 * to find our table, its command / args and the names of its env variables).
 */
export function inspectCodexText(text: string, launch: Launch | null, windows = true): Inspection {
  const header = new RegExp(`^[ \\t]*\\[\\s*mcp_servers\\s*\\.\\s*(?:"${SERVER_NAME}"|${SERVER_NAME})\\s*\\][ \\t]*(?:#.*)?$`, "m").exec(text)
  if (!header) return { state: "none" }
  const rest = text.slice(header.index + header[0].length)
  const next = /^[ \t]*\[/m.exec(rest)
  const body = next ? rest.slice(0, next.index) : rest
  const commandLine = /^[ \t]*command[ \t]*=[ \t]*(.+)$/m.exec(body)
  const command = commandLine ? (tomlStrings(commandLine[1])[0] ?? null) : null
  const argsMatch = /^[ \t]*args[ \t]*=[ \t]*\[([\s\S]*?)\]/m.exec(body)
  const args = argsMatch ? tomlStrings(argsMatch[1]) : []
  const envKeys = new Set<string>()
  const inline = /^[ \t]*env[ \t]*=[ \t]*\{([^}]*)\}/m.exec(body)
  if (inline) for (const key of inline[1].matchAll(/([A-Za-z_][A-Za-z0-9_]*)[ \t]*=/g)) envKeys.add(key[1])
  const envTable = new RegExp(`^[ \\t]*\\[\\s*mcp_servers\\s*\\.\\s*(?:"${SERVER_NAME}"|${SERVER_NAME})\\s*\\.\\s*env\\s*\\][ \\t]*$`, "m").exec(text)
  if (envTable) {
    const after = text.slice(envTable.index + envTable[0].length)
    const stop = /^[ \t]*\[/m.exec(after)
    for (const key of (stop ? after.slice(0, stop.index) : after).matchAll(/^[ \t]*([A-Za-z_][A-Za-z0-9_]*)[ \t]*=/gm)) envKeys.add(key[1])
  }
  const summary: EntrySummary = { command, args, envKeys: [...envKeys] }
  const current =
    launch !== null &&
    command !== null &&
    sameText(command, launch.command, windows) &&
    args.length === launch.args.length &&
    args.every((arg, index) => sameText(arg, launch.args[index], windows))
  return { state: current ? "current" : "outdated", entry: summary }
}

/**
 * Reads the config of a client with its own CLI (never written) and reports our entry.
 * null when the file does not exist.
 */
export function inspectCommandClientFile(client: ClientDefinition, path: string, launch: Launch | null, windows = true): Inspection | null {
  let text: string
  try {
    text = readFileSync(path, "utf8")
  } catch {
    return null
  }
  return client.id === "codex" ? inspectCodexText(text, launch, windows) : inspectConfigText(text, client, launch, windows)
}

/** Double quotes only when needed; works as a PowerShell or cmd argument. */
export function quoteArg(value: string) {
  return /[\s"&|<>^()%!;,]/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value
}

export type SnippetTarget = "claude-code" | "codex" | "codex-toml" | "gemini-cli" | "json" | "vscode"

export interface Snippet {
  target: SnippetTarget
  title: string
  language: "powershell" | "json" | "toml"
  text: string
  where: string
}

/**
 * `maskToken` replaces the token's value for display; the real text is only ever built in the
 * main process (copy goes through the main process clipboard).
 */
export function buildSnippet(target: SnippetTarget, launch: Launch, maskToken: boolean): Snippet {
  const env = maskToken && launch.env.CS2MCP_TOKEN ? { ...launch.env, CS2MCP_TOKEN: "<your token, hidden here>" } : launch.env
  const shown: Launch = { ...launch, env }
  switch (target) {
    case "claude-code": {
      // --env is variadic: another option must sit between the last --env pair and the name.
      const envArgs = Object.entries(shown.env).map(([name, value]) => `--env ${quoteArg(`${name}=${value}`)}`)
      return {
        target,
        title: "Claude Code command",
        language: "powershell",
        where: "Run it once in PowerShell or a command prompt. It adds the server for every project (user scope).",
        text: `claude mcp add ${envArgs.join(" ")} --transport stdio --scope user ${SERVER_NAME} -- ${[shown.command, ...shown.args].map(quoteArg).join(" ")}`,
      }
    }
    case "codex": {
      const envArgs = Object.entries(shown.env).map(([name, value]) => `--env ${quoteArg(`${name}=${value}`)}`)
      return {
        target,
        title: "Codex command",
        language: "powershell",
        where: "Run it once in PowerShell or a command prompt. Codex CLI and the Codex IDE extension share the entry (it goes into ~/.codex/config.toml).",
        text: `codex mcp add ${SERVER_NAME} ${envArgs.join(" ")} -- ${[shown.command, ...shown.args].map(quoteArg).join(" ")}`,
      }
    }
    case "codex-toml": {
      const str = (value: string) => JSON.stringify(value)
      const envInline = Object.entries(shown.env).map(([name, value]) => `${name} = ${str(value)}`)
      return {
        target,
        title: "Codex config.toml entry",
        language: "toml",
        where: "Add this table to ~/.codex/config.toml (%USERPROFILE%\\.codex\\config.toml) and restart Codex. Use it when `codex mcp add` is not available.",
        text: [
          `[mcp_servers.${SERVER_NAME}]`,
          `command = ${str(shown.command)}`,
          `args = [${shown.args.map(str).join(", ")}]`,
          `env = { ${envInline.join(", ")} }`,
        ].join("\n"),
      }
    }
    case "gemini-cli": {
      // -e is variadic in yargs: another option must sit between the last -e pair and the name.
      const envArgs = Object.entries(shown.env).map(([name, value]) => `-e ${quoteArg(`${name}=${value}`)}`)
      return {
        target,
        title: "Gemini CLI command",
        language: "powershell",
        where: "Run it once in PowerShell or a command prompt. It adds the server for every project (user scope, ~/.gemini/settings.json).",
        text: `gemini mcp add ${envArgs.join(" ")} --scope user ${SERVER_NAME} ${[shown.command, ...shown.args].map(quoteArg).join(" ")}`,
      }
    }
    case "json":
      return {
        target,
        title: "MCP server entry (JSON)",
        language: "json",
        where: 'Add the "cs2" entry to the "mcpServers" object of the client\'s MCP settings (Claude Desktop: Settings > Developer > Edit Config), then restart the client.',
        text: JSON.stringify({ mcpServers: { [SERVER_NAME]: { command: shown.command, args: shown.args, env: shown.env } } }, null, 2),
      }
    case "vscode":
      return {
        target,
        title: "VS Code mcp.json entry",
        language: "json",
        where: 'Run "MCP: Open User Configuration" in VS Code and add the "cs2" entry to "servers".',
        text: JSON.stringify({ servers: { [SERVER_NAME]: { type: "stdio", command: shown.command, args: shown.args, env: shown.env } } }, null, 2),
      }
  }
}

/** The CLI command that removes our server from a client with its own CLI. */
export function removeCommandFor(clientId: ClientId): string | null {
  switch (clientId) {
    case "claude-code":
      return `claude mcp remove ${SERVER_NAME} --scope user`
    case "codex":
      return `codex mcp remove ${SERVER_NAME}`
    case "gemini-cli":
      return `gemini mcp remove --scope user ${SERVER_NAME}`
    default:
      return null
  }
}

// ---------------------------------------------------------------------------------------------
// The token
// ---------------------------------------------------------------------------------------------

/** 256 random bits, URL-safe (letters, digits, - and _), so it needs no quoting anywhere. */
export function generateToken() {
  return randomBytes(32).toString("base64url")
}
