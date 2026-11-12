import { afterEach, describe, expect, it, vi } from "vitest"

import { downloadText } from "@/features/activity/download"

describe("downloadText", () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it("clicks a temporary download link for a Blob and cleans up", () => {
    vi.useFakeTimers()
    const blobs: Blob[] = []
    URL.createObjectURL = vi.fn((blob: Blob | MediaSource) => {
      blobs.push(blob as Blob)
      return "blob:companion/1"
    })
    URL.revokeObjectURL = vi.fn()
    const clicked: { download: string; href: string; connected: boolean }[] = []
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      clicked.push({ download: this.download, href: this.href, connected: this.isConnected })
    })

    downloadText("session-1.md", "# Hello", "text/markdown")

    expect(clicked).toEqual([{ download: "session-1.md", href: "blob:companion/1", connected: true }])
    expect(blobs).toHaveLength(1)
    expect(blobs[0].type).toBe("text/markdown;charset=utf-8")
    expect(blobs[0].size).toBe("# Hello".length)
    // the link is gone again, the Blob URL is released a little later
    expect(document.querySelector("a[download]")).toBeNull()
    expect(URL.revokeObjectURL).not.toHaveBeenCalled()
    vi.advanceTimersByTime(10_000)
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:companion/1")
  })
})
