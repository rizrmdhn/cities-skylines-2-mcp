import { useEffect, useState } from "react"

/** Changes whenever the light/dark class on <html> changes, so canvas drawings can re-read colours. */
export function useThemeVersion() {
  const [version, setVersion] = useState(0)
  useEffect(() => {
    const observer = new MutationObserver(() => setVersion((v) => v + 1))
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] })
    return () => observer.disconnect()
  }, [])
  return version
}
