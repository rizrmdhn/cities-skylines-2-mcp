#!/usr/bin/env node
/**
 * Builds the desktop app into dist/, the only folder it reads at runtime:
 *   dist/main.cjs     main process (src/main.ts + web/server cores + zod + dotenv), Electron external
 *   dist/renderer/    copy of web/dist (build the web app first: npm --prefix ../web run build)
 *   dist/assets/      icons
 *   dist/mcp-server/  the MCP server (mcp-server/src) as one ESM file, bin/index.mjs, run by the
 *                     setup wizard's client configs with the app's own Electron binary as Node
 *
 *   node scripts/build.mjs           build
 *   node scripts/build.mjs --watch   rebuild the main process on change (renderer copied once)
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
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

/**
 * The MCP server as ONE self-contained file (SDK, zod and dotenv inlined), so a client needs no Node
 * and no node_modules: it runs it as `ELECTRON_RUN_AS_NODE=1 "<app>.exe" "<this file>"`.
 *
 * ESM, not CJS: the server uses top-level await. Layout mirrors mcp-server/ so its two
 * `new URL("../...", import.meta.url)` lookups keep working without touching its source:
 *   dist/mcp-server/bin/index.mjs   (mcp-server/dist/index.js)
 *   dist/mcp-server/package.json    (../package.json: the version the server reports)
 *   dist/mcp-server/.env            (../.env: optional; absent in the app)
 * The banner gives bundled CommonJS dependencies a working require().
 */
async function buildMcpServer() {
  const serverRoot = fileURLToPath(new URL("../../mcp-server/", import.meta.url))
  const entry = `${serverRoot}src/index.ts`
  if (!existsSync(`${serverRoot}node_modules`)) {
    console.error("mcp-server/ has no node_modules. Run `npm run setup` at the repo root first.")
    process.exit(1)
  }
  const outDir = `${dist}/mcp-server`
  await build({
    entryPoints: [entry],
    outfile: `${outDir}/bin/index.mjs`,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    sourcemap: false,
    logLevel: "info",
    legalComments: "none",
    banner: {
      js: "import { createRequire as __cs2mcpCreateRequire } from 'node:module'; const require = __cs2mcpCreateRequire(import.meta.url);",
    },
  })
  const { version } = JSON.parse(readFileSync(`${serverRoot}package.json`, "utf8"))
  writeFileSync(
    `${outDir}/package.json`,
    JSON.stringify({ name: "cs2-mcp", version, type: "module", private: true }, null, 2) + "\n"
  )
}

await buildMcpServer()

if (watch) {
  const ctx = await context(options)
  await ctx.watch()
  console.log("watching src/ (restart Electron to pick up changes)")
} else {
  await build(options)
  console.log("desktop app built in dist/")
}
