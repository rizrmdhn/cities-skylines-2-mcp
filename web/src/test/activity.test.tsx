import { screen, waitFor, within } from "@testing-library/react"
import { http, HttpResponse } from "msw"
import { describe, expect, it } from "vitest"

import * as fixtures from "@/test/fixtures"
import { renderApp } from "@/test/render-app"
import { server } from "@/test/server"

function rows() {
  return screen.getAllByRole("row").slice(1) // skip the header row
}

async function findTable() {
  await screen.findByRole("link", { name: "place" })
  return rows()
}

function mapLinkSearch(link: HTMLElement) {
  return new URL(link.getAttribute("href")!, "http://localhost").searchParams
}

describe("AI activity", () => {
  it("lists every change newest first", async () => {
    renderApp("/activity")
    const list = await findTable()
    expect(list).toHaveLength(5)
    expect(list[0]).toHaveTextContent("place")
    expect(list[0]).toHaveTextContent("-¢48,000")
    expect(list[0]).toHaveTextContent("Done")
    expect(list[2]).toHaveTextContent("Failed 400")
    expect(list[4]).toHaveTextContent("batch")
    expect(screen.getByText(/Showing 5 of 5 changes/)).toBeInTheDocument()
  })

  it("filters by result", async () => {
    const { user, router } = renderApp("/activity")
    await findTable()
    await user.click(screen.getByRole("button", { name: "Failed" }))
    await waitFor(() => expect(rows()).toHaveLength(1))
    expect(rows()[0]).toHaveTextContent("zone")
    expect(router.state.location.search).toMatchObject({ status: "failed" })
  })

  it("filters by action", async () => {
    const { user, router } = renderApp("/activity")
    await findTable()
    await user.click(screen.getByRole("combobox", { name: "Action" }))
    await user.click(await screen.findByRole("option", { name: "road" }))
    await waitFor(() => expect(rows()).toHaveLength(1))
    expect(rows()[0]).toHaveTextContent("road")
    expect(router.state.location.search).toMatchObject({ kind: "/build/road" })
  })

  it("restores filters from the URL", async () => {
    renderApp("/activity?status=ok&kind=%22%2Fbuild%2Froad%22")
    await screen.findByRole("link", { name: "road" })
    expect(rows()).toHaveLength(1)
    expect(screen.getByRole("button", { name: "Done" })).toHaveAttribute("aria-pressed", "true")
  })

  it("opens a change's parameters and result, and closes them again", async () => {
    const { user, router } = renderApp("/activity")
    await findTable()
    await user.click(screen.getByRole("link", { name: "place" }))

    const sheet = await screen.findByRole("dialog")
    expect(within(sheet).getByText("ElementarySchool01")).toBeInTheDocument()
    expect(within(sheet).getByText(/"placed": true/)).toBeInTheDocument()
    expect(router.state.location.search).toMatchObject({ entry: 5 })

    await user.click(within(sheet).getByRole("button", { name: "Close" }))
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
    expect(router.state.location.search).not.toHaveProperty("entry")
  })

  it("opens a change straight from the URL", async () => {
    renderApp("/activity?entry=3")
    const sheet = await screen.findByRole("dialog")
    expect(within(sheet).getByText(/area is not zonable/)).toBeInTheDocument()
  })

  it.each([
    [5, { cx: "121", cz: "-340", sel: "p:121,-340" }],
    [4, { cx: "200", cz: "150", sel: "l:0,0,400,300" }],
    [3, { cx: "1000", cz: "2000", sel: "p:1000,2000" }],
  ])("links change %i to its position on the map", async (id, expected) => {
    renderApp(`/activity?entry=${id}`)
    const link = await within(await screen.findByRole("dialog")).findByRole("link", {
      name: "Show on map",
    })
    const search = mapLinkSearch(link)
    expect(search.get("cx")).toBe(expected.cx)
    expect(search.get("cz")).toBe(expected.cz)
    expect(search.get("zoom")).toBe("5")
    expect(search.get("sel")).toBe(expected.sel)
  })

  it("offers no map link for a change without a position", async () => {
    renderApp("/activity?entry=2")
    const sheet = await screen.findByRole("dialog")
    expect(within(sheet).getByText("rate")).toBeInTheDocument()
    expect(within(sheet).queryByRole("link", { name: "Show on map" })).not.toBeInTheDocument()
  })

  it("says so when nothing has changed yet", async () => {
    server.use(
      http.get("*/api/history", () =>
        HttpResponse.json({ ...fixtures.history, total: 0, returned: 0, entries: [] })
      )
    )
    renderApp("/activity")
    expect(await screen.findByText("No changes yet")).toBeInTheDocument()
  })

  it("shows spending when no limit is set", async () => {
    server.use(
      http.get("*/api/history", () =>
        HttpResponse.json({
          ...fixtures.history,
          spendingLimit: null,
          spendingLimitRemaining: null,
        })
      )
    )
    renderApp("/activity")
    expect(await screen.findByText(/No spending limit is set/)).toBeInTheDocument()
    expect(screen.getByText("¢60,000")).toBeInTheDocument()
  })
})
