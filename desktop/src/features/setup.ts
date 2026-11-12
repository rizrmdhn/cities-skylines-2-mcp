/**
 * First-run setup wizard backend: gets a new player from "installed the companion" to "an AI
 * client can drive my city". The wizard page (/setup) only calls these routes.
 *
 *   GET  /api/desktop/setup                  status: first run?, bridge, token, bundled server, detected clients
 *   POST /api/desktop/setup/register         { client, shareSettings }  add our server to a client's JSON config (backup + atomic write)
 *   POST /api/desktop/setup/unregister       { client }                 remove only our server from it
 *   POST /api/desktop/setup/snippet          { target, shareSettings, copy }  text to copy for a client we do not edit
 *   POST /api/desktop/setup/token/generate   { replace? }               new strong random token, saved as the companion's token
 *   POST /api/desktop/setup/token/copy       { as: "token" | "setx" }   puts the token / the setx command on the clipboard (main process)
 *   POST /api/desktop/setup/game-token       { confirm: true }          sets CS2MCP_TOKEN as a Windows user environment variable
 *   POST /api/desktop/setup/complete         marks the wizard done (also what "skip" does)
 *   POST /api/desktop/setup/reset            shows the wizard on the next launch again
 *
 * The token never reaches the renderer: it is generated, stored and copied in this process, and
 * shown only masked. Client configs are written only on an explicit register request; the token
 * (and a non-default bridge URL) goes into a client's `env` only when `shareSettings` is true.
 * Nothing here is ever sent to the bridge except GET /ping and GET /state.
 */
import { execFile } from "node:child_process"
import { dirname, resolve } from "node:path"

import { z } from "zod"

import { BridgeError } from "../bridge.ts"
import { readRepoDotenv, resolveBridgeConfig, type BridgeConfig } from "../config.ts"
import { defineFeature, type DesktopFeature } from "../context.ts"
import {
  buildLaunch,
  buildSnippet,
  claudeCodeRemoveCommand,
  clientById,
  CLIENTS,
  ConfigFileError,
  currentEnvironment,
  editConfigText,
  generateToken,
  inspectClaudeCodeFile,
  inspectConfigText,
  locateBundledServer,
  locateClient,
  readConfigFile,
  realFs,
  serverEntry,
  SERVER_NAME,
  writeConfigAtomically,
  type ClientDefinition,
  type FsProbe,
  type Inspection,
  type Launch,
  type SnippetTarget,
} from "../mcp-clients.ts"
import { RouteError } from "../routes.ts"

declare module "../settings.ts" {
  interface SettingValues {
    "setup.completed": boolean
  }
}

/** Name of the variable the game mod reads (CS2MCP.Bridge/HttpBridgeServer.cs). */
export const GAME_TOKEN_VAR = "CS2MCP_TOKEN"

/** The Windows user environment, where a Steam / Paradox launcher player sets variables for the game. */
export interface UserEnvironment {
  readonly supported: boolean
  get(name: string): Promise<string | null>
  set(name: string, value: string): Promise<void>
}

export interface Clipboard {
  writeText(text: string): void | Promise<void>
}

export interface SetupDeps {
  /** The binary a client runs as Node. */
  execPath: string
  resourcesPath: string | undefined
  /** Environment of this process (CS2_BRIDGE_URL / CS2MCP_TOKEN win over the settings, as in config.ts). */
  env: Record<string, string | undefined>
  fs: FsProbe
  userEnv: UserEnvironment
  clipboard: Clipboard
  now: () => Date
}

function run(file: string, args: string[], env?: NodeJS.ProcessEnv) {
  return new Promise<string>((resolveRun, reject) => {
    execFile(file, args, { env, windowsHide: true, timeout: 20_000 }, (error, stdout, stderr) => {
      if (error) reject(Object.assign(error, { stderr }))
      else resolveRun(stdout)
    })
  })
}

const NAME = /^[A-Z][A-Z0-9_]*$/

/** HKCU\Environment through reg.exe (read) and PowerShell (write, which also tells running programs). */
export const windowsUserEnvironment: UserEnvironment = {
  supported: process.platform === "win32",
  async get(name) {
    if (!NAME.test(name)) throw new Error(`bad variable name ${name}`)
    try {
      const out = await run("reg.exe", ["query", "HKCU\\Environment", "/v", name])
      const match = new RegExp(`^\\s*${name}\\s+REG_\\w+\\s+(.*?)\\s*$`, "mi").exec(out)
      return match ? match[1] : null
    } catch {
      return null // reg exits 1 when the value does not exist
    }
  },
  async set(name, value) {
    if (!NAME.test(name)) throw new Error(`bad variable name ${name}`)
    // The value travels in the child's environment, not on its command line.
    await run(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `[Environment]::SetEnvironmentVariable('${name}', $env:CS2MCP_SETUP_VALUE, 'User')`,
      ],
      { ...process.env, CS2MCP_SETUP_VALUE: value }
    )
  },
}

const electronClipboard: Clipboard = {
  async writeText(text) {
    const { clipboard } = await import("electron")
    clipboard.writeText(text)
  },
}

function defaultDeps(): SetupDeps {
  return {
    execPath: process.execPath,
    resourcesPath: (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath,
    env: process.env,
    fs: realFs,
    userEnv: windowsUserEnvironment,
    clipboard: electronClipboard,
    now: () => new Date(),
  }
}

// ---------------------------------------------------------------------------------------------

type BridgeLink = "ready" | "no-city" | "loading" | "disabled" | "unauthorized" | "unreachable"

interface Ping {
  version: string
  isLoading: boolean
  bridgeEnabled: boolean
  readOnly: boolean
}
interface State {
  cityLoaded: boolean
  cityName: string | null
}

const baseVersion = (version: string) => version.split("+", 1)[0].trim()

const registerBody = z.object({ client: z.string(), shareSettings: z.boolean().default(false) })
const unregisterBody = z.object({ client: z.string() })
const snippetBody = z.object({
  target: z.enum(["claude-code", "json", "vscode"]),
  shareSettings: z.boolean().default(false),
  copy: z.boolean().default(false),
})
const generateBody = z.object({ replace: z.boolean().default(false) }).default({ replace: false })
const copyBody = z.object({ as: z.enum(["token", "setx"]) })
const gameTokenBody = z.object({ confirm: z.literal(true) })

export function createSetup(overrides: Partial<SetupDeps> = {}): DesktopFeature {
  return defineFeature({
    id: "setup",
    setup(ctx) {
      const deps: SetupDeps = { ...defaultDeps(), ...overrides }
      const completed = ctx.settings.define("setup.completed", { schema: z.boolean(), default: false })
      const log = ctx.log
      const windows = ctx.platform === "win32"

      /** Config writes one after another, so two clicks cannot interleave read-modify-write. */
      let queue: Promise<unknown> = Promise.resolve()
      const serialized = <T>(job: () => Promise<T>): Promise<T> => {
        const next = queue.then(job, job)
        queue = next.catch(() => undefined)
        return next
      }

      // The repo's .env files only count next to the repo (same rule as main.ts).
      const dotenv = ctx.isPackaged ? {} : readRepoDotenv(resolve(dirname(ctx.paths.renderer), "..", ".."))
      const effective = (): BridgeConfig =>
        resolveBridgeConfig({
          env: deps.env,
          settings: { bridgeUrl: ctx.settings.get("bridgeUrl"), token: ctx.settings.get("token") },
          dotenv,
        })

      const server = () =>
        locateBundledServer({
          distDir: dirname(ctx.paths.renderer),
          isPackaged: ctx.isPackaged,
          resourcesPath: deps.resourcesPath,
          exists: deps.fs.exists,
        })

      /** The launch for the bundled server, or a 409 saying why there is none. */
      function launchFor(shareSettings: boolean): Launch {
        const located = server()
        if (!located.file) throw new RouteError(409, located.problem ?? "the bundled MCP server was not found")
        const config = effective()
        return buildLaunch(
          deps.execPath,
          located.file,
          shareSettings ? { bridgeUrl: config.bridgeUrl, token: config.token || undefined } : {}
        )
      }

      async function bridgeStatus() {
        const config = ctx.bridgeConfig()
        const base = { url: config.bridgeUrl, appVersion: ctx.version }
        let ping: Ping
        try {
          ping = await ctx.bridge.get<Ping>("/ping")
        } catch (err) {
          const message = err instanceof BridgeError ? err.message : String(err)
          return { ...base, link: "unreachable" as BridgeLink, modVersion: null, versionMismatch: false, readOnly: false, city: null, error: message }
        }
        const common = {
          ...base,
          modVersion: ping.version,
          versionMismatch: baseVersion(ping.version) !== baseVersion(ctx.version),
          readOnly: ping.readOnly,
          error: null,
        }
        if (!ping.bridgeEnabled) return { ...common, link: "disabled" as BridgeLink, city: null }
        if (ping.isLoading) return { ...common, link: "loading" as BridgeLink, city: null }
        // /ping needs no token; /state does, so it tells whether the configured token is accepted.
        try {
          const state = await ctx.bridge.get<State>("/state")
          return { ...common, link: (state.cityLoaded ? "ready" : "no-city") as BridgeLink, city: state.cityName }
        } catch (err) {
          if (err instanceof BridgeError && err.status === 401) {
            return { ...common, link: "unauthorized" as BridgeLink, city: null, error: err.message }
          }
          return { ...common, link: "no-city" as BridgeLink, city: null }
        }
      }

      async function gameTokenStatus(token: string) {
        if (!deps.userEnv.supported) return { supported: false, state: "unsupported" as const }
        const value = await deps.userEnv.get(GAME_TOKEN_VAR).catch(() => undefined)
        if (value === undefined) return { supported: true, state: "unknown" as const }
        if (value === null) return { supported: true, state: "unset" as const }
        if (!token) return { supported: true, state: "set" as const }
        return { supported: true, state: (value === token ? "matches" : "different") as "matches" | "different" }
      }

      async function inspectClient(client: ClientDefinition, launch: Launch | null) {
        const location = locateClient(client, currentEnvironment(deps.env), deps.fs)
        const row = {
          id: client.id,
          name: client.name,
          mode: client.mode,
          detected: location.detected,
          configPath: location.configPath,
          note: location.note ?? null,
          configExists: false,
          state: "none" as Inspection["state"] | "unreadable",
          entry: null as Inspection["entry"] | null,
          problem: null as string | null,
        }
        try {
          if (client.mode === "command") {
            const found = inspectClaudeCodeFile(location.configPath, launch, windows)
            row.configExists = found !== null
            if (found) Object.assign(row, { state: found.state, entry: found.entry ?? null })
          } else {
            const text = await readConfigFile(location.configPath)
            row.configExists = text !== null
            if (text !== null) {
              const found = inspectConfigText(text, client, launch, windows)
              Object.assign(row, { state: found.state, entry: found.entry ?? null })
            }
          }
        } catch (err) {
          row.state = "unreadable"
          row.problem = err instanceof ConfigFileError ? err.message : `The file could not be read: ${(err as Error).message}`
        }
        return row
      }

      ctx.routes.get("/desktop/setup", async () => {
        const config = effective()
        const located = server()
        let launch: Launch | null = null
        if (located.file) launch = buildLaunch(deps.execPath, located.file)
        const [bridge, gameEnv, clients] = await Promise.all([
          bridgeStatus(),
          gameTokenStatus(config.token),
          Promise.all(CLIENTS.map((client) => inspectClient(client, launch))),
        ])
        return {
          completed: completed.get(),
          platform: ctx.platform,
          bridge,
          token: {
            set: config.token !== "",
            source: config.tokenSource,
            /** Whether the companion can replace it (false when the process environment provides it). */
            replaceable: config.tokenSource !== "env",
            secretsEncrypted: ctx.settings.secretsEncrypted,
            gameEnv,
          },
          server: {
            found: located.file !== null,
            file: located.file,
            searched: located.searched,
            problem: located.problem,
            mode: ctx.isPackaged ? "packaged" : "dev",
            command: launch?.command ?? deps.execPath,
            args: launch?.args ?? [],
            env: { ELECTRON_RUN_AS_NODE: "1" },
            serverName: SERVER_NAME,
          },
          clients,
        }
      })

      ctx.routes.post("/desktop/setup/register", (request) => {
        const body = request.parse(registerBody)
        return serialized(async () => {
          const client = clientById(body.client)
          if (!client) throw new RouteError(400, `unknown client "${body.client}"`)
          if (client.mode !== "json") {
            throw new RouteError(400, `${client.name} is configured with its own command; use the snippet route`)
          }
          const location = locateClient(client, currentEnvironment(deps.env), deps.fs)
          if (!location.detected) {
            throw new RouteError(409, `${client.name} does not seem to be installed (no settings folder for ${location.configPath}). Copy the snippet instead.`)
          }
          const launch = launchFor(body.shareSettings)
          const before = await readConfigFile(location.configPath)
          let edit
          try {
            edit = editConfigText(before ?? "", client, serverEntry(client, launch))
          } catch (err) {
            if (err instanceof ConfigFileError) throw new RouteError(422, err.message)
            throw err
          }
          let backup: string | null = null
          if (edit.change !== "unchanged") {
            try {
              backup = (await writeConfigAtomically(location.configPath, edit.text, before, deps.now())).backup
            } catch (err) {
              if (err instanceof ConfigFileError) throw new RouteError(409, err.message)
              throw new RouteError(500, `could not write ${location.configPath}: ${(err as Error).message}`)
            }
          }
          log.info(`register ${client.id}: ${edit.change} (${location.configPath}), env keys: ${Object.keys(launch.env).join(", ")}`)
          return {
            client: client.id,
            name: client.name,
            change: edit.change,
            configPath: location.configPath,
            backup,
            envKeys: Object.keys(launch.env),
            restart: `Restart ${client.name} completely (quit it from its tray icon too) so it starts the server.`,
          }
        })
      })

      ctx.routes.post("/desktop/setup/unregister", (request) => {
        const body = request.parse(unregisterBody)
        return serialized(async () => {
          const client = clientById(body.client)
          if (!client) throw new RouteError(400, `unknown client "${body.client}"`)
          if (client.mode !== "json") {
            return { client: client.id, name: client.name, change: "manual", command: claudeCodeRemoveCommand(), configPath: null, backup: null }
          }
          const location = locateClient(client, currentEnvironment(deps.env), deps.fs)
          const before = await readConfigFile(location.configPath)
          if (before === null) return { client: client.id, name: client.name, change: "unchanged", configPath: location.configPath, backup: null }
          let edit
          try {
            edit = editConfigText(before, client, null)
          } catch (err) {
            if (err instanceof ConfigFileError) throw new RouteError(422, err.message)
            throw err
          }
          let backup: string | null = null
          if (edit.change !== "unchanged") {
            try {
              backup = (await writeConfigAtomically(location.configPath, edit.text, before, deps.now())).backup
            } catch (err) {
              if (err instanceof ConfigFileError) throw new RouteError(409, err.message)
              throw new RouteError(500, `could not write ${location.configPath}: ${(err as Error).message}`)
            }
          }
          log.info(`unregister ${client.id}: ${edit.change} (${location.configPath})`)
          return { client: client.id, name: client.name, change: edit.change, configPath: location.configPath, backup }
        })
      })

      ctx.routes.post("/desktop/setup/snippet", async (request) => {
        const body = request.parse(snippetBody)
        const real = launchFor(body.shareSettings)
        const shown = buildSnippet(body.target as SnippetTarget, real, true)
        if (body.copy) {
          await deps.clipboard.writeText(buildSnippet(body.target as SnippetTarget, real, false).text)
          log.info(`copied the ${body.target} snippet (token included: ${Boolean(real.env.CS2MCP_TOKEN)})`)
        }
        return { ...shown, copied: body.copy, includesToken: Boolean(real.env.CS2MCP_TOKEN) }
      })

      ctx.routes.post("/desktop/setup/token/generate", async (request) => {
        const body = generateBody.parse(request.body ?? {})
        const config = effective()
        if (config.tokenSource === "env") {
          throw new RouteError(409, "CS2MCP_TOKEN is set in this app's environment and overrides the saved token. Remove it there first.")
        }
        if (config.token && !body.replace) {
          throw new RouteError(409, "a token is already set; pass replace to generate a new one (the game and every client then need the new value)")
        }
        await ctx.settings.set("token", generateToken())
        log.info("generated a new token and saved it as the companion's token")
        return { generated: true, tokenSet: true }
      })

      ctx.routes.post("/desktop/setup/token/copy", async (request) => {
        const body = request.parse(copyBody)
        const { token } = effective()
        if (!token) throw new RouteError(409, "no token is set")
        await deps.clipboard.writeText(body.as === "token" ? token : `setx ${GAME_TOKEN_VAR} "${token}"`)
        log.info(`copied the token to the clipboard (${body.as})`)
        return { copied: true, as: body.as }
      })

      ctx.routes.post("/desktop/setup/game-token", async (request) => {
        request.parse(gameTokenBody)
        if (!deps.userEnv.supported) throw new RouteError(409, "setting a user environment variable is only supported on Windows")
        const { token } = effective()
        if (!token) throw new RouteError(409, "no token is set")
        try {
          await deps.userEnv.set(GAME_TOKEN_VAR, token)
        } catch (err) {
          log.warn(`could not set ${GAME_TOKEN_VAR} for the user: ${(err as Error).message}`)
          throw new RouteError(500, `could not set the user environment variable: ${(err as Error).message}`)
        }
        log.info(`set the ${GAME_TOKEN_VAR} user environment variable`)
        return {
          set: true,
          restart:
            "Programs started from now on get the variable. Cities: Skylines II inherits it from the launcher that starts it: " +
            "quit Steam (or the Paradox launcher) completely, start it again, then start the game.",
        }
      })

      ctx.routes.post("/desktop/setup/complete", async () => {
        await completed.set(true)
        return { completed: true }
      })
      ctx.routes.post("/desktop/setup/reset", async () => {
        await completed.set(false)
        return { completed: false }
      })
    },
  })
}

export default createSetup()
