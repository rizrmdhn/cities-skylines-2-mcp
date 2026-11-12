import { createReadStream, statSync } from "node:fs"
import type { IncomingMessage, ServerResponse } from "node:http"
import { extname, join, normalize, resolve, sep } from "node:path"

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".txt": "text/plain; charset=utf-8",
}

function isFile(path: string) {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/** Serves the built web app; unknown paths without an extension get index.html (client-side routes). */
export function createStaticServer(rootDir: string) {
  const root = resolve(rootDir)
  const indexFile = join(root, "index.html")

  return (req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { Allow: "GET, HEAD" }).end()
      return
    }
    const pathname = decodeURIComponent(
      new URL(req.url ?? "/", "http://companion.invalid").pathname
    )
    const candidate = normalize(join(root, pathname))
    if (candidate !== root && !candidate.startsWith(root + sep)) {
      res.writeHead(403).end()
      return
    }

    let file = candidate
    if (!isFile(file)) {
      if (extname(pathname) !== "") {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("not found")
        return
      }
      file = indexFile
    }
    if (!isFile(file)) {
      res
        .writeHead(503, { "Content-Type": "text/plain; charset=utf-8" })
        .end("The web app is not built yet: run `npm run build` in the web folder.")
      return
    }

    const immutable = file.startsWith(join(root, "assets") + sep)
    res.writeHead(200, {
      "Content-Type": CONTENT_TYPES[extname(file)] ?? "application/octet-stream",
      "Cache-Control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
      "X-Content-Type-Options": "nosniff",
    })
    if (req.method === "HEAD") {
      res.end()
      return
    }
    createReadStream(file).pipe(res)
  }
}
