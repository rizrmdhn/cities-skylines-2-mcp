#!/usr/bin/env node
/**
 * Builds the desktop app into dist/, the only folder it reads at runtime:
 *   dist/main.cjs     main process (src/main.ts + web/server cores + zod + dotenv), Electron external
 *   dist/renderer/    copy of web/dist (build the web app first: npm --prefix ../web run build)
 *   dist/assets/      icons
 *
 *   node scripts/build.mjs           build
 *   node scripts/build.mjs --watch   rebuild the main process on change (renderer copied once)
 */
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs"
import { fileURLToPath } from "node:url"

import { build, context } from "esbuild"

const root = fileURLToPath(new URL("..", import.meta.url))
const dist = `${root}dist`
const webDist = fileURLToPath(new URL("../../web/dist", import.meta.url))
const watch = process.argv.includes("--watch")

if (!existsSync(`${webDist}/index.html`)) {
  console.error(
    "The web app is not built (web/dist/index.html is missing). Run `npm --prefix web run build` " +
      "at the repo root, or `npm run desktop:build`, first."
  )
  process.exit(1)
}

rmSync(dist, { recursive: true, force: true })
mkdirSync(dist, { recursive: true })
cpSync(webDist, `${dist}/renderer`, { recursive: true })
cpSync(`${root}assets`, `${dist}/assets`, { recursive: true })

/** @type {import("esbuild").BuildOptions} */
const options = {
  entryPoints: [`${root}src/main.ts`],
  outfile: `${dist}/main.cjs`,
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node24",
  external: ["electron"],
  sourcemap: "linked",
  logLevel: "info",
  legalComments: "none",
}

if (watch) {
  const ctx = await context(options)
  await ctx.watch()
  console.log("watching src/ (restart Electron to pick up changes)")
} else {
  await build(options)
  console.log("desktop app built in dist/")
}
