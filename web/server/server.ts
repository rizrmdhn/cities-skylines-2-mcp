import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"

import { createCompanionHandler, type CompanionHandlerOptions } from "./handler.ts"
import { createStaticServer } from "./static.ts"

export interface CompanionServerOptions
  extends Omit<CompanionHandlerOptions, "getPort" | "serveStatic"> {
  /** Built web app to serve outside /api; omit to serve only the API. */
  staticDir?: string
  /** Sent as X-CS2MCP-Companion on every response, so the desktop launcher can tell it is ours. */
  version?: string
}

export const COMPANION_HEADER = "X-CS2MCP-Companion"

export function createCompanionServer(options: CompanionServerOptions): Server {
  const server = createServer()
  const handle = createCompanionHandler({
    bridgeUrl: options.bridgeUrl,
    token: options.token,
    getPort: () => (server.address() as AddressInfo | null)?.port,
    serveStatic: options.staticDir ? createStaticServer(options.staticDir) : undefined,
  })
  server.on("request", (req, res) => {
    if (options.version) res.setHeader(COMPANION_HEADER, options.version)
    handle(req, res)
      .then((handled) => {
        if (!handled) res.writeHead(404).end()
      })
      .catch((err: unknown) => {
        console.error("web companion request failed:", err)
        if (!res.headersSent) res.writeHead(500)
        res.end()
      })
  })
  return server
}
