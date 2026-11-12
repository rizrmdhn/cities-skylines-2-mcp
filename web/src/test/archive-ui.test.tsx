import { screen, within } from "@testing-library/react"
import { http, HttpResponse } from "msw"
import { describe, expect, it } from "vitest"

import * as fixtures from "@/test/fixtures"
import { renderApp } from "@/test/render-app"
import { enableDesktopMode, server } from "@/test/server"

/** The archive holds the two sessions of fixtures.sessionEntries; the bridge was restarted and has one new entry. */
const restarted = {
  ...fixtures.sessionHistory,
  total: 1,
  returned: 1,
  entries: [
    {
      ...fixtures.sessionEntries[0],
      id: 1,
      timeUtc: "2026-11-12T10:00:00Z",
      path: "/build/place",
      query: { prefab: "Library01", x: "10", z: "10" },
    },
  ],
}

describe("activity with the desktop archive", () => {
  it("shows sessions of earlier game runs next to the live one", async () => {
    enableDesktopMode({ features: ["settings-api", "history-archive"] })
    server.use(
      http.get("*/api/history", () => HttpResponse.json(restarted)),
      http.get("*/api/desktop/history-archive", () =>
        HttpResponse.json({
          city: "Riverside",
          total: fixtures.sessionEntries.length,
          maxEntries: 5000,
          entries: fixtures.sessionEntries,
        })
      )
    )
    renderApp("/activity")
    expect(await screen.findByTestId("session-3")).toBeInTheDocument()
    expect(screen.getByTestId("session-2")).toBeInTheDocument()
    expect(screen.getByTestId("session-1")).toBeInTheDocument()
    expect(screen.getByText(/3 sessions, 11 changes recorded by the companion, including earlier game runs/)).toBeInTheDocument()
    expect(within(screen.getByTestId("session-3")).getByText("Latest")).toBeInTheDocument()
  })

  it("still shows the archive when the bridge cannot be reached", async () => {
    enableDesktopMode({ features: ["history-archive"] })
    server.use(
      http.get("*/api/history", () =>
        HttpResponse.json({ error: "unreachable", status: 502, kind: "unreachable" }, { status: 502 })
      ),
      http.get("*/api/desktop/history-archive", () =>
        HttpResponse.json({ city: "Riverside", total: 10, maxEntries: 5000, entries: fixtures.sessionEntries })
      )
    )
    renderApp("/activity")
    expect(await screen.findByTestId("session-2")).toBeInTheDocument()
    // only the spending card, which needs the bridge itself, reports the failure
    expect(screen.getAllByText("Could not load AI history")).toHaveLength(1)
  })

  it("uses the bridge's log alone when the desktop app has no archive", async () => {
    enableDesktopMode({ features: ["settings-api"] })
    server.use(http.get("*/api/history", () => HttpResponse.json(fixtures.sessionHistory)))
    renderApp("/activity")
    expect(await screen.findByTestId("session-2")).toBeInTheDocument()
    expect(screen.getByText(/changes since the save was loaded/)).toBeInTheDocument()
  })
})
