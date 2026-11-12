import { fireEvent, screen, waitFor, within } from "@testing-library/react"
import { http, HttpResponse } from "msw"
import { beforeEach, describe, expect, it } from "vitest"

import * as fixtures from "@/test/fixtures"
import { renderApp } from "@/test/render-app"
import { server } from "@/test/server"

/*
 * The newest session of fixtures.sessionHistory (key 4-1794387605), by when each step started:
 * 1 school (120, -340), 2 batch of three road pieces on z = 300 (the third failed), 3 a tax change
 * without a position, 4 park (500, 100).
 */
const SESSION = "4-1794387605"

beforeEach(() => {
  server.use(http.get("*/api/history", () => HttpResponse.json(fixtures.sessionHistory)))
})

/** The replay bar once the session has loaded (before that it shows a skeleton). */
async function findBar() {
  const bar = await screen.findByRole("region", { name: "Session replay" })
  await within(bar).findByRole("button", { name: "Next step" })
  return bar
}

function stepCounter(bar: HTMLElement) {
  return within(bar).getByText(/^\d+ \/ \d+$/).textContent
}

describe("map replay", () => {
  it("shows the session, the current step and its summary", async () => {
    renderApp(`/map?replay=${SESSION}&step=2`)
    const bar = await findBar()
    expect(within(bar).getByText(/Session 2/)).toBeInTheDocument()
    expect(stepCounter(bar)).toBe("2 / 4")
    expect(within(bar).getByTestId("replay-summary")).toHaveTextContent(
      "batch (3 parts) — failed (1 of 3 parts) — -¢30,000"
    )
    expect(screen.getByTestId("replay-overlay")).toBeInTheDocument()
  })

  it("starts at the first step and clamps a step beyond the end", async () => {
    const first = renderApp(`/map?replay=${SESSION}`)
    expect(stepCounter(await findBar())).toBe("1 / 4")
    first.unmount()

    renderApp(`/map?replay=${SESSION}&step=99`)
    expect(stepCounter(await findBar())).toBe("4 / 4")
  })

  it("pans to the current step, and again when the step changes", async () => {
    const { user, router } = renderApp(`/map?replay=${SESSION}&step=1`)
    const bar = await findBar()
    // the school at (120, -340): zoomed in to at least 4
    await waitFor(() => expect(router.state.location.search).toMatchObject({ cx: 120, cz: -340, zoom: 4 }))

    await user.click(within(bar).getByRole("button", { name: "Next step" }))
    // the batch: centred on its three pieces and zoomed out to fit their 600 m
    await waitFor(() => expect(router.state.location.search).toMatchObject({ cx: 300, cz: 300, zoom: 3.75 }))
    expect(router.state.location.search).toMatchObject({ step: 2 })
  })

  it("steps with previous and next and stops at both ends", async () => {
    const { user, router } = renderApp(`/map?replay=${SESSION}&step=1`)
    const bar = await findBar()
    const previous = within(bar).getByRole("button", { name: "Previous step" })
    const next = within(bar).getByRole("button", { name: "Next step" })
    expect(previous).toBeDisabled()

    await user.click(next)
    await user.click(next)
    await user.click(next)
    expect(stepCounter(bar)).toBe("4 / 4")
    expect(next).toBeDisabled()
    expect(router.state.location.search).toMatchObject({ step: 4 })

    await user.click(previous)
    expect(stepCounter(bar)).toBe("3 / 4")
  })

  it("jumps with the scrubber", async () => {
    const { router } = renderApp(`/map?replay=${SESSION}`)
    const bar = await findBar()
    fireEvent.change(within(bar).getByRole("slider", { name: "Step" }), { target: { value: "4" } })
    await waitFor(() => expect(stepCounter(bar)).toBe("4 / 4"))
    expect(router.state.location.search).toMatchObject({ step: 4 })
  })

  it("plays on its own and pauses", async () => {
    const { user } = renderApp(`/map?replay=${SESSION}&step=1`)
    const bar = await findBar()
    await user.click(within(bar).getByRole("button", { name: "Play" }))
    expect(within(bar).getByRole("button", { name: "Pause" })).toBeInTheDocument()
    await waitFor(() => expect(stepCounter(bar)).toBe("2 / 4"), { timeout: 4_000 })

    await user.click(within(bar).getByRole("button", { name: "Pause" }))
    expect(within(bar).getByRole("button", { name: "Play" })).toBeInTheDocument()
  })

  it("says so when a step has no position, and keeps the map where it is", async () => {
    const { router } = renderApp(`/map?replay=${SESSION}&step=3`)
    const bar = await findBar()
    expect(within(bar).getByText(/no position, so the map stays where it is/)).toBeInTheDocument()
    expect(within(bar).getByTestId("replay-summary")).toHaveTextContent("taxes set")
    expect(router.state.location.search).not.toHaveProperty("cx")
  })

  it("links back to the session and to the step's details", async () => {
    renderApp(`/map?replay=${SESSION}&step=1`)
    const bar = await findBar()
    const back = within(bar).getByRole("link", { name: "Back to session" })
    const backUrl = new URL(back.getAttribute("href")!, "http://localhost")
    expect(backUrl.pathname).toBe("/activity")
    expect(backUrl.searchParams.get("session")).toBe(SESSION)

    const details = within(bar).getByRole("link", { name: /Details/ })
    const detailsUrl = new URL(details.getAttribute("href")!, "http://localhost")
    expect(detailsUrl.searchParams.get("session")).toBe(SESSION)
    expect(detailsUrl.searchParams.get("entry")).toBe("4")
  })

  it("leaves the replay", async () => {
    const { user, router } = renderApp(`/map?replay=${SESSION}&step=2`)
    const bar = await findBar()
    await user.click(within(bar).getByRole("button", { name: "Exit replay" }))
    await waitFor(() => expect(screen.queryByRole("region", { name: "Session replay" })).not.toBeInTheDocument())
    expect(router.state.location.search).not.toHaveProperty("replay")
    expect(router.state.location.search).not.toHaveProperty("step")
    expect(screen.queryByTestId("replay-overlay")).not.toBeInTheDocument()
  })

  it("explains a session that is no longer in the log", async () => {
    renderApp("/map?replay=99-1000")
    const bar = await screen.findByRole("region", { name: "Session replay" })
    expect(await within(bar).findByText(/no longer in the bridge's log/)).toBeInTheDocument()
    expect(within(bar).getByRole("link", { name: "Back to the activity page" })).toBeInTheDocument()
    expect(screen.queryByTestId("replay-overlay")).not.toBeInTheDocument()
  })

  it("is opened from a session on the activity page", async () => {
    const { user, router } = renderApp("/activity")
    const newest = await screen.findByTestId("session-2")
    await user.click(within(newest).getByRole("link", { name: "Replay session 2 on the map" }))
    const bar = await findBar()
    expect(stepCounter(bar)).toBe("1 / 4")
    expect(router.state.location.pathname).toBe("/map")
  })
})
