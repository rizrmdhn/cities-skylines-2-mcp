/**
 * Opens the app's own folders in the system file manager, for the settings page's About section:
 *
 *   GET  /api/desktop/app-folders               { "logs": "<path>", "settings": "<path>" }
 *   POST /api/desktop/app-folders/open-logs     opens the log folder (main.log)
 *   POST /api/desktop/app-folders/open-settings opens the profile folder (settings.json)
 *
 * The paths are fixed by the main process; the renderer only picks one of the two by route and
 * can never pass a path.
 */
import { mkdir } from "node:fs/promises"

import { defineFeature, type DesktopFeature } from "../context.ts"
import { RouteError } from "../routes.ts"

/** Opens a folder; resolves "" on success or an error message (Electron's shell.openPath contract). */
export type OpenFolder = (path: string) => Promise<string>

/** The real opener: creates the folder if needed, then asks the shell to show it. */
const openWithShell: OpenFolder = async (path) => {
  await mkdir(path, { recursive: true })
  const { shell } = await import("electron")
  return shell.openPath(path)
}

/** The feature with an injectable opener (tests pass a fake; the app uses the shell). */
export function createAppFolders(openFolder: OpenFolder = openWithShell): DesktopFeature {
  return defineFeature({
    id: "app-folders",
    setup(ctx) {
      const folders = { logs: ctx.paths.logs, settings: ctx.paths.userData }

      async function open(which: keyof typeof folders) {
        const path = folders[which]
        let failure: string
        try {
          failure = await openFolder(path)
        } catch (err) {
          failure = err instanceof Error ? err.message : String(err)
        }
        if (failure) {
          ctx.log.warn(`could not open the ${which} folder ${path}: ${failure}`)
          throw new RouteError(500, `could not open the ${which} folder: ${failure}`)
        }
      }

      ctx.routes.get("/desktop/app-folders", () => folders)
      ctx.routes.post("/desktop/app-folders/open-logs", () => open("logs"))
      ctx.routes.post("/desktop/app-folders/open-settings", () => open("settings"))
    },
  })
}

export default createAppFolders()
