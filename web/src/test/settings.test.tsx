import { screen, waitFor, within } from "@testing-library/react"
import { http, HttpResponse } from "msw"
import { describe, expect, it } from "vitest"

import { mockDesktopSettings } from "@/test/desktop-settings"
import * as fixtures from "@/test/fixtures"
import { renderApp } from "@/test/render-app"
import { apiError, enableDesktopMode, server } from "@/test/server"

const SECRET = "s3cr3t-token-value"

function nav() {
  return screen.getByRole("navigation", { name: "Main" })
}

async function openSettings() {
  const view = renderApp("/settings")
  await screen.findByRole("heading", { name: "Settings", level: 1 })
  return view
}

describe("settings in the browser companion", () => {
  it("has no nav item", async () => {
    renderApp("/")
    await screen.findByRole("status")
    await waitFor(() => expect(within(nav()).getAllByRole("link")).toHaveLength(3))
    expect(within(nav()).queryByRole("link", { name: "Settings" })).not.toBeInTheDocument()
  })

  it("shows an empty state on /settings and never asks for settings", async () => {
    const asked: string[] = []
    server.events.on("request:start", ({ request }) => asked.push(new URL(request.url).pathname))
    renderApp("/settings")
    expect(await screen.findByText("Settings are available in the desktop app")).toBeInTheDocument()
    expect(screen.queryByRole("heading", { name: "Connection" })).not.toBeInTheDocument()
    expect(asked).not.toContain("/api/desktop/settings")
    server.events.removeAllListeners()
  })
})

describe("settings in the desktop app", () => {
  it("adds the nav item", async () => {
    mockDesktopSettings()
    renderApp("/")
    await screen.findByRole("status")
    const link = await within(nav()).findByRole("link", { name: "Settings" })
    expect(link).toHaveAttribute("href", "/settings")
  })

  it("shows the effective bridge URL and where it comes from", async () => {
    mockDesktopSettings({ values: { bridgeUrl: "http://192.168.1.20:8642" } })
    await openSettings()
    const input = await screen.findByLabelText("Bridge URL")
    expect(input).toHaveValue("http://192.168.1.20:8642")
    const connection = screen.getByRole("region", { name: "Connection" })
    expect(connection).toHaveTextContent("In effect: http://192.168.1.20:8642")
    expect(connection).toHaveTextContent("saved here")
  })

  it("shows the default when nothing is saved", async () => {
    mockDesktopSettings()
    await openSettings()
    const input = await screen.findByLabelText("Bridge URL")
    expect(input).toHaveValue("")
    expect(input).toHaveAttribute("placeholder", "http://127.0.0.1:8642")
    expect(screen.getByRole("region", { name: "Connection" })).toHaveTextContent(
      "In effect: http://127.0.0.1:8642 default"
    )
    expect(screen.queryByRole("button", { name: "Reset to default" })).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled()
  })

  it("saves a new bridge URL, tests it and points the whole app at the new bridge", async () => {
    const settings = mockDesktopSettings()
    let city = "Riverside"
    server.use(http.get("*/api/state", () => HttpResponse.json({ ...fixtures.state, cityName: city })))
    const { user } = await openSettings()
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Riverside"))

    // the main process now talks to another game
    city = "Harbor Town"
    await user.type(await screen.findByLabelText("Bridge URL"), "http://127.0.0.1:9001")
    expect(screen.getByText(/Unsaved changes/)).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Save" }))

    await waitFor(() => expect(settings.posts).toEqual([{ bridgeUrl: "http://127.0.0.1:9001" }]))
    const result = await screen.findByTestId("connection-test-result")
    expect(result).toHaveTextContent("Connected")
    expect(result).toHaveTextContent("Reached CS2MCP")
    expect(result).toHaveTextContent("http://127.0.0.1:9001")
    expect(result).toHaveTextContent("Harbor Town")
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Harbor Town"))
    expect(screen.getByLabelText("Bridge URL")).toHaveValue("http://127.0.0.1:9001")
    expect(screen.getByRole("button", { name: "Reset to default" })).toBeInTheDocument()
  })

  it("resets the bridge URL to the default", async () => {
    const settings = mockDesktopSettings({ values: { bridgeUrl: "http://10.0.0.5:8642" } })
    const { user } = await openSettings()
    await user.click(await screen.findByRole("button", { name: "Reset to default" }))
    await waitFor(() => expect(settings.posts).toEqual([{ bridgeUrl: null }]))
    await waitFor(() => expect(screen.getByLabelText("Bridge URL")).toHaveValue(""))
    expect(screen.getByRole("region", { name: "Connection" })).toHaveTextContent("default")
  })

  it("refuses an invalid URL next to the field without sending it", async () => {
    const settings = mockDesktopSettings()
    const { user } = await openSettings()
    const input = await screen.findByLabelText("Bridge URL")
    await user.type(input, "ftp://example.com")
    await user.click(screen.getByRole("button", { name: "Save" }))
    expect(await screen.findByText(/Enter an http:\/\/ or https:\/\/ URL/)).toBeInTheDocument()
    expect(input).toBeInvalid()
    expect(settings.posts).toEqual([])
    // editing clears the message
    await user.type(input, "x")
    expect(screen.queryByText(/Enter an http/)).not.toBeInTheDocument()
  })

  it("shows the main process's per-field message next to the field it belongs to", async () => {
    const settings = mockDesktopSettings({
      validate: {
        bridgeUrl: (value) => (String(value).includes("evil") ? "that host is not allowed" : undefined),
        token: () => "token is too long",
      },
    })
    const { user } = await openSettings()
    await user.type(await screen.findByLabelText("Bridge URL"), "http://evil.example:8642")
    await user.type(screen.getByLabelText("Token"), SECRET)
    await user.click(screen.getByRole("button", { name: "Save" }))

    const urlError = await screen.findByText("that host is not allowed")
    const tokenError = screen.getByText("token is too long")
    expect(screen.getByLabelText("Bridge URL")).toHaveAccessibleDescription(/that host is not allowed/)
    expect(screen.getByLabelText("Token")).toHaveAccessibleDescription(/token is too long/)
    expect(screen.getByLabelText("Bridge URL")).not.toHaveAccessibleDescription(/token is too long/)
    expect(urlError).not.toBe(tokenError)
    expect(screen.getByLabelText("Bridge URL")).toHaveValue("http://evil.example:8642")
    expect(settings.token).toBeNull()
  })
})

describe("the token", () => {
  it("is set, replaced and cleared without ever being echoed", async () => {
    const settings = mockDesktopSettings()
    const { user, queryClient } = await openSettings()
    const field = await screen.findByLabelText("Token")
    expect(field).toHaveAttribute("type", "password")
    expect(screen.getByText("Not set")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Clear token" })).not.toBeInTheDocument()

    await user.type(field, SECRET)
    await user.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() => expect(settings.posts).toEqual([{ token: SECRET }]))
    expect(await screen.findByText("Set (saved here)")).toBeInTheDocument()

    // the field is empty again and the token is nowhere in the page or the query cache
    expect(screen.getByLabelText("Token")).toHaveValue("")
    expect(document.body.textContent).not.toContain(SECRET)
    expect(screen.queryByDisplayValue(SECRET)).not.toBeInTheDocument()
    const cached = JSON.stringify(queryClient.getQueryCache().getAll().map((query) => query.state.data))
    expect(cached).not.toContain(SECRET)
    expect(settings.responses.join("\n")).not.toContain(SECRET)
    expect(settings.token).toBe(SECRET)

    // replace
    await user.type(screen.getByLabelText("Token"), "another-token")
    await user.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() => expect(settings.token).toBe("another-token"))
    expect(settings.responses.join("\n")).not.toContain("another-token")

    // clear
    await user.click(await screen.findByRole("button", { name: "Clear token" }))
    await waitFor(() => expect(settings.token).toBeNull())
    expect(settings.posts.at(-1)).toEqual({ token: null })
    expect(await screen.findByText("Not set")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Clear token" })).not.toBeInTheDocument()
  })

  it("warns when it can only be stored as plain text", async () => {
    mockDesktopSettings({ secretsEncrypted: false })
    await openSettings()
    expect(await screen.findByText("The token is stored as plain text")).toBeInTheDocument()
  })

  it("does not warn when the OS keystore encrypts it", async () => {
    mockDesktopSettings()
    await openSettings()
    await screen.findByLabelText("Token")
    expect(screen.queryByText("The token is stored as plain text")).not.toBeInTheDocument()
  })
})

describe("settings that the environment overrides", () => {
  it("explains that the environment variable wins over a saved bridge URL", async () => {
    mockDesktopSettings({
      env: { bridgeUrl: "http://192.168.0.9:8642" },
      values: { bridgeUrl: "http://127.0.0.1:9999" },
    })
    await openSettings()
    const title = await screen.findByText("CS2_BRIDGE_URL is set in the environment")
    expect(title.closest("[role=alert]")).toHaveTextContent("The URL saved here is kept but not in effect")
    const connection = screen.getByRole("region", { name: "Connection" })
    expect(connection).toHaveTextContent("In effect: http://192.168.0.9:8642")
    expect(connection).toHaveTextContent("environment variable")
    // the saved value is still what the field edits
    expect(screen.getByLabelText("Bridge URL")).toHaveValue("http://127.0.0.1:9999")
  })

  it("explains that an environment token wins and says where a set token comes from", async () => {
    mockDesktopSettings({ env: { token: "from-env" } })
    await openSettings()
    expect(await screen.findByText("CS2MCP_TOKEN is set in the environment")).toBeInTheDocument()
    expect(screen.getByText("Set (environment variable)")).toBeInTheDocument()
    expect(screen.getByText(/A token saved here will not take effect/)).toBeInTheDocument()
    expect(document.body.textContent).not.toContain("from-env")
  })

  it("says nothing about the environment when it is not involved", async () => {
    mockDesktopSettings()
    await openSettings()
    await screen.findByLabelText("Bridge URL")
    expect(screen.queryByText(/is set in the environment/)).not.toBeInTheDocument()
  })
})

describe("Test connection", () => {
  async function runTest(overrides: () => void) {
    mockDesktopSettings({ values: { bridgeUrl: "http://10.1.1.1:8642" } })
    const view = await openSettings()
    overrides()
    await view.user.click(await screen.findByRole("button", { name: "Test connection" }))
    return screen.findByTestId("connection-test-result")
  }

  it("reports a reachable bridge with the mod version and the city", async () => {
    const result = await runTest(() => {})
    expect(result).toHaveTextContent("Connected")
    expect(result).toHaveTextContent(
      `Reached CS2MCP ${fixtures.ping.version} at http://10.1.1.1:8642; the city Riverside is loaded.`
    )
    expect(result).not.toHaveTextContent("Version mismatch")
  })

  it("reports a bridge that is switched off", async () => {
    const result = await runTest(() =>
      server.use(http.get("*/api/ping", () => HttpResponse.json({ ...fixtures.ping, bridgeEnabled: false })))
    )
    expect(result).toHaveTextContent("AI requests off")
    expect(result).toHaveTextContent("the bridge is switched off")
    expect(result).toHaveTextContent("Accept AI requests")
  })

  it("reports a rejected token", async () => {
    const result = await runTest(() =>
      server.use(http.get("*/api/state", () => apiError(401, "bridge", "missing or invalid X-CS2MCP-Token header")))
    )
    expect(result).toHaveTextContent("Token rejected")
    expect(result).toHaveTextContent("The bridge at http://10.1.1.1:8642 rejected the token")
    expect(result).toHaveTextContent("missing or invalid X-CS2MCP-Token header")
  })

  it("reports an unreachable bridge with the URL that was tried", async () => {
    const result = await runTest(() =>
      server.use(
        http.get("*/api/ping", () => apiError(502, "unreachable", "Cannot reach the CS2 bridge at http://10.1.1.1:8642."))
      )
    )
    expect(result).toHaveTextContent("Bridge offline")
    expect(result).toHaveTextContent("Nothing answered at http://10.1.1.1:8642")
    expect(result).toHaveTextContent("Cannot reach the CS2 bridge at http://10.1.1.1:8642.")
  })

  it("reports a version mismatch next to the result", async () => {
    const result = await runTest(() =>
      server.use(http.get("*/api/ping", () => HttpResponse.json({ ...fixtures.ping, version: "0.1.0+abc" })))
    )
    expect(result).toHaveTextContent("Connected")
    expect(result).toHaveTextContent("Version mismatch: the game runs CS2MCP 0.1.0+abc")
  })

  it("reports that no city is loaded", async () => {
    const result = await runTest(() =>
      server.use(
        http.get("*/api/state", () => HttpResponse.json({ ...fixtures.state, cityLoaded: false, cityName: null }))
      )
    )
    expect(result).toHaveTextContent("No city loaded")
    expect(result).toHaveTextContent("Reached CS2MCP")
  })

  it("reports a failing state request without claiming that nobody answered", async () => {
    const result = await runTest(() =>
      server.use(http.get("*/api/state", () => apiError(500, "bridge", "state exploded")))
    )
    expect(result).toHaveTextContent("but the city state could not be read")
    expect(result).not.toHaveTextContent("Nothing answered")
    expect(result).toHaveTextContent("state exploded")
  })

  it("runs by itself after a save and reports the saved URL", async () => {
    mockDesktopSettings()
    const { user } = await openSettings()
    await user.type(await screen.findByLabelText("Bridge URL"), "http://127.0.0.1:9001")
    await user.click(screen.getByRole("button", { name: "Save" }))
    expect(await screen.findByTestId("connection-test-result")).toHaveTextContent("http://127.0.0.1:9001")
  })
})

describe("connection alerts in the desktop app", () => {
  const rejected = () =>
    server.use(http.get("*/api/state", () => apiError(401, "bridge", "missing or invalid X-CS2MCP-Token header")))

  it("point to the settings page instead of the .env file", async () => {
    mockDesktopSettings()
    rejected()
    renderApp("/")
    expect(await screen.findByText("The bridge rejected the token")).toBeInTheDocument()
    expect(screen.queryByText(/\.env/)).not.toBeInTheDocument()
    const link = screen.getByRole("link", { name: "Open connection settings" })
    expect(link).toHaveAttribute("href", "/settings#connection")
  })

  it("still tell the browser companion's user about the .env file", async () => {
    rejected()
    renderApp("/")
    expect(await screen.findByText("The bridge rejected the token")).toBeInTheDocument()
    expect(screen.getByText(/Fix it in the \.env file/)).toBeInTheDocument()
    expect(screen.queryByRole("link", { name: "Open connection settings" })).not.toBeInTheDocument()
  })
})

describe("appearance", () => {
  it("chooses the theme", async () => {
    mockDesktopSettings()
    const { user } = await openSettings()
    const group = await screen.findByRole("group", { name: "Theme" })
    await user.click(within(group).getByRole("button", { name: "Dark" }))
    await waitFor(() => expect(document.documentElement).toHaveClass("dark"))
    expect(localStorage.getItem("theme")).toBe("dark")
    expect(within(group).getByRole("button", { name: "Dark" })).toHaveAttribute("aria-pressed", "true")
    await user.click(within(group).getByRole("button", { name: "Light" }))
    await waitFor(() => expect(document.documentElement).toHaveClass("light"))
  })
})

describe("about", () => {
  it("lists versions, platform, build and the active desktop features", async () => {
    mockDesktopSettings({ features: ["app-folders", "tray"] })
    enableDesktopMode({
      version: "1.2.3",
      platform: "win32",
      packaged: true,
      features: ["settings-api", "app-folders", "tray"],
    })
    await openSettings()
    const about = await screen.findByRole("region", { name: "About" })
    await waitFor(() => expect(about).toHaveTextContent(`Mod version${fixtures.ping.version}`))
    expect(about).toHaveTextContent("App version1.2.3")
    expect(about).toHaveTextContent("PlatformWindows")
    expect(about).toHaveTextContent("BuildPackaged")
    const features = within(about).getByRole("list", { name: "Active desktop features" })
    expect(within(features).getAllByRole("listitem").map((item) => item.textContent)).toEqual([
      "settings-api",
      "app-folders",
      "tray",
    ])
  })

  it("opens the log and settings folders by route, sending no path", async () => {
    const settings = mockDesktopSettings({ features: ["app-folders"] })
    const requests: { url: string; body: string }[] = []
    server.events.on("request:start", async ({ request }) => {
      if (request.method === "POST" && request.url.includes("app-folders")) {
        requests.push({ url: new URL(request.url).pathname, body: await request.clone().text() })
      }
    })
    const { user } = await openSettings()
    await user.click(await screen.findByRole("button", { name: "Open log folder" }))
    await waitFor(() => expect(settings.posts).toContainEqual({ open: "open-logs" }))
    await user.click(screen.getByRole("button", { name: "Open settings folder" }))
    await waitFor(() => expect(settings.posts).toContainEqual({ open: "open-settings" }))
    expect(requests.map((request) => request.url)).toEqual([
      "/api/desktop/app-folders/open-logs",
      "/api/desktop/app-folders/open-settings",
    ])
    expect(requests.every((request) => request.body === "{}")).toBe(true)
    server.events.removeAllListeners()
  })

  it("shows why a folder could not be opened", async () => {
    mockDesktopSettings({ features: ["app-folders"] })
    server.use(
      http.post("*/api/desktop/app-folders/open-logs", () =>
        apiError(500, "companion", "could not open the logs folder: Access is denied.")
      )
    )
    const { user } = await openSettings()
    await user.click(await screen.findByRole("button", { name: "Open log folder" }))
    expect(await screen.findByText("could not open the logs folder: Access is denied.")).toBeInTheDocument()
  })

  it("hides the folder buttons when the feature is not there", async () => {
    mockDesktopSettings()
    await openSettings()
    await screen.findByRole("region", { name: "About" })
    expect(screen.queryByRole("button", { name: "Open log folder" })).not.toBeInTheDocument()
  })
})
