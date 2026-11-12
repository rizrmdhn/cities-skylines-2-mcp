import { join } from "node:path"

import { loadConfig, PACKAGE_ROOT } from "./config.ts"
import { createCompanionServer } from "./server.ts"

const config = loadConfig()
const server = createCompanionServer({
  bridgeUrl: config.bridgeUrl,
  token: config.token,
  staticDir: join(PACKAGE_ROOT, "dist"),
  version: config.version,
})

server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    console.error(
      `Port ${config.port} is already in use. The companion may already be running in the ` +
        `background (stop it with npm run web:stop), or set CS2MCP_WEB_PORT to another port.`
    )
  } else {
    console.error(err)
  }
  process.exit(1)
})

// Loopback only: the companion is never reachable from another device.
server.listen(config.port, "127.0.0.1", () => {
  console.log(
    `CS2MCP web companion ${config.version} on http://127.0.0.1:${config.port} (bridge: ${config.bridgeUrl}${config.token ? ", token set" : ""})`
  )
})
