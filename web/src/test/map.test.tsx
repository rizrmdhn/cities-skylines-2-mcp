import { screen, waitFor, within } from "@testing-library/react"
import { http, HttpResponse } from "msw"
import { describe, expect, it, vi } from "vitest"

import * as fixtures from "@/test/fixtures"
import { renderApp } from "@/test/render-app"
import { server } from "@/test/server"

/*
 * The canvas is 800 x 600 (see setup.ts) and the default view shows the whole 14,336 m world at
 * 600 / 14,336 px per metre, centred on (0, 0). So 100 px right of the centre is x = 2389 and
 * 100 px above it is z = 2389.
 */
const CENTRE = { clientX: 400, clientY: 300 }
const RIGHT_100_UP_50 = { clientX: 500, clientY: 250 }
const RIGHT_100_UP_100 = { clientX: 500, clientY: 200 }

async function findMap() {
  return screen.findByTestId("city-map")
}

function selectionText() {
  return screen.getByTestId("selection-coordinates").textContent
}

describe("map", () => {
  it("turns a click into world coordinates and prompts", async () => {
    const { user, router } = renderApp("/map")
    const map = await findMap()
    await user.pointer({ keys: "[MouseLeft]", target: map, coords: RIGHT_100_UP_50 })

    await waitFor(() => expect(selectionText()).toBe("x=2389, z=1195"))
    expect(router.state.location.search).toMatchObject({ sel: "p:2389,1195" })
    // the land value of the cell under the point (fixture cell 10) goes into the prompt
    expect(
      await screen.findByText("Place a building at (2389, 1195) (land value 10.0).")
    ).toBeInTheDocument()
  })

  it("copies a prompt to the clipboard", async () => {
    const { user } = renderApp("/map?sel=%22p%3A10%2C20%22")
    await screen.findByTestId("selection-coordinates")
    await user.click(screen.getByRole("button", { name: "Copy: Coordinates" }))
    expect(await navigator.clipboard.readText()).toBe("x=10, z=20")
    expect(await screen.findByText("Copied to the clipboard")).toBeInTheDocument()
  })

  it("marks an area by dragging in area mode", async () => {
    const { user } = renderApp("/map?mode=box")
    const map = await findMap()
    await user.pointer([
      { keys: "[MouseLeft>]", target: map, coords: CENTRE },
      { target: map, coords: RIGHT_100_UP_100 },
      { keys: "[/MouseLeft]", target: map, coords: RIGHT_100_UP_100 },
    ])

    await waitFor(() => expect(selectionText()).toBe("(0, 0) to (2389, 2389)"))
    expect(screen.getByText(/2389 × 2389 m/)).toBeInTheDocument()
    expect(
      screen.getByText("Zone residential in the area from (0, 0) to (2389, 2389).")
    ).toBeInTheDocument()
  })

  it("draws a route by dragging in line mode", async () => {
    const { user, router } = renderApp("/map?mode=line")
    const map = await findMap()
    await user.pointer([
      { keys: "[MouseLeft>]", target: map, coords: CENTRE },
      { target: map, coords: RIGHT_100_UP_100 },
      { keys: "[/MouseLeft]", target: map, coords: RIGHT_100_UP_100 },
    ])

    await waitFor(() => expect(selectionText()).toBe("(0, 0) to (2389, 2389)"))
    expect(screen.getByText(/3379 m long/)).toBeInTheDocument()
    expect(
      screen.getByText("Build a two-lane road from (0, 0) to (2389, 2389).")
    ).toBeInTheDocument()
    expect(router.state.location.search).toMatchObject({ sel: "l:0,0,2389,2389" })
  })

  it("switches the selection mode from the toolbar", async () => {
    const { user, router } = renderApp("/map")
    await findMap()
    await user.click(screen.getByRole("button", { name: /^Area/ }))
    await waitFor(() => expect(router.state.location.search).toMatchObject({ mode: "box" }))
  })

  it("shows the coordinates and value under the pointer", async () => {
    const { user } = renderApp("/map")
    const map = await findMap()
    await screen.findByText("land value per cell")
    await user.pointer({ target: map, coords: RIGHT_100_UP_50 })
    expect(screen.getByTestId("pointer-readout")).toHaveTextContent("x 2389 · z 1195 · 10.0")
  })

  it("restores the layer, mode and selection from the URL", async () => {
    const layers: string[] = []
    server.use(
      http.get("*/api/city/gridmap", ({ request }) => {
        layers.push(new URL(request.url).searchParams.get("layer") ?? "")
        return HttpResponse.json({ ...fixtures.gridmap, layer: "airPollution" })
      })
    )
    renderApp("/map?layer=airPollution&mode=line&sel=%22p%3A10%2C20%22")
    await findMap()

    expect(screen.getByRole("combobox", { name: "Data layer" })).toHaveTextContent("Air pollution")
    expect(screen.getByRole("button", { name: /^Line/ })).toHaveAttribute("aria-pressed", "true")
    expect(selectionText()).toBe("x=10, z=20")
    await waitFor(() => expect(layers).toContain("airPollution"))
  })

  it("loads another data layer when one is picked", async () => {
    const layers: string[] = []
    server.use(
      http.get("*/api/city/gridmap", ({ request }) => {
        layers.push(new URL(request.url).searchParams.get("layer") ?? "")
        return HttpResponse.json(fixtures.gridmap)
      })
    )
    const { user, router } = renderApp("/map")
    await findMap()
    await user.click(screen.getByRole("combobox", { name: "Data layer" }))
    await user.click(await screen.findByRole("option", { name: "Noise pollution" }))
    await waitFor(() => expect(layers).toContain("noisePollution"))
    expect(router.state.location.search).toMatchObject({ layer: "noisePollution" })
  })

  it("clears the selection", async () => {
    const { user, router } = renderApp("/map?sel=%22p%3A10%2C20%22")
    await screen.findByTestId("selection-coordinates")
    await user.click(screen.getByRole("button", { name: "Clear selection" }))
    expect(await screen.findByText("Pick a location")).toBeInTheDocument()
    expect(router.state.location.search).not.toHaveProperty("sel")
  })

  it("ignores a malformed selection in the URL", async () => {
    renderApp("/map?sel=%22nonsense%22")
    await findMap()
    expect(screen.getByText("Pick a location")).toBeInTheDocument()
  })

  it("shows where the game camera looks", async () => {
    renderApp("/map")
    expect(await screen.findByText("Looking at x 500, z -250")).toBeInTheDocument()
  })

  describe("roads", () => {
    /** The map container measures 800 x 600 like the canvas, so the view decides the tiles. */
    function sizeMapContainer() {
      return vi.spyOn(HTMLDivElement.prototype, "getBoundingClientRect").mockReturnValue({
        x: 0,
        y: 0,
        left: 0,
        top: 0,
        right: 800,
        bottom: 600,
        width: 800,
        height: 600,
        toJSON: () => ({}),
      } as DOMRect)
    }

    /** An older mod without /city/road-network: the map falls back to road-graph tiles. */
    function recordRoadRequests() {
      const requests: string[] = []
      server.use(
        http.get("*/api/city/road-network", () =>
          HttpResponse.json(
            { error: "unknown endpoint: /city/road-network", status: 404, kind: "bridge" },
            { status: 404 }
          )
        ),
        http.get("*/api/city/road-graph", ({ request }) => {
          const params = new URL(request.url).searchParams
          requests.push(`${params.get("x")},${params.get("z")},${params.get("radius")}`)
          return HttpResponse.json(fixtures.roadGraph)
        })
      )
      return requests
    }

    it("loads the 2048 m tiles the view overlaps once zoomed in", async () => {
      const spy = sizeMapContainer()
      const requests = recordRoadRequests()
      renderApp("/map?zoom=3")
      await waitFor(() => expect(requests).toHaveLength(3))
      expect(requests.sort()).toEqual(["-2048,0,1449", "0,0,1449", "2048,0,1449"])
      expect(screen.queryByText("Zoom in to see roads")).not.toBeInTheDocument()
      spy.mockRestore()
    })

    it("loads no roads while zoomed out", async () => {
      const spy = sizeMapContainer()
      const requests = recordRoadRequests()
      renderApp("/map")
      expect(await screen.findByText("Zoom in to see roads")).toBeInTheDocument()
      await screen.findByText("land value per cell")
      expect(requests).toHaveLength(0)
      spy.mockRestore()
    })

    it("serves tiles it already has from the cache", async () => {
      const spy = sizeMapContainer()
      const requests = recordRoadRequests()
      const { router } = renderApp("/map?zoom=3")
      await waitFor(() => expect(requests).toHaveLength(3))

      await router.navigate({ to: "/" })
      await router.navigate({ to: "/map", search: { zoom: 3 } })
      await findMap()
      await screen.findByText("land value per cell")
      expect(requests).toHaveLength(3)
      spy.mockRestore()
    })

    it("reloads the tiles on request", async () => {
      const spy = sizeMapContainer()
      const requests = recordRoadRequests()
      const { user } = renderApp("/map?zoom=3")
      await waitFor(() => expect(requests).toHaveLength(3))
      await user.click(screen.getByRole("button", { name: "Reload roads" }))
      await waitFor(() => expect(requests).toHaveLength(6))
      spy.mockRestore()
    })
  })

  it("opens a change from the activity page at its position", async () => {
    const { user } = renderApp("/activity?entry=4")
    const sheet = await screen.findByRole("dialog")
    await user.click(within(sheet).getByRole("link", { name: "Show on map" }))
    await findMap()
    await waitFor(() => expect(selectionText()).toBe("(0, 0) to (400, 300)"))
  })
})
