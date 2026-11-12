import { screen, waitFor, within } from "@testing-library/react"
import { http, HttpResponse } from "msw"
import { describe, expect, it } from "vitest"

import * as fixtures from "@/test/fixtures"
import { renderApp } from "@/test/render-app"
import { apiError, server } from "@/test/server"

/** The accordion header of a service; its accessible name starts with the service's name. */
async function service(name: string) {
  return screen.findByRole("button", { name: (accessible) => accessible.startsWith(name) })
}

/** Waits for a service's header to show `text` (its data arrives after the header renders). */
async function expectService(name: string, text: string) {
  await waitFor(async () => expect(await service(name)).toHaveTextContent(text))
}

/** Opens a service and returns its details panel. */
async function openService(user: ReturnType<typeof renderApp>["user"], name: string) {
  const header = await service(name)
  await user.click(header)
  await waitFor(() => expect(header).toHaveAttribute("aria-expanded", "true"))
  return document.getElementById(header.getAttribute("aria-controls")!)!
}

describe("city services", () => {
  it.each([
    ["Traffic", "Good", "82%"],
    ["Electricity", "Watch", "90%"],
    ["Water", "Good", "150%"],
    ["Sewage", "Watch", "100%"],
    ["Garbage & recycling", "Watch", "12"],
    ["Healthcare", "Good", "95%"],
    ["Fire & rescue", "Problem", "92%"],
    ["Police", "Problem", "55%"],
    ["Disaster shelters", "Watch", "80%"],
    ["Education", "Watch", "88%"],
    ["Post", "Good", "100%"],
    ["Parks & leisure", "Good", "98%"],
    ["Welfare", "Problem", "0%"],
    ["Telecom", "No data", "-"],
  ])("rates %s as %s (%s)", async (name, status, value) => {
    renderApp("/")
    await expectService(name, status)
    expect(await service(name)).toHaveTextContent(value)
  })

  it("explains the figures behind a service when it is opened", async () => {
    const { user } = renderApp("/")
    await expectService("Police", "Problem")
    const police = await openService(user, "Police")
    expect(police).toHaveTextContent("5,400 residents underserved · 1 facility")
    expect(police).toHaveTextContent("Buildings covered220 of 400")
    const traffic = await openService(user, "Traffic")
    expect(traffic).toHaveTextContent("2 bottlenecks · 6 roads under 50% flow")
    expect(traffic).toHaveTextContent("Under 25% flow1")
  })

  it("counts the warning icons of each service area", async () => {
    renderApp("/")
    await expectService("Electricity", "5 warnings")
    await expectService("Healthcare", "3 warnings")
    // a fire is a problem even with good fire coverage
    await expectService("Fire & rescue", "2 warnings")
  })

  it("summarises what needs attention", async () => {
    renderApp("/")
    expect(await screen.findByText("3 need attention")).toBeInTheDocument()
    expect(screen.getByText("5 to watch")).toBeInTheDocument()
  })

  it("keeps the other services when one source fails", async () => {
    server.use(http.get("*/api/city/coverage", () => apiError(500, "bridge", "coverage failed")))
    renderApp("/")
    expect(await screen.findByText("coverage failed")).toBeInTheDocument()
    await expectService("Water", "Good")
  })

  it("flags power shortages", async () => {
    server.use(
      http.get("*/api/city/services", () =>
        HttpResponse.json({
          ...fixtures.services,
          electricity: { ...fixtures.services.electricity, fulfilledConsumption: 500 },
        })
      )
    )
    renderApp("/")
    await expectService("Electricity", "Problem")
    expect(await service("Electricity")).toHaveTextContent("50%")
  })
})

describe("in-game panel figures", () => {
  it("are only requested once a service is opened", async () => {
    const views: string[] = []
    server.use(
      http.get("*/api/city/infoview", ({ request }) => {
        const view = new URL(request.url).searchParams.get("view") ?? ""
        views.push(view)
        return HttpResponse.json(fixtures.infoviews[view] ?? { view, refreshed: true, refreshError: null, values: {} })
      })
    )
    const { user } = renderApp("/")
    await expectService("Education", "Watch")
    expect(views).toEqual([])
    await openService(user, "Education")
    await waitFor(() => expect(views).toEqual(["education"]))
  })

  it("show students, eligible citizens and capacity per school level", async () => {
    const { user } = renderApp("/")
    const education = await openService(user, "Education")
    const elementary = await within(education).findByRole("group", { name: "Elementary school" })
    expect(elementary).toHaveTextContent("3,952 students")
    expect(elementary).toHaveTextContent("Eligible: 5,167")
    expect(elementary).toHaveTextContent("Capacity: 4,400")
    expect(within(education).getByRole("group", { name: "University" })).toHaveTextContent("Capacity: 24,850")
    // the raw education distribution
    expect(education).toHaveTextContent("Poorly Educated13.8")
  })

  it("mark use above capacity and figures the panel could not recalculate", async () => {
    const { user } = renderApp("/")
    const healthcare = await openService(user, "Healthcare")
    const patients = await within(healthcare).findByRole("group", { name: "Patients" })
    expect(patients).toHaveTextContent("Capacity: 150 (over capacity)")
    expect(healthcare).toHaveTextContent("Could not recalculate the panel (job not ready)")
    expect(healthcare).toHaveTextContent("Sick citizens240")
  })

  it("ask for a game restart while the running mod has no info view support", async () => {
    server.use(
      http.get("*/api/city/infoview", () => apiError(404, "bridge", "unknown endpoint: /city/infoview"))
    )
    const { user } = renderApp("/")
    const education = await openService(user, "Education")
    expect(await within(education).findByText("Panel figures need the updated mod")).toBeInTheDocument()
  })

  it("list the warning icons of the service", async () => {
    const { user } = renderApp("/")
    const electricity = await openService(user, "Electricity")
    const icons = await within(electricity).findByRole("list", { name: "Warning icons" })
    expect(icons).toHaveTextContent("No Electricity5")
  })
})

describe("happiness", () => {
  it("lists what lowers and what raises happiness", async () => {
    renderApp("/")
    const lowering = await screen.findByRole("list", { name: "Lowering happiness" })
    const lowered = within(lowering).getAllByRole("listitem")
    expect(lowered[0]).toHaveAccessibleName("Taxes -6")
    expect(lowered[0]).toHaveTextContent("wellbeing -6 · health 0")
    expect(lowered[1]).toHaveAccessibleName("Noise pollution -3")

    const raising = screen.getByRole("list", { name: "Raising happiness" })
    const raised = within(raising).getAllByRole("listitem")
    expect(raised[0]).toHaveAccessibleName("Leisure +7")
    expect(raised[1]).toHaveAccessibleName("Healthcare +4")
  })

  it("says when there are no factors yet", async () => {
    server.use(
      http.get("*/api/city/happiness", () => HttpResponse.json({ ...fixtures.happiness, factors: [] }))
    )
    renderApp("/")
    expect(await screen.findByText(/No factors yet/)).toBeInTheDocument()
  })
})

describe("warnings", () => {
  it("lists every warning type, most frequent first, with its service area", async () => {
    renderApp("/")
    const list = await screen.findByRole("list", { name: "Warning types" })
    const items = within(list).getAllByRole("listitem")
    expect(items[0]).toHaveTextContent("Garbage Piling Up")
    expect(items[0]).toHaveTextContent("Garbage")
    expect(items[0]).toHaveTextContent("12")
    expect(within(list).getByText("Mystery Warning").closest("li")).toHaveTextContent("Other")
    expect(screen.getByText("23 total")).toBeInTheDocument()
  })

  it("says when the city has no warnings", async () => {
    server.use(
      http.get("*/api/city/notifications", () => HttpResponse.json({ total: 0, countsByType: {} }))
    )
    renderApp("/")
    expect(await screen.findByText("No warnings")).toBeInTheDocument()
  })
})
