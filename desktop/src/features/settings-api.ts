/**
 * GET/POST /api/desktop/settings: the settings the renderer may see and change. Secrets (the
 * bridge token) are write-only: the answer carries `tokenSet`, never the token.
 */
import { defineFeature, type DesktopContext } from "../context.ts"

function snapshot(ctx: DesktopContext) {
  return {
    ...ctx.settings.toPublic(),
    effective: ctx.bridgeConfig(),
    secretsEncrypted: ctx.settings.secretsEncrypted,
  }
}

export default defineFeature({
  id: "settings-api",
  setup(ctx) {
    ctx.routes.get("/desktop/settings", () => snapshot(ctx))
    ctx.routes.post("/desktop/settings", async (request) => {
      // Validated per key by the schema each setting was defined with; unknown keys are refused.
      await ctx.settings.update(request.body ?? {})
      ctx.log.info(`settings changed: ${Object.keys(request.body ?? {}).join(", ") || "(none)"}`)
      return snapshot(ctx)
    })
  },
})
