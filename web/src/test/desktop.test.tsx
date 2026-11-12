import { QueryClientProvider } from "@tanstack/react-query"
import { renderHook, waitFor } from "@testing-library/react"
import { http, HttpResponse } from "msw"
import type { ReactNode } from "react"
import { describe, expect, it } from "vitest"

import { ApiError, apiPost } from "@/lib/api"
import { useDesktop } from "@/lib/desktop"
import { createQueryClient } from "@/lib/queries"
import { desktopInfo, enableDesktopMode, server } from "@/test/server"

function renderUseDesktop() {
  const queryClient = createQueryClient()
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )
  return renderHook(() => useDesktop(), { wrapper })
}

describe("useDesktop", () => {
  it("reports the browser companion when /api/desktop/info answers 404, asking once", async () => {
    let calls = 0
    server.events.on("request:start", ({ request }) => {
      if (request.url.endsWith("/api/desktop/info")) calls++
    })
    const { result } = renderUseDesktop()
    expect(result.current.isPending).toBe(true)
    await waitFor(() => expect(result.current.isPending).toBe(false))
    expect(result.current).toEqual({ isDesktop: false, info: undefined, isPending: false })
    expect(calls).toBe(1)
    server.events.removeAllListeners()
  })

  it("reports the desktop app and its info", async () => {
    enableDesktopMode({ features: ["settings-api", "tray"] })
    const { result } = renderUseDesktop()
    await waitFor(() => expect(result.current.isDesktop).toBe(true))
    expect(result.current.info).toEqual({ ...desktopInfo, features: ["settings-api", "tray"] })
  })
})

describe("apiPost", () => {
  it("sends a JSON body and returns the JSON answer", async () => {
    let received: unknown
    server.use(
      http.post("*/api/desktop/settings", async ({ request }) => {
        received = await request.json()
        return HttpResponse.json({ bridgeUrl: "http://127.0.0.1:9000", tokenSet: false })
      })
    )
    const answer = await apiPost<{ bridgeUrl: string }>("/desktop/settings", {
      bridgeUrl: "http://127.0.0.1:9000",
    })
    expect(received).toEqual({ bridgeUrl: "http://127.0.0.1:9000" })
    expect(answer.bridgeUrl).toBe("http://127.0.0.1:9000")
  })

  it("throws an ApiError with the companion's message", async () => {
    const error = await apiPost("/desktop/settings", {}).catch((err: unknown) => err)
    expect(error).toBeInstanceOf(ApiError)
    expect(error).toMatchObject({ status: 404, kind: "companion" })
  })
})
