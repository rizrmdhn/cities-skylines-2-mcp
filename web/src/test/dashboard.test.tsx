import { screen, within } from "@testing-library/react"
import { http, HttpResponse } from "msw"
import { describe, expect, it } from "vitest"

import * as fixtures from "@/test/fixtures"
import { renderApp } from "@/test/render-app"
import { apiError, server } from "@/test/server"

describe("dashboard", () => {
  it("shows the city overview", async () => {
    renderApp("/")
    expect(await screen.findByText("12,345")).toBeInTheDocument()
    expect(screen.getByText("12,500 with move-ins")).toBeInTheDocument()
    expect(screen.getByText("¢1,500,000")).toBeInTheDocument()
    expect(screen.getByText("63%")).toBeInTheDocument()
    expect(screen.getByText("71%")).toBeInTheDocument()
    expect(screen.getByText("1× speed")).toBeInTheDocument()
  })

  it("shows a paused simulation", async () => {
    server.use(
      http.get("*/api/city/overview", () =>
        HttpResponse.json({ ...fixtures.overview, simulationPaused: true })
      )
    )
    renderApp("/")
    expect(await screen.findByText("Paused")).toBeInTheDocument()
  })

  it("shows zone demand", async () => {
    renderApp("/")
    const lowDensity = await screen.findByRole("progressbar", { name: "Residential, low density" })
    expect(lowDensity).toHaveAttribute("aria-valuetext", "200 of 255")
    expect(screen.getByRole("progressbar", { name: "Industrial" })).toHaveAttribute(
      "aria-valuetext",
      "140 of 255"
    )
  })

  it("shows AI spending against the limit", async () => {
    renderApp("/")
    expect(await screen.findByText("¢40,000")).toBeInTheDocument()
    expect(screen.getByText(/left of the ¢100,000 limit, set in the game's options/)).toBeInTheDocument()
  })

  it("shows the latest AI changes with links to their details", async () => {
    renderApp("/")
    const card = (await screen.findByText("Latest AI changes")).closest("[data-slot=card]")!
    const latest = await within(card as HTMLElement).findByRole("link", { name: /^place/ })
    expect(latest).toHaveAttribute("href", "/activity?entry=5")
    expect(within(card as HTMLElement).getByRole("link", { name: "All activity" })).toHaveAttribute(
      "href",
      "/activity"
    )
  })

  it("keeps the rest of the dashboard when one card fails", async () => {
    server.use(http.get("*/api/city/demand", () => apiError(500, "bridge", "demand exploded")))
    renderApp("/")
    expect(await screen.findByText("demand exploded")).toBeInTheDocument()
    expect(screen.getByText("12,345")).toBeInTheDocument()
  })
})
