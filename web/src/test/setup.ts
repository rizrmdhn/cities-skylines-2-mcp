import "@testing-library/jest-dom/vitest"
import { cleanup, configure } from "@testing-library/react"
import { afterAll, afterEach, beforeAll, vi } from "vitest"

import { server } from "@/test/server"

// The first render of a test file loads every route chunk; give async queries room for it.
configure({ asyncUtilTimeout: 5_000 })

// jsdom has no layout, no canvas and no media queries: give the map a fixed 800 x 600 canvas.
export const CANVAS_SIZE = { width: 800, height: 600 }

Object.defineProperty(window, "matchMedia", {
  configurable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }),
})

HTMLCanvasElement.prototype.getContext = (() => null) as typeof HTMLCanvasElement.prototype.getContext
HTMLCanvasElement.prototype.getBoundingClientRect = () =>
  ({
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    right: CANVAS_SIZE.width,
    bottom: CANVAS_SIZE.height,
    ...CANVAS_SIZE,
    toJSON: () => ({}),
  }) as DOMRect

beforeAll(() => server.listen({ onUnhandledFrame: "error" }))
afterEach(() => {
  cleanup()
  server.resetHandlers()
  localStorage.clear()
  vi.useRealTimers()
})
afterAll(() => server.close())
