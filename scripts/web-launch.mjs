#!/usr/bin/env node
/**
 * Starts the web companion in the background (no console window) and opens it in the browser.
 * The desktop shortcut runs this; it also backs the root npm scripts:
 *
 *   node scripts/web-launch.mjs            start if needed, then open the browser   (npm run web:open)
 *   node scripts/web-launch.mjs --restart  stop the background server, start it again (npm run web:restart)
 *   node scripts/web-launch.mjs --stop     stop the background server               (npm run web:stop)
 *   --gui                                  report errors in a message box (used by the shortcut)
 *
 * A server that is already running is reused when it reports the current build's version
 * (X-CS2MCP-Companion header); an older one is restarted.
 */
import { spawn, spawnSync } from "node:child_process"
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { fileURLToPath, pathToFileURL } from "node:url"

const webDir = fileURLToPath(new URL("../web/", import.meta.url))
const serverEntry = fileURLToPath(new URL("../web/dist-server/index.js", import.meta.url))
const appEntry = fileURLToPath(new URL("../web/dist/index.html", import.meta.url))
const runtimeDir = fileURLToPath(new URL("../web/.runtime/", import.meta.url))
const pidFile = `${runtimeDir}companion.pid`
const logFile = `${runtimeDir}companion.log`

const args = new Set(process.argv.slice(2))
const gui = args.has("--gui")
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function fail(message) {
  console.error(message)
  if (gui && process.platform === "win32") {
    const text = message.replace(/'/g, "''")
    spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        `Add-Type -AssemblyName System.Windows.Forms; [void][System.Windows.Forms.MessageBox]::Show('${text}', 'CS2MCP Companion', 'OK', 'Error')`,
      ],
      { windowsHide: true }
    )
  }
  process.exit(1)
}

if (!existsSync(serverEntry) || !existsSync(appEntry)) {
  fail("The web companion is not built yet. In the repository folder run: npm run build:web")
}

const { loadConfig } = await import(pathToFileURL(fileURLToPath(new URL("../web/dist-server/config.js", import.meta.url))).href)
let config
try {
  config = loadConfig()
} catch (err) {
  fail(`Could not read the web companion settings: ${err.message}`)
}
const url = `http://127.0.0.1:${config.port}/`

/** What answers on the companion port: { ours, version } or null when nothing does. */
async function probe() {
  try {
    const response = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(1_500) })
    const version = response.headers.get("x-cs2mcp-companion")
    return { ours: version !== null, version }
  } catch {
    return null
  }
}

function readPid() {
  try {
    const pid = Number(readFileSync(pidFile, "utf8").trim())
    if (!Number.isInteger(pid) || pid <= 0) return undefined
    process.kill(pid, 0) // throws when the process is gone
    return pid
  } catch {
    rmSync(pidFile, { force: true })
    return undefined
  }
}

async function stop() {
  const pid = readPid()
  if (pid === undefined) return false
  // A stale pid file may name a process that has since reused the number: only stop it while our
  // companion is what answers on the port.
  if (!(await probe())?.ours) {
    rmSync(pidFile, { force: true })
    return false
  }
  try {
    process.kill(pid)
  } catch {
    // already gone
  }
  for (let i = 0; i < 50 && (await probe()); i++) await sleep(100)
  rmSync(pidFile, { force: true })
  return true
}

async function start() {
  mkdirSync(runtimeDir, { recursive: true })
  const log = openSync(logFile, "a")
  const child = spawn(process.execPath, [serverEntry], {
    cwd: webDir,
    detached: true,
    windowsHide: true,
    stdio: ["ignore", log, log],
  })
  child.unref()
  writeFileSync(pidFile, String(child.pid))
  for (let i = 0; i < 100; i++) {
    const status = await probe()
    if (status?.ours) return
    if (child.exitCode !== null) break
    await sleep(100)
  }
  const tail = existsSync(logFile) ? readFileSync(logFile, "utf8").trim().split("\n").slice(-3).join("\n") : ""
  fail(`The web companion did not start.${tail ? `\n\n${tail}` : ""}\n\nLog: ${logFile}`)
}

function openBrowser() {
  const [command, commandArgs] =
    process.platform === "win32"
      ? ["rundll32.exe", ["url.dll,FileProtocolHandler", url]]
      : process.platform === "darwin"
        ? ["open", [url]]
        : ["xdg-open", [url]]
  spawn(command, commandArgs, { detached: true, stdio: "ignore", windowsHide: true }).unref()
}

if (args.has("--stop")) {
  const stopped = await stop()
  if (stopped) console.log("Stopped the background web companion.")
  else if ((await probe())?.ours) {
    console.log("The web companion running now was not started in the background (npm run web?). Stop it in its own terminal.")
  } else console.log("The web companion is not running in the background.")
  process.exit(0)
}

let status = await probe()
if (args.has("--restart") || (status?.ours && status.version !== config.version)) {
  if (status?.ours && !(await stop())) {
    fail(`An older web companion (${status.version}) is running in a terminal. Close it, then try again.`)
  }
  status = await probe()
}
if (status && !status.ours) {
  fail(`Port ${config.port} is used by another program. Set CS2MCP_WEB_PORT in mcp-server/.env to a free port.`)
}
if (!status) await start()
console.log(`Web companion ${config.version} on ${url}`)
if (!args.has("--restart")) openBrowser()
