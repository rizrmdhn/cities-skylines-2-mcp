import { useLayoutEffect, useState, type RefObject } from "react"

import type { Size } from "@/lib/world"

/** The element's CSS size, kept current with a ResizeObserver. */
export function useElementSize(ref: RefObject<HTMLElement | null>): Size | undefined {
  const [size, setSize] = useState<Size>()

  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    const measure = () => {
      const rect = element.getBoundingClientRect()
      setSize((previous) =>
        previous && previous.width === rect.width && previous.height === rect.height
          ? previous
          : { width: rect.width, height: rect.height }
      )
    }
    measure()
    if (typeof ResizeObserver === "undefined") return
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [ref])

  return size
}
