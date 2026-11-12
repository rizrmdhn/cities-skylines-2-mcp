import { screen, waitFor, within } from "@testing-library/react"
import { http, HttpResponse } from "msw"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { downloadText } from "@/features/activity/download"
import * as fixtures from "@/test/fixtures"
import { renderApp } from "@/test/render-app"
import { server } from "@/test/server"

vi.mock("@/features/activity/download", () => ({ downloadText: vi.fn() }))

/**
 * Session 2 (ids 4-10): school, a batch of three road pieces (the third failed), a tax change that
 * interleaved with the batch's parts, a park. Session 1 (ids 1-3): tax, road, a failed zoning.
 */
function useSessions() {
  server.use(http.get("*/api/history", () => HttpResponse.json(fixtures.sessionHistory)))
}

/** `hidden`: an open detail sheet makes the rest of the page inert for the accessibility tree. */
function stepRows(session: HTMLElement) {
  return within(session).getAllByRole("row", { hidden: true }).slice(1) // skip the header row
}

beforeEach(() => vi.mocked(downloadText).mockClear())

describe("AI session timeline", () => {
  it("shows sessions newest first, each with its summary", async () => {
    useSessions()
    renderApp("/activity")
    const newest = await screen.findByTestId("session-2")
    const oldest = screen.getByTestId("session-1")
    expect(newest.compareDocumentPosition(oldest) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()

    expect(within(newest).getByText("Latest")).toBeInTheDocument()
    expect(newest).toHaveTextContent("4 actions")
    expect(newest).toHaveTextContent("1 failed")
    expect(newest).toHaveTextContent("¢83,000 spent")
    expect(newest).toHaveTextContent("around (300, -20)")
    expect(newest).toHaveTextContent(/road connect\s*× 3/)
    expect(newest).toHaveTextContent("12 min")

    expect(oldest).toHaveTextContent("3 actions")
    expect(oldest).toHaveTextContent("¢12,000 spent")
    expect(oldest).toHaveTextContent("2 min")
    expect(screen.getByText(/2 sessions, 10 changes since the save was loaded/)).toBeInTheDocument()
  })

  it("opens the newest session and folds the older ones", async () => {
    useSessions()
    const { user } = renderApp("/activity")
    const oldest = await screen.findByTestId("session-1")
    expect(within(screen.getByTestId("session-2")).getByRole("table")).toBeInTheDocument()
    expect(within(oldest).queryByRole("table")).not.toBeInTheDocument()

    await user.click(within(oldest).getByRole("button", { name: /^Session 1/ }))
    const table = await within(oldest).findByRole("table")
    expect(within(table).getAllByRole("row")).toHaveLength(4) // header + 3 steps
  })

  it("reads a batch as one step and unfolds it into its parts", async () => {
    useSessions()
    const { user } = renderApp("/activity")
    const newest = await screen.findByTestId("session-2")
    const folded = stepRows(newest)
    expect(folded).toHaveLength(4) // school, batch, tax, park
    expect(folded[1]).toHaveTextContent("batch")
    expect(folded[1]).toHaveTextContent("3 parts")
    expect(folded[1]).toHaveTextContent("1 of 3 failed")
    expect(folded[1]).toHaveTextContent("-¢30,000")

    await user.click(within(newest).getByRole("button", { name: "Show the 3 parts of step 2" }))
    const unfolded = stepRows(newest)
    expect(unfolded).toHaveLength(7)
    expect(unfolded[2]).toHaveTextContent("2.1")
    expect(unfolded[2]).toHaveTextContent("Done")
    expect(unfolded[4]).toHaveTextContent("2.3")
    expect(unfolded[4]).toHaveTextContent("Failed 400")
  })

  it("opens a step's entry in the detail sheet", async () => {
    useSessions()
    const { user, router } = renderApp("/activity")
    const newest = await screen.findByTestId("session-2")
    await user.click(within(newest).getAllByRole("link", { name: "place" })[0])
    expect(await screen.findByRole("dialog")).toHaveTextContent("#4")
    expect(router.state.location.search).toMatchObject({ entry: 4 })
  })

  it("unfolds the batch holding an entry linked from the URL", async () => {
    useSessions()
    renderApp("/activity?entry=8")
    const sheet = await screen.findByRole("dialog")
    expect(within(sheet).getByText(/segment overlaps a building/)).toBeInTheDocument()
    const newest = screen.getByTestId("session-2")
    expect(stepRows(newest)).toHaveLength(7)
  })

  it("opens the session that holds an entry linked from the URL", async () => {
    useSessions()
    renderApp("/activity?entry=3")
    expect(within(await screen.findByRole("dialog")).getByText(/area is not zonable/)).toBeInTheDocument()
    expect(within(screen.getByTestId("session-1")).getByRole("table", { hidden: true })).toBeInTheDocument()
  })

  it("opens and highlights the session named in the URL", async () => {
    useSessions()
    renderApp("/activity?session=1-1794384000")
    const oldest = await screen.findByTestId("session-1")
    await waitFor(() => expect(within(oldest).getByRole("table")).toBeInTheDocument())
    expect(oldest).toHaveAttribute("data-focused")
    expect(within(screen.getByTestId("session-2")).queryByRole("table")).not.toBeInTheDocument()
  })

  it("keeps a session when a step matches the filters and lists only those steps", async () => {
    useSessions()
    renderApp("/activity?status=failed")
    const newest = await screen.findByTestId("session-2")
    expect(screen.getByTestId("session-1")).toBeInTheDocument()
    expect(stepRows(newest)).toHaveLength(1)
    expect(within(newest).getByText(/Showing 1 of 4 actions/)).toBeInTheDocument()
    // the summary still describes the whole session
    expect(newest).toHaveTextContent("4 actions")
    expect(screen.getByText(/2 sessions, 10 changes/)).toBeInTheDocument()
  })

  it("hides sessions without a matching step", async () => {
    useSessions()
    renderApp("/activity?kind=%22%2Fbuild%2Fzone%22")
    await screen.findByTestId("session-1")
    expect(screen.queryByTestId("session-2")).not.toBeInTheDocument()
    expect(screen.getByText(/1 of 2 sessions/)).toBeInTheDocument()
  })

  it("offers a map replay for a session with positions, and none without", async () => {
    useSessions()
    renderApp("/activity")
    const link = within(await screen.findByTestId("session-2")).getByRole("link", {
      name: "Replay session 2 on the map",
    })
    const url = new URL(link.getAttribute("href")!, "http://localhost")
    expect(url.pathname).toBe("/map")
    expect(url.searchParams.get("replay")).toBe("4-1794387605")
    expect(url.searchParams.get("step")).toBe("1")
  })

  it("offers no replay for a session whose changes carry no position", async () => {
    server.use(
      http.get("*/api/history", () =>
        HttpResponse.json({
          ...fixtures.sessionHistory,
          entries: fixtures.sessionHistory.entries.filter((e) => e.path === "/city/taxes/set"),
        })
      )
    )
    renderApp("/activity")
    const session = await screen.findByTestId("session-2")
    expect(await within(session).findByText("no positions recorded")).toBeInTheDocument()
    expect(screen.queryByRole("link", { name: /Replay/ })).not.toBeInTheDocument()
  })
})

describe("AI session export", () => {
  it("exports one session as Markdown and as JSON", async () => {
    useSessions()
    const { user } = renderApp("/activity")
    const oldest = await screen.findByTestId("session-1")

    await user.click(within(oldest).getByRole("button", { name: "Export Session 1" }))
    await user.click(await screen.findByRole("menuitem", { name: /Markdown/ }))
    expect(downloadText).toHaveBeenCalledTimes(1)
    const [name, text, type] = vi.mocked(downloadText).mock.calls[0]
    expect(name).toMatch(/^cs2mcp-.*session-1-20261111-0800\.md$/)
    expect(type).toBe("text/markdown")
    expect(text).toContain("# AI session 1")
    expect(text).toContain("area is not zonable")

    await user.click(within(oldest).getByRole("button", { name: "Export Session 1" }))
    await user.click(await screen.findByRole("menuitem", { name: /JSON/ }))
    const [jsonName, json, jsonType] = vi.mocked(downloadText).mock.calls[1]
    expect(jsonName).toMatch(/session-1-20261111-0800\.json$/)
    expect(jsonType).toBe("application/json")
    expect(JSON.parse(json).sessions).toHaveLength(1)
  })

  it("exports every session that is shown, with the page's filters", async () => {
    useSessions()
    const { user } = renderApp("/activity?status=failed")
    await screen.findByTestId("session-2")
    await user.click(screen.getByRole("button", { name: /Export all/ }))
    await user.click(await screen.findByRole("menuitem", { name: /JSON/ }))
    const [name, json] = vi.mocked(downloadText).mock.calls.at(-1)!
    expect(name).toMatch(/activity-/)
    const parsed = JSON.parse(json)
    expect(parsed.sessions.map((s: { number: number }) => s.number)).toEqual([2, 1])
    expect(parsed.filters).toEqual({ status: "failed" })
  })

  it("has nothing to export when no session matches", async () => {
    useSessions()
    renderApp("/activity?kind=%22%2Fnope%22")
    expect(await screen.findByText("Nothing matches")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /Export all/ })).not.toBeInTheDocument()
  })
})
