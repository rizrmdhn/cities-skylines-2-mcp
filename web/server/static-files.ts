/**
 * Which file of the built web app answers a pathname: shared by the HTTP companion (static.ts)
 * and the desktop app's app:// protocol, so both apply the same traversal check, SPA fallback,
 * content types and cache policy. Only stats files; reading them is up to the transport.
 */
import { statSync } from "node:fs"
import { extname, join, normalize, resolve, sep } from "node:path"

export const CONTENT_TYPES: Readonly<Record<string, string>> = {
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

export const NOT_BUILT_MESSAGE =
  "The web app is not built yet: run `npm run build` in the web folder."

export type StaticResolution =
  /** Send this file with these headers (body omitted for HEAD). */
  | { kind: "file"; status: 200; file: string; headers: Record<string, string> }
  /** Send this status with an optional plain-text body. */
  | { kind: "error"; status: number; headers: Record<string, string>; body: string }

function isFile(path: string) {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

const TEXT = { "Content-Type": "text/plain; charset=utf-8" }

/**
 * Resolves one request for the app in `rootDir`. `pathname` is the raw (still percent-encoded)
 * URL path. Unknown paths without an extension get index.html (client-side routes); unknown
 * paths with one get 404; anything escaping the folder gets 403.
 */
export function resolveStaticFile(
  rootDir: string,
  method: string,
  pathname: string
): StaticResolution {
  if (method !== "GET" && method !== "HEAD") {
    return { kind: "error", status: 405, headers: { Allow: "GET, HEAD" }, body: "" }
  }
  const root = resolve(rootDir)
  let decoded: string
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    return { kind: "error", status: 400, headers: TEXT, body: "malformed path" }
  }
  const candidate = normalize(join(root, decoded))
  if (candidate !== root && !candidate.startsWith(root + sep)) {
    return { kind: "error", status: 403, headers: {}, body: "" }
  }

  let file = candidate
  if (!isFile(file)) {
    if (extname(decoded) !== "") {
      return { kind: "error", status: 404, headers: TEXT, body: "not found" }
    }
    file = join(root, "index.html")
  }
  if (!isFile(file)) {
    return { kind: "error", status: 503, headers: TEXT, body: NOT_BUILT_MESSAGE }
  }

  const immutable = file.startsWith(join(root, "assets") + sep)
  return {
    kind: "file",
    status: 200,
    file,
    headers: {
      "Content-Type": CONTENT_TYPES[extname(file)] ?? "application/octet-stream",
      "Cache-Control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
      "X-Content-Type-Options": "nosniff",
    },
  }
}
