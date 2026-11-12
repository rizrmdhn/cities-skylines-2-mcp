import type { DesktopContext } from "./context.ts"

/** GET /api/desktop/info, the web app's "am I in the desktop app?" probe. */
export interface DesktopInfo {
  desktop: true
  version: string
  platform: NodeJS.Platform
  packaged: boolean
  /** Ids of the features that started. */
  features: string[]
}

/** Routes owned by the core, registered before any feature. */
export function registerCoreRoutes(ctx: DesktopContext, featureIds: () => readonly string[]) {
  ctx.routes.get(
    "/desktop/info",
    (): DesktopInfo => ({
      desktop: true,
      version: ctx.version,
      platform: ctx.platform,
      packaged: ctx.isPackaged,
      features: [...featureIds()],
    })
  )
}
