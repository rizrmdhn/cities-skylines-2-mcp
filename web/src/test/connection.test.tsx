import { screen, waitFor } from "@testing-library/react"
import { http, HttpResponse } from "msw"
import { describe, expect, it } from "vitest"

import * as fixtures from "@/test/fixtures"
import { renderApp } from "@/test/render-app"
import { apiError, server } from "@/test/server"

describe("connection status", () => {
  it("shows the city name once a city is loaded", async () => {
    renderApp("/")
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Riverside"))
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
  })

  it("explains when the bridge cannot be reached", async () => {
    server.use(
      http.get("*/api/ping", () =>
        apiError(502, "unreachable", "Cannot reach the CS2 bridge at http://127.0.0.1:8642.")
      )
    )
    renderApp("/")
    expect(await screen.findByText("Cannot reach the CS2 bridge")).toBeInTheDocument()
    expect(screen.getByRole("status")).toHaveTextContent("Bridge offline")
    expect(screen.getByText("Waiting for a city")).toBeInTheDocument()
  })

  it("explains when the companion server itself is gone", async () => {
    server.use(http.get("*/api/ping", () => HttpResponse.error()))
    renderApp("/")
    expect(await screen.findByText("Cannot reach the CS2 bridge")).toBeInTheDocument()
  })

  it("explains when the game is still loading", async () => {
    server.use(http.get("*/api/ping", () => HttpResponse.json({ ...fixtures.ping, isLoading: true })))
    renderApp("/")
    expect(await screen.findByText("The game is loading")).toBeInTheDocument()
    expect(screen.getByRole("status")).toHaveTextContent("Game loading")
  })

  it("explains when AI requests are switched off in the game", async () => {
    server.use(
      http.get("*/api/ping", () => HttpResponse.json({ ...fixtures.ping, bridgeEnabled: false }))
    )
    renderApp("/")
    expect(await screen.findByText("AI requests are switched off")).toBeInTheDocument()
  })

  it("explains when no city is loaded", async () => {
    server.use(
      http.get("*/api/state", () =>
        HttpResponse.json({ ...fixtures.state, cityLoaded: false, gameMode: "MainMenu" })
      )
    )
    renderApp("/")
    expect(await screen.findByRole("alert")).toHaveTextContent("No city loaded")
    expect(screen.getByRole("status")).toHaveTextContent("No city loaded")
  })

  it("explains when the bridge rejects the token", async () => {
    server.use(
      http.get("*/api/state", () =>
        apiError(401, "bridge", "missing or invalid X-CS2MCP-Token header")
      )
    )
    renderApp("/")
    expect(await screen.findByText("The bridge rejected the token")).toBeInTheDocument()
    expect(screen.getByText("missing or invalid X-CS2MCP-Token header")).toBeInTheDocument()
    expect(screen.getByRole("status")).toHaveTextContent("Token rejected")
  })

  it("marks read-only mode", async () => {
    server.use(http.get("*/api/ping", () => HttpResponse.json({ ...fixtures.ping, readOnly: true })))
    renderApp("/")
    expect(await screen.findByText("Read-only")).toBeInTheDocument()
  })

  it("warns when the mod and the companion versions differ", async () => {
    server.use(
      http.get("*/api/ping", () => HttpResponse.json({ ...fixtures.ping, version: "0.9.0+abc" }))
    )
    renderApp("/")
    expect(await screen.findByText("Version mismatch")).toBeInTheDocument()
    expect(screen.getByText(/runs CS2MCP 0\.9\.0\+abc/)).toBeInTheDocument()
  })

  it("ignores build metadata when comparing versions", async () => {
    server.use(
      http.get("*/api/ping", () =>
        HttpResponse.json({ ...fixtures.ping, version: `${__APP_VERSION__}+abc123` })
      )
    )
    renderApp("/")
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Riverside"))
    expect(screen.queryByText("Version mismatch")).not.toBeInTheDocument()
  })
})
