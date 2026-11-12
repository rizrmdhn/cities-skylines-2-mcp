#!/usr/bin/env node
/**
 * End-to-end smoke test of the built app (run `npm run build` first; `npm run smoke` does both).
 * Starts the stub bridge, launches Electron against it with a throwaway profile and a remote
 * debugging port, drives the window over the Chrome DevTools Protocol and asserts that:
 *   - the dashboard renders the stub's city name through app:// and the /api proxy
 *   - the renderer has no Node.js and runs under the Content-Security-Policy
 *   - GET /api/desktop/info answers desktop: true with the app version
 *   - POST /api/build/road is refused and never reaches the bridge
 *   - /api/desktop/settings never contains the token; POSTing a setting works
 *   - the header's speed buttons: a real click reaches the stub as POST /sim/control (token, validated
 *     parameters, the app's own Origin) and the UI shows the new speed; invalid control calls and
 *     other POSTs are refused before the bridge
 *   - navigating away from app://cs2mcp is blocked
 * then closes the app and checks it quit cleanly. Never talks to a real bridge on port 8642.
 *
 *   node scripts/smoke.mjs [--screenshot <file.png>] [--verbose]
 *   --screenshot  saves a PNG of the dashboard once it rendered
 *   --verbose     prints Electron's own output even when every check passes
 */
import { spawn } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import electronPath from "electron"

import { CITY_NAME, startStubBridge } from "./stub-bridge.mjs"

const root = fileURLToPath(new URL("..", import.meta.url))
const VERSION = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version
const TOKEN = "smoke-token-6f1d2c"
const TIMEOUT_MS = 30_000
const screenshotArg = process.argv.indexOf("--screenshot")
const screenshotFile = screenshotArg > 0 ? process.argv[screenshotArg + 1] : undefined
const verbose = process.argv.includes("--verbose")

if (!existsSync(join(root, "dist", "main.cjs"))) {
  console.error("dist/main.cjs is missing: run `npm run build` first.")
  process.exit(1)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.on("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}

async function waitFor(what, check, timeoutMs = TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    try {
      const value = await check()
      if (value) return value
    } catch (err) {
      last = err
    }
    await sleep(250)
  }
  throw new Error(`timed out waiting for ${what}${last ? `: ${last.message}` : ""}`)
}

/** Minimal CDP client over Node's global WebSocket. */
async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl)
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true })
    ws.addEventListener("error", () => reject(new Error(`cannot connect to ${wsUrl}`)), { once: true })
  })
  let nextId = 1
  const pending = new Map()
  ws.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data))
    const waiter = pending.get(message.id)
    if (!waiter) return
    pending.delete(message.id)
    if (message.error) waiter.reject(new Error(message.error.message))
    else waiter.resolve(message.result)
  })
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++
      pending.set(id, { resolve, reject })
      ws.send(JSON.stringify({ id, method, params }))
    })
  /** Evaluates an async expression in the page and returns its JSON value. */
  const evaluate = async (expression) => {
    const result = await send("Runtime.evaluate", {
      expression: `(async () => (${expression}))()`,
      awaitPromise: true,
      returnByValue: true,
    })
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
    }
    return result.result.value
  }
  return { send, evaluate, close: () => ws.close() }
}

const results = []
function check(name, ok, detail = "") {
  results.push({ name, ok })
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`)
}

const stub = await startStubBridge()
const debugPort = await freePort()
const userData = mkdtempSync(join(tmpdir(), "cs2mcp-smoke-"))
const env = {
  ...process.env,
  CS2_BRIDGE_URL: stub.url,
  CS2MCP_TOKEN: TOKEN,
  CS2MCP_DESKTOP_USER_DATA: userData,
}
delete env.ELECTRON_RUN_AS_NODE

console.log(`stub bridge ${stub.url}, debugging port ${debugPort}, profile ${userData}`)
const child = spawn(electronPath, [".", `--remote-debugging-port=${debugPort}`], {
  cwd: root,
  env,
  stdio: ["ignore", "pipe", "pipe"],
})
let output = ""
child.stdout.on("data", (chunk) => (output += chunk))
child.stderr.on("data", (chunk) => (output += chunk))
const exited = new Promise((resolve) => child.on("exit", (code) => resolve(code)))

let cdp
let browser
try {
  const target = await waitFor("the app window", async () => {
    const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json()
    return targets.find((t) => t.type === "page" && t.url.startsWith("app://cs2mcp/"))
  })
  check("window loads app://cs2mcp/", true, target.url)
  cdp = await connect(target.webSocketDebuggerUrl)

  const text = await waitFor(`"${CITY_NAME}" on the dashboard`, async () => {
    const body = await cdp.evaluate("document.body.innerText")
    return body.includes(CITY_NAME) ? body : null
  })
  check("dashboard renders the stub city through the proxy", text.includes(CITY_NAME))
  if (screenshotFile) {
    await sleep(1_500) // let the remaining cards settle
    const { data } = await cdp.send("Page.captureScreenshot", { format: "png" })
    writeFileSync(screenshotFile, Buffer.from(data, "base64"))
    console.log(`saved ${screenshotFile}`)
  }
  check("page title", (await cdp.evaluate("document.title")) === "CS2MCP Companion")

  const isolated = await cdp.evaluate(
    `typeof require === "undefined" && typeof process === "undefined" && typeof module === "undefined"`
  )
  check("renderer has no Node.js", isolated === true)

  const csp = await cdp.evaluate(`fetch("/").then((r) => r.headers.get("content-security-policy"))`)
  check("HTML carries the Content-Security-Policy", typeof csp === "string" && csp.includes("script-src 'self'"), csp)
  // DevTools-evaluated code is exempt from the CSP, so probe with an inline <script> the page adds.
  const inlineBlocked = await cdp.evaluate(`new Promise((resolve) => {
      document.addEventListener("securitypolicyviolation", (e) => resolve(e.violatedDirective), { once: true })
      const script = document.createElement("script")
      script.textContent = "window.__inlineRan = true"
      document.head.append(script)
      setTimeout(() => resolve(window.__inlineRan ? "ran" : "silent"), 1000)
    })`)
  check("CSP blocks inline scripts", String(inlineBlocked).startsWith("script-src"), String(inlineBlocked))

  const info = await cdp.evaluate(`fetch("/api/desktop/info").then((r) => r.json())`)
  check(
    "GET /api/desktop/info",
    info.desktop === true && info.version === VERSION && info.features.includes("settings-api"),
    JSON.stringify(info)
  )

  const before = stub.requests.length
  const refused = await cdp.evaluate(
    `fetch("/api/build/road", { method: "POST" }).then(async (r) => ({ status: r.status, body: await r.json() }))`
  )
  const reached = stub.requests.slice(before).filter((r) => r.url.startsWith("/build"))
  check(
    "POST /api/build/road is refused before the bridge",
    refused.status === 405 && refused.body.kind === "companion" && reached.length === 0,
    `HTTP ${refused.status}`
  )

  const settingsText = await cdp.evaluate(`fetch("/api/desktop/settings").then((r) => r.text())`)
  const settings = JSON.parse(settingsText)
  check(
    "GET /api/desktop/settings has no token",
    !settingsText.includes(TOKEN) && settings.effective.tokenSet === true && settings.effective.tokenSource === "env",
    settingsText
  )
  check(
    "the bridge got the token from the main process",
    stub.requests.some((r) => r.headers["x-cs2mcp-token"] === TOKEN)
  )

  const posted = await cdp.evaluate(`fetch("/api/desktop/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bridgeUrl: "http://127.0.0.1:1/" }),
    }).then(async (r) => ({ status: r.status, body: await r.json() }))`)
  check(
    "POST /api/desktop/settings stores a validated value (env still wins)",
    posted.status === 200 &&
      posted.body.bridgeUrl === "http://127.0.0.1:1" &&
      posted.body.effective.bridgeUrl === stub.url,
    JSON.stringify(posted.body)
  )
  const invalid = await cdp.evaluate(`fetch("/api/desktop/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bridgeUrl: "file:///C:/" }),
    }).then((r) => r.status)`)
  check("POST /api/desktop/settings refuses an invalid value", invalid === 400, `HTTP ${invalid}`)

  // The header's speed buttons, clicked with real mouse events.
  const buttonState = `(() => {
      const button = document.querySelector('[aria-label="8× max speed"]')
      return button && { pressed: button.getAttribute("aria-pressed"), badge: document.body.innerText.includes("8× speed (max)") }
    })()`
  const clickCenter = async (label) => {
    const point = await cdp.evaluate(`(() => {
        const rect = document.querySelector('[aria-label="${label}"]').getBoundingClientRect()
        return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
      })()`)
    for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) {
      await cdp.send("Input.dispatchMouseEvent", { type, ...point, button: "left", clickCount: 1 })
    }
  }
  const initial = await waitFor("the speed controls", () => cdp.evaluate(buttonState))
  check("the header shows the speed controls, 8× not pressed", initial.pressed === "false", JSON.stringify(initial))
  await clickCenter("8× max speed")
  const control = await waitFor("the speed POST to reach the bridge", () =>
    stub.requests.find((r) => r.method === "POST" && r.url.startsWith("/sim/control"))
  )
  check(
    "clicking 8× POSTs /sim/control?speed=8 to the bridge with the token",
    control.url === "/sim/control?speed=8" && control.headers["x-cs2mcp-token"] === TOKEN,
    `${control.method} ${control.url}`
  )
  const shown = await waitFor("the UI to show 8×", async () => {
    const now = await cdp.evaluate(buttonState)
    return now.pressed === "true" && now.badge ? now : null
  })
  check("the UI shows 8× in the header and on the city card", shown.pressed === "true" && shown.badge)
  await sleep(6_000) // the next /state poll must keep showing what the bridge now reports
  const stays = await cdp.evaluate(buttonState)
  check("the speed stays after the next poll", stays.pressed === "true" && stub.sim.selectedSpeed === 8)

  const beforeRefused = stub.requests.length
  const refusedCalls = await cdp.evaluate(`Promise.all([
      fetch("/api/sim/control?speed=99", { method: "POST" }),
      fetch("/api/sim/control?speed=2&cheat=1", { method: "POST" }),
      fetch("/api/sim/control", { method: "POST" }),
      fetch("/api/sim/control?paused=true"),
      fetch("/api/sim/run?hours=1", { method: "POST" }),
    ]).then((rs) => rs.map((r) => r.status))`)
  check(
    "invalid control calls and other POSTs are refused before the bridge",
    refusedCalls.join() === "400,400,400,405,405" && stub.requests.length === beforeRefused,
    refusedCalls.join()
  )

  const opened = await cdp.evaluate(`window.open("about:blank") === null`)
  check("window.open is denied", opened === true)

  // Another host of our own scheme: only the app's will-frame-navigate guard can stop this one
  // (an http(s) URL would open the system browser, so the smoke test does not use one).
  await cdp.evaluate(`(location.href = "app://elsewhere/", true)`)
  await sleep(1_000)
  const location = await cdp.evaluate("location.href")
  const guardLog = readFileSync(join(userData, "logs", "main.log"), "utf8")
  check(
    "navigation away from app://cs2mcp is blocked",
    location.startsWith("app://cs2mcp/") && guardLog.includes("refused to open app://elsewhere/"),
    location
  )

  // A second launch with the same profile hands over to the running app and exits.
  const second = spawn(electronPath, ["."], { cwd: root, env, stdio: "ignore" })
  const secondCode = await Promise.race([
    new Promise((resolve) => second.on("exit", resolve)),
    sleep(15_000).then(() => "still running"),
  ])
  if (secondCode === "still running") second.kill()
  const stillThere = await cdp.evaluate("location.href")
  check(
    "a second launch exits and leaves the first window",
    secondCode === 0 && stillThere.startsWith("app://cs2mcp/"),
    `second instance: ${secondCode}`
  )

  const mutating = stub.requests.filter((r) => r.method !== "GET")
  check(
    "the bridge only ever saw GET requests and the one speed POST",
    mutating.length === 1 && mutating[0].method === "POST" && mutating[0].url === "/sim/control?speed=8",
    mutating.map((r) => `${r.method} ${r.url}`).join(", ")
  )
} catch (err) {
  check("smoke run", false, err.message)
} finally {
  cdp?.close()
  // Close the whole app the way the user would (all windows -> quit).
  try {
    const version = await (await fetch(`http://127.0.0.1:${debugPort}/json/version`)).json()
    browser = await connect(version.webSocketDebuggerUrl)
    // the socket drops as the app goes away, so do not wait for an answer
    await Promise.race([browser.send("Browser.close").catch(() => {}), sleep(2_000)])
  } catch {
    // fall through to kill
  }
  const code = await Promise.race([exited, sleep(10_000).then(() => "timeout")])
  if (code === "timeout") {
    child.kill()
    check("app quits", false, "had to be killed")
  } else {
    const log = readFileSync(join(userData, "logs", "main.log"), "utf8")
    check("app quits cleanly", log.includes(" quit"), `exit code ${code}`)
    check("token never written to the log", !log.includes(TOKEN))
    const stored = readFileSync(join(userData, "settings.json"), "utf8")
    check("window state and settings were saved", stored.includes('"window.main"') && stored.includes('"bridgeUrl"'))
  }
  browser?.close()
  await stub.close()
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      rmSync(userData, { recursive: true, force: true })
      break
    } catch {
      await sleep(500)
    }
  }
}

const failed = results.filter((r) => !r.ok)
if (failed.length) {
  console.log(`\n${failed.length} check(s) failed. Electron output:\n${output}`)
  process.exit(1)
}
if (verbose) console.log(`\nElectron output:\n${output || "(none)"}`)
console.log(`\nall ${results.length} checks passed`)
