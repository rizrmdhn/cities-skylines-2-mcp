/// <reference types="vitest/config" />
import type { AddressInfo } from "node:net"
import { resolve } from "node:path"
import tailwindcss from "@tailwindcss/vite"
import { tanstackRouter } from "@tanstack/router-plugin/vite"
import react from "@vitejs/plugin-react"
import { defineConfig, type Plugin } from "vite"

import { loadConfig, readVersion } from "./server/config.ts"
import { createCompanionHandler } from "./server/handler.ts"

/** Dev only: /api goes through the same handler (allowlist, Host/Origin checks, token) as production. */
function companionApi(): Plugin {
  return {
    name: "cs2mcp-companion-api",
    configureServer(server) {
      const config = loadConfig()
      const handle = createCompanionHandler({
        bridgeUrl: config.bridgeUrl,
        token: config.token,
        getPort: () =>
          (server.httpServer?.address() as AddressInfo | null)?.port,
      })
      server.middlewares.use((req, res, next) => {
        handle(req, res).then(
          (handled) => {
            if (!handled) next()
          },
          (err: unknown) => next(err)
        )
      })
    },
  }
}

export default defineConfig({
  plugins: [
    tanstackRouter({ target: "react", autoCodeSplitting: true }),
    react(),
    tailwindcss(),
    companionApi(),
  ],
  define: {
    __APP_VERSION__: JSON.stringify(readVersion()),
  },
  resolve: {
    alias: {
      "@": resolve(import.meta.dirname, "./src"),
    },
  },
  server: {
    host: "127.0.0.1",
  },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: "server",
          environment: "node",
          include: ["server/**/*.test.ts"],
        },
      },
      {
        extends: true,
        test: {
          name: "app",
          environment: "jsdom",
          include: ["src/**/*.test.{ts,tsx}"],
          setupFiles: ["./src/test/setup.ts"],
        },
      },
    ],
  },
})
