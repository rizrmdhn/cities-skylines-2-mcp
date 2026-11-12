import { createReadStream } from "node:fs"
import type { IncomingMessage, ServerResponse } from "node:http"

import { resolveStaticFile } from "./static-files.ts"

/** Serves the built web app over HTTP; see resolveStaticFile for which file answers a path. */
export function createStaticServer(rootDir: string) {
  return (req: IncomingMessage, res: ServerResponse) => {
    const pathname = new URL(req.url ?? "/", "http://companion.invalid").pathname
    const resolution = resolveStaticFile(rootDir, req.method ?? "GET", pathname)
    res.writeHead(resolution.status, resolution.headers)
    if (resolution.kind === "error") {
      res.end(resolution.body)
      return
    }
    if (req.method === "HEAD") {
      res.end()
      return
    }
    createReadStream(resolution.file).pipe(res)
  }
}
