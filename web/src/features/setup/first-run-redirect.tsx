import { useLocation, useNavigate } from "@tanstack/react-router"
import { useEffect, useRef } from "react"

import { useDesktopSettings } from "@/features/settings/use-settings"
import { useDesktop } from "@/lib/desktop"

/**
 * Sends the first launch of the desktop app from the landing page to the setup wizard (once per
 * page load, only from "/", so a notification's deep link is never hijacked). Renders nothing.
 * `setup.completed` is written by the wizard's Finish and Skip buttons.
 */
export function FirstRunRedirect() {
  const { info } = useDesktop()
  const pathname = useLocation({ select: (location) => location.pathname })
  const navigate = useNavigate()
  const settings = useDesktopSettings()
  const done = useRef(false)

  const needsSetup = info?.features.includes("setup") === true && settings.data?.["setup.completed"] === false
  useEffect(() => {
    if (done.current || !needsSetup) return
    done.current = true
    if (pathname === "/") void navigate({ to: "/setup", replace: true })
  }, [needsSetup, pathname, navigate])
  return null
}
