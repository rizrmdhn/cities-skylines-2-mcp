/**
 * App-wide renderer hardening, applied to every webContents (main window, feature windows):
 *   - no navigation away from app://cs2mcp in any frame, no redirects elsewhere;
 *   - http(s) links that try to leave (target=_blank, window.open, plain navigation) open in the
 *     system browser instead; every other scheme is dropped;
 *   - window.open never creates a window; <webview> is never attached;
 *   - permission requests are denied, except writing to the clipboard (the map's "copy prompt").
 */
import { app, shell, type Session } from "electron"

import { isAppUrl } from "./app-protocol.ts"
import type { Logger } from "./logger.ts"

const ALLOWED_PERMISSIONS = new Set(["clipboard-sanitized-write"])

function openInBrowser(url: string, log: Logger) {
  let protocol: string
  try {
    protocol = new URL(url).protocol
  } catch {
    return
  }
  if (protocol === "http:" || protocol === "https:") {
    shell.openExternal(url).catch((err: unknown) => log.warn(`could not open ${url}`, err))
  } else {
    log.warn(`refused to open ${url}`)
  }
}

/** Devtools pages navigate within devtools://; leave those alone. */
function isAllowedNavigation(url: string) {
  return isAppUrl(url) || url.startsWith("devtools://")
}

export function installSecurity(session: Session, log: Logger) {
  app.on("web-contents-created", (_event, contents) => {
    contents.setWindowOpenHandler(({ url }) => {
      openInBrowser(url, log)
      return { action: "deny" }
    })
    contents.on("will-frame-navigate", (event) => {
      if (isAllowedNavigation(event.url)) return
      event.preventDefault()
      if (event.isMainFrame) openInBrowser(event.url, log)
    })
    contents.on("will-redirect", (event) => {
      if (!isAllowedNavigation(event.url)) event.preventDefault()
    })
    contents.on("will-attach-webview", (event) => event.preventDefault())
  })

  session.setPermissionRequestHandler((_contents, permission, callback, details) => {
    callback(ALLOWED_PERMISSIONS.has(permission) && isAppUrl(details.requestingUrl))
  })
  session.setPermissionCheckHandler(
    (_contents, permission, requestingOrigin) =>
      ALLOWED_PERMISSIONS.has(permission) && isAppUrl(requestingOrigin)
  )
}
