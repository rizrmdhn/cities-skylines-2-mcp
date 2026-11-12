import { http, HttpResponse } from "msw"
import { setupServer } from "msw/node"

import type { DesktopInfo } from "@/lib/desktop"
import * as fixtures from "@/test/fixtures"

/** The /api contract of the web companion, answered with fixtures. Override per test with server.use. */
export const handlers = [
  http.get("*/api/ping", () => HttpResponse.json(fixtures.ping)),
  http.get("*/api/state", () => HttpResponse.json(fixtures.state)),
  http.get("*/api/city/overview", () => HttpResponse.json(fixtures.overview)),
  http.get("*/api/city/demand", () => HttpResponse.json(fixtures.demand)),
  http.get("*/api/history", () => HttpResponse.json(fixtures.history)),
  http.get("*/api/camera", () => HttpResponse.json(fixtures.camera)),
  http.get("*/api/city/gridmap", () => HttpResponse.json(fixtures.gridmap)),
  http.get("*/api/city/road-graph", () => HttpResponse.json(fixtures.roadGraph)),
  http.get("*/api/city/services", () => HttpResponse.json(fixtures.services)),
  http.get("*/api/city/coverage", () => HttpResponse.json(fixtures.coverage)),
  http.get("*/api/city/traffic", () => HttpResponse.json(fixtures.traffic)),
  http.get("*/api/city/notifications", () => HttpResponse.json(fixtures.notifications)),
  http.get("*/api/city/happiness", () => HttpResponse.json(fixtures.happiness)),
  http.get("*/api/city/road-network", () => HttpResponse.json(fixtures.roadNetwork)),
  http.get("*/api/city/infoview", ({ request }) => {
    const view = new URL(request.url).searchParams.get("view") ?? ""
    const infoview = fixtures.infoviews[view]
    return infoview
      ? HttpResponse.json(infoview)
      : HttpResponse.json({ view, refreshed: true, refreshError: null, values: {} })
  }),
  // The browser companion: no desktop routes. Tests opt into the desktop app with enableDesktopMode().
  http.all("*/api/desktop/*", ({ request }) =>
    apiError(404, "companion", `unknown endpoint: ${new URL(request.url).pathname}`)
  ),
]

export const server = setupServer(...handlers)

/** An error body as the companion sends it. */
export function apiError(status: number, kind: "unreachable" | "bridge" | "companion", error: string) {
  return HttpResponse.json({ error, status, kind }, { status })
}

export const desktopInfo: DesktopInfo = {
  desktop: true,
  version: __APP_VERSION__,
  platform: "win32",
  packaged: false,
  features: ["settings-api"],
}

/**
 * Makes the current test run "inside the desktop app": /api/desktop/info answers. Add handlers
 * for the desktop routes a test needs with server.use(http.get("*\/api/desktop/x", ...)).
 */
export function enableDesktopMode(info: Partial<DesktopInfo> = {}) {
  server.use(http.get("*/api/desktop/info", () => HttpResponse.json({ ...desktopInfo, ...info })))
}
