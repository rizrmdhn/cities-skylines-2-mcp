/**
 * Part of the smoke test (called by smoke.mjs after the first app run): the settings page in the
 * real Electron window. A second app is started with a throwaway profile whose saved bridge URL
 * points at stub bridge A and with no environment overrides, then, driving the real UI over the
 * DevTools protocol:
 *   - the header has a Settings item (desktop only) and /settings shows the saved bridge URL
 *   - the bridge URL is changed to stub bridge B and the token is set, both through the form;
 *     the whole app (header badge, test result) switches to B, and B received the new token
 *   - no response body of the main process, and no text on the page, contains the token
 *   - the About section lists the active features and the folder buttons exist
 *   - the log does not contain the token
 * It never contacts a real bridge: the profile is seeded with stub A's URL, and the form is only
 * ever pointed at stub B (Reset to default would point at port 8642, so it is not exercised here).
 *
 * With `--settings-screenshots <dir>` it also saves PNGs of the page (wide and narrow, light and dark).
 */
import { spawn } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { startStubBridge } from "./stub-bridge.mjs"

const SECOND_CITY = "Harbor Town"
const TOKEN = "settings-smoke-token-9b4e71"

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

async function waitFor(what, check, timeoutMs = 30_000) {
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

/** A DevTools-protocol client that also delivers events. */
async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl)
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true })
    ws.addEventListener("error", () => reject(new Error(`cannot connect to ${wsUrl}`)), { once: true })
  })
  let nextId = 1
  const pending = new Map()
  const listeners = new Map()
  ws.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data))
    if (message.method) {
      for (const listener of listeners.get(message.method) ?? []) listener(message.params)
      return
    }
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
  const on = (method, listener) => listeners.set(method, [...(listeners.get(method) ?? []), listener])
  return { send, evaluate, on, close: () => ws.close() }
}

/** @param {{ check: (name: string, ok: boolean, detail?: string) => void, electronPath: string, root: string }} context */
export async function runSettingsSmoke({ check, electronPath, root }) {
  const shotsArg = process.argv.indexOf("--settings-screenshots")
  const shotsDir = shotsArg > 0 ? process.argv[shotsArg + 1] : undefined
  const stubA = await startStubBridge()
  const stubB = await startStubBridge(0, { cityName: SECOND_CITY })
  const debugPort = await freePort()
  const userData = mkdtempSync(join(tmpdir(), "cs2mcp-smoke-settings-"))
  // The profile starts out pointing at stub A (nothing in the environment overrides it).
  writeFileSync(
    join(userData, "settings.json"),
    JSON.stringify({ version: 1, values: { bridgeUrl: stubA.url } })
  )
  const env = { ...process.env, CS2MCP_DESKTOP_USER_DATA: userData }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.CS2_BRIDGE_URL
  delete env.CS2MCP_TOKEN

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
    const target = await waitFor("the settings smoke window", async () => {
      const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json()
      return targets.find((t) => t.type === "page" && t.url.startsWith("app://cs2mcp/"))
    })
    cdp = await connect(target.webSocketDebuggerUrl)

    // Every answer the main process gives the page, to look for the token in afterwards.
    const bodies = []
    const finished = []
    await cdp.send("Network.enable")
    cdp.on("Network.responseReceived", ({ requestId, response }) => {
      if (response.url.startsWith("app://cs2mcp/api/")) finished.push({ requestId, url: response.url })
    })
    cdp.on("Network.loadingFinished", ({ requestId }) => {
      const entry = finished.find((item) => item.requestId === requestId)
      if (!entry) return
      cdp
        .send("Network.getResponseBody", { requestId })
        .then((body) => bodies.push({ url: entry.url, body: body.body }))
        .catch(() => {})
    })

    const header = () => cdp.evaluate(`document.querySelector("header")?.innerText ?? ""`)
    await waitFor("the stub A city in the header", async () => (await header()).includes("Riverside"))

    const navItem = await cdp.evaluate(
      `!!document.querySelector('nav[aria-label="Main"] a[href="/settings"]')`
    )
    check("the header has a Settings item in the desktop app", navItem === true)
    await cdp.evaluate(`(document.querySelector('nav[aria-label="Main"] a[href="/settings"]').click(), true)`)
    await waitFor("the Settings page", () =>
      cdp.evaluate(`document.querySelector("main h1")?.innerText === "Settings"`)
    )

    const urlInput = `document.querySelector('input[type="url"]')`
    const savedUrl = await waitFor("the bridge URL field", () => cdp.evaluate(`${urlInput}?.value`))
    check("/settings shows the saved bridge URL", savedUrl === stubA.url, savedUrl)
    const connectionText = await cdp.evaluate(`document.querySelector("#connection").innerText`)
    check(
      "it says which value is in effect and where it comes from",
      connectionText.includes(`In effect: ${stubA.url}`) && connectionText.includes("saved here"),
      connectionText.replace(/\s+/g, " ")
    )

    const clickButton = (label) =>
      cdp.evaluate(`(() => {
        const button = [...document.querySelectorAll("button")].find((b) => b.innerText.trim() === ${JSON.stringify(label)})
        if (!button) throw new Error("no ${label} button")
        button.click()
        return true
      })()`)
    if (shotsDir) {
      mkdirSync(shotsDir, { recursive: true })
      await clickButton("Light")
      await screenshots(cdp, shotsDir, "settings-light")
    }

    const typeInto = async (selector, text) => {
      await cdp.evaluate(`(document.querySelector(${JSON.stringify(selector)}).focus(), document.querySelector(${JSON.stringify(selector)}).select(), true)`)
      await cdp.send("Input.insertText", { text })
    }

    await typeInto('input[type="url"]', stubB.url)
    await typeInto('input[type="password"]', TOKEN)
    await clickButton("Save")

    await waitFor(`${SECOND_CITY} in the header`, async () => (await header()).includes(SECOND_CITY))
    check("saving the bridge URL switches the whole app to the new bridge", true)
    const result = await waitFor("the connection test result", () =>
      cdp.evaluate(`document.querySelector('[data-testid="connection-test-result"]')?.innerText`)
    )
    check(
      "Test connection reports the new bridge",
      result.includes("Connected") && result.includes(stubB.url) && result.includes(SECOND_CITY),
      result.replace(/\s+/g, " ")
    )
    const status = await cdp.evaluate(`document.querySelector("#connection").innerText`)
    check("the token shows as set, saved here", status.includes("Set (saved here)"), "")
    check(
      "the token field is empty again and a new URL is not marked unsaved",
      (await cdp.evaluate(`document.querySelector('input[type="password"]').value`)) === "" &&
        !status.includes("Unsaved changes")
    )
    check(
      "the new bridge received the token the main process added",
      stubB.requests.some((r) => r.headers["x-cs2mcp-token"] === TOKEN)
    )
    if (shotsDir) await screenshots(cdp, shotsDir, "settings-saved-light")
    const askedBefore = stubA.requests.length
    await sleep(4_500) // longer than the header's /ping interval
    check("the old bridge is not asked any more", stubA.requests.length === askedBefore, `${stubA.requests.length - askedBefore} new requests`)

    const leaked = bodies.filter((item) => item.body.includes(TOKEN))
    check(
      "no response body from the main process contains the token",
      bodies.length > 5 && leaked.length === 0,
      `${bodies.length} bodies checked${leaked.length ? `, leaked in ${leaked.map((item) => item.url)}` : ""}`
    )
    const settingsAnswer = await cdp.evaluate(`fetch("/api/desktop/settings").then((r) => r.json())`)
    check(
      "GET /api/desktop/settings reports tokenSet without the token",
      settingsAnswer.tokenSet === true && settingsAnswer.bridgeUrl === stubB.url && !JSON.stringify(settingsAnswer).includes(TOKEN)
    )
    check(
      "the page text does not contain the token",
      (await cdp.evaluate(`document.documentElement.innerHTML.includes(${JSON.stringify(TOKEN)})`)) === false
    )

    const about = await cdp.evaluate(`document.querySelector("#about")?.innerText ?? ""`)
    check(
      "About lists the active features and the folder buttons",
      about.includes("settings-api") && about.includes("app-folders") && about.includes("Open log folder") && about.includes("Open settings folder"),
      about.replace(/\s+/g, " ")
    )

    // Switching the theme from the page takes effect and sticks (and gives the dark screenshots).
    await clickButton("Dark")
    check("the Appearance section switches the theme", await cdp.evaluate(`document.documentElement.classList.contains("dark")`))
    if (shotsDir) {
      await screenshots(cdp, shotsDir, "settings-dark")
      await clickButton("Light")
    }
  } catch (err) {
    check("settings page smoke", false, err.message)
  } finally {
    cdp?.close()
    try {
      const version = await (await fetch(`http://127.0.0.1:${debugPort}/json/version`)).json()
      browser = await connect(version.webSocketDebuggerUrl)
      await Promise.race([browser.send("Browser.close").catch(() => {}), sleep(2_000)])
    } catch {
      // fall through to kill
    }
    const code = await Promise.race([exited, sleep(10_000).then(() => "timeout")])
    if (code === "timeout") {
      child.kill()
      check("settings smoke app quits", false, "had to be killed")
    } else {
      try {
        const log = readFileSync(join(userData, "logs", "main.log"), "utf8")
        check("token never written to the log (settings smoke)", !log.includes(TOKEN))
      } catch (err) {
        check("settings smoke log", false, err.message)
      }
    }
    browser?.close()
    await stubA.close()
    await stubB.close()
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        rmSync(userData, { recursive: true, force: true })
        break
      } catch {
        await sleep(500)
      }
    }
    if (output.includes("Error") && process.argv.includes("--verbose")) console.log(output)
  }
}

/** PNGs of the whole settings page at a wide and a narrow window, named <prefix>-wide.png / -narrow.png. */
async function screenshots(cdp, dir, prefix) {
  for (const [name, width] of [["wide", 1100], ["narrow", 420]]) {
    await cdp.send("Emulation.setDeviceMetricsOverride", { width, height: 2200, deviceScaleFactor: 1, mobile: false })
    await sleep(600)
    const { data } = await cdp.send("Page.captureScreenshot", { format: "png" })
    writeFileSync(join(dir, `${prefix}-${name}.png`), Buffer.from(data, "base64"))
  }
  await cdp.send("Emulation.clearDeviceMetricsOverride")
}
