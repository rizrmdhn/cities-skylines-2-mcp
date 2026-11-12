import { screen, waitFor, within } from "@testing-library/react"
import { delay, http, HttpResponse } from "msw"
import { describe, expect, it } from "vitest"

import type { GameState } from "@/lib/bridge-types"
import { applySimulationChange, speedLabel } from "@/lib/simulation"
import * as fixtures from "@/test/fixtures"
import { renderApp } from "@/test/render-app"
import { apiError, server } from "@/test/server"

type Simulation = NonNullable<GameState["simulation"]>

/**
 * A bridge whose clock the control route really changes, so the refetch after a click shows the
 * new state. Records every control request; `hold` delays its answer until released.
 */
function liveBridge(initial: Partial<Simulation> = {}) {
  const sim: Simulation = { ...fixtures.state.simulation!, ...initial }
  const controls: { method: string; search: string }[] = []
  let stateRequests = 0
  let overviewRequests = 0
  let release: () => void = () => {}
  let held: Promise<void> | undefined
  server.use(
    http.get("*/api/state", () => {
      stateRequests++
      return HttpResponse.json({ ...fixtures.state, simulation: { ...sim } })
    }),
    http.get("*/api/city/overview", () => {
      overviewRequests++
      return HttpResponse.json({
        ...fixtures.overview,
        simulationPaused: sim.paused,
        simulationSpeed: sim.selectedSpeed,
      })
    }),
    http.post("*/api/sim/control", async ({ request }) => {
      const url = new URL(request.url)
      controls.push({ method: request.method, search: url.search })
      if (held) await held
      const params = url.searchParams
      const result = applySimulationChange(sim, {
        speed: params.has("speed") ? Number(params.get("speed")) : undefined,
        paused: params.has("paused") ? params.get("paused") === "true" : undefined,
      })
      Object.assign(sim, result)
      return HttpResponse.json(result)
    })
  )
  return {
    controls,
    stateRequests: () => stateRequests,
    overviewRequests: () => overviewRequests,
    hold() {
      held = new Promise((resolve) => (release = resolve))
    },
    release: () => release(),
  }
}

/** The open tooltip (Base UI's popup carries no ARIA role). */
async function openTooltip() {
  return waitFor(() => {
    const popup = document.querySelector('[data-slot="tooltip-content"]')
    expect(popup).not.toBeNull()
    return popup as HTMLElement
  })
}

async function findControls() {
  return screen.findByRole("group", { name: "Simulation" })
}

function speedButton(group: HTMLElement, name: string) {
  return within(group).getByRole("button", { name })
}

describe("simulation controls", () => {
  it("show the current speed from /state in the header", async () => {
    renderApp("/")
    const group = await findControls()
    expect(speedButton(group, "1× speed")).toHaveAttribute("aria-pressed", "true")
    for (const name of ["2× speed", "4× speed", "8× max speed"]) {
      expect(speedButton(group, name)).toHaveAttribute("aria-pressed", "false")
    }
    expect(speedButton(group, "Pause simulation")).toBeEnabled()
  })

  it("are on every page", async () => {
    renderApp("/activity")
    expect(await findControls()).toBeInTheDocument()
  })

  it("send the speed as a POST, show it at once and refresh /state and the overview", async () => {
    const bridge = liveBridge()
    const { user } = renderApp("/")
    const group = await findControls()
    await screen.findByText("1× speed")
    const stateBefore = bridge.stateRequests()
    const overviewBefore = bridge.overviewRequests()

    bridge.hold()
    await user.click(speedButton(group, "8× max speed"))
    // Optimistic: pressed before the bridge answered, in the header and the city card.
    expect(speedButton(group, "8× max speed")).toHaveAttribute("aria-pressed", "true")
    expect(speedButton(group, "1× speed")).toHaveAttribute("aria-pressed", "false")
    expect(screen.getByText("8× speed (max)")).toBeInTheDocument()
    expect(bridge.controls).toEqual([{ method: "POST", search: "?speed=8" }])

    bridge.release()
    await waitFor(() => expect(bridge.stateRequests()).toBeGreaterThan(stateBefore))
    await waitFor(() => expect(bridge.overviewRequests()).toBeGreaterThan(overviewBefore))
    expect(speedButton(group, "8× max speed")).toHaveAttribute("aria-pressed", "true")
  })

  it("pause, then resume at the speed it ran at", async () => {
    const bridge = liveBridge({ selectedSpeed: 2 })
    const { user } = renderApp("/")
    const group = await findControls()
    await waitFor(() => expect(speedButton(group, "2× speed")).toHaveAttribute("aria-pressed", "true"))

    await user.click(speedButton(group, "Pause simulation"))
    const resume = await within(group).findByRole("button", { name: "Resume simulation" })
    for (const name of ["1× speed", "2× speed", "4× speed", "8× max speed"]) {
      expect(speedButton(group, name)).toHaveAttribute("aria-pressed", "false")
    }
    expect(await screen.findByText("Paused")).toBeInTheDocument()

    await user.click(resume)
    await waitFor(() => expect(speedButton(group, "2× speed")).toHaveAttribute("aria-pressed", "true"))
    expect(bridge.controls.map((c) => c.search)).toEqual(["?paused=true", "?speed=2"])
  })

  it("resume with paused=false when it never saw the game running", async () => {
    const bridge = liveBridge({ paused: true, selectedSpeed: 0 })
    const { user } = renderApp("/")
    const group = await findControls()
    await user.click(await within(group).findByRole("button", { name: "Resume simulation" }))
    await waitFor(() => expect(speedButton(group, "1× speed")).toHaveAttribute("aria-pressed", "true"))
    expect(bridge.controls.map((c) => c.search)).toEqual(["?paused=false"])
  })

  it("leave the speed alone when the pressed speed is clicked again", async () => {
    const bridge = liveBridge()
    const { user } = renderApp("/")
    const group = await findControls()
    await user.click(speedButton(group, "1× speed"))
    expect(speedButton(group, "1× speed")).toHaveAttribute("aria-pressed", "true")
    expect(bridge.controls).toEqual([])
  })

  it("work from the keyboard", async () => {
    const bridge = liveBridge()
    const { user } = renderApp("/")
    const group = await findControls()
    speedButton(group, "2× speed").focus()
    await user.keyboard("{Enter}")
    await waitFor(() => expect(speedButton(group, "2× speed")).toHaveAttribute("aria-pressed", "true"))
    expect(bridge.controls.map((c) => c.search)).toEqual(["?speed=2"])
  })

  it("roll back and show the bridge's error when the change fails", async () => {
    const bridge = liveBridge()
    server.use(
      http.post("*/api/sim/control", async () => {
        bridge.controls.push({ method: "POST", search: "refused" })
        await delay(50)
        return apiError(409, "bridge", "no city loaded")
      })
    )
    const { user } = renderApp("/")
    const group = await findControls()
    await screen.findByText("1× speed")

    await user.click(speedButton(group, "4× speed"))
    expect(speedButton(group, "4× speed")).toHaveAttribute("aria-pressed", "true")
    expect(await screen.findByText("Could not change the simulation speed")).toBeInTheDocument()
    expect(screen.getByText("no city loaded")).toBeInTheDocument()
    expect(speedButton(group, "1× speed")).toHaveAttribute("aria-pressed", "true")
    expect(speedButton(group, "4× speed")).toHaveAttribute("aria-pressed", "false")
    expect(screen.getByText("1× speed")).toBeInTheDocument()
    expect(bridge.controls).toHaveLength(1)
  })

  it("are disabled with an explanation in read-only mode", async () => {
    const bridge = liveBridge()
    server.use(http.get("*/api/ping", () => HttpResponse.json({ ...fixtures.ping, readOnly: true })))
    const { user } = renderApp("/")
    const group = await findControls()
    await waitFor(() => expect(speedButton(group, "Pause simulation")).toBeDisabled())
    for (const name of ["1× speed", "2× speed", "4× speed", "8× max speed"]) {
      expect(speedButton(group, name)).toBeDisabled()
    }
    expect(group).toHaveAccessibleDescription(/Read-only mode is on in the game/)
    const why = speedButton(group, "Speed controls locked: read-only mode")
    await user.hover(why)
    expect(await openTooltip()).toHaveTextContent(/cannot pause the game or change its speed/)
    expect(bridge.controls).toEqual([])
  })

  it.each([
    ["popup", "Held by a game dialog", /holds the simulation at speed 0 until you close it/],
    ["unfocused", "Game in background", /pauses while it is in the background/],
  ])("explain a pause forced by %s", async (forcedPause, label, text) => {
    liveBridge({ paused: true, selectedSpeed: 0, forcedPause })
    renderApp("/")
    const group = await findControls()
    expect(await within(group).findByRole("button", { name: label })).toBeInTheDocument()
    expect(group).toHaveAccessibleDescription(text)
    expect(speedButton(group, "Resume simulation")).toBeEnabled()
  })

  it("explain that 8× is beyond the game's own fastest speed", async () => {
    const { user } = renderApp("/")
    const group = await findControls()
    await user.hover(speedButton(group, "8× max speed"))
    expect(await openTooltip()).toHaveTextContent(
      /twice the game's fastest speed \(4×\), beyond what the in-game controls offer/
    )
  })

  it("are hidden while no city is loaded", async () => {
    server.use(
      http.get("*/api/state", () =>
        HttpResponse.json({ ...fixtures.state, cityLoaded: false, cityName: null, simulation: null })
      )
    )
    renderApp("/")
    expect(await screen.findByRole("alert")).toHaveTextContent("No city loaded")
    expect(screen.queryByRole("group", { name: "Simulation" })).not.toBeInTheDocument()
  })
})

describe("speed labels", () => {
  it("match the controls", () => {
    expect(speedLabel(true, 0)).toBe("Paused")
    expect(speedLabel(false, 1)).toBe("1× speed")
    expect(speedLabel(false, 0.5)).toBe("0.5× speed")
    expect(speedLabel(false, 8)).toBe("8× speed (max)")
  })

  it("apply a change the way the bridge does", () => {
    const running = { paused: false, selectedSpeed: 2 }
    expect(applySimulationChange(running, { paused: true })).toEqual({ paused: true, selectedSpeed: 0 })
    expect(applySimulationChange({ paused: true, selectedSpeed: 0 }, { paused: false })).toEqual({
      paused: false,
      selectedSpeed: 1,
    })
    expect(applySimulationChange(running, { speed: 12 })).toEqual({ paused: false, selectedSpeed: 8 })
    expect(applySimulationChange(running, { speed: 0 })).toEqual({ paused: true, selectedSpeed: 0 })
  })
})
