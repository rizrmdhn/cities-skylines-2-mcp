/**
 * Saves a file the page generated (the map's PNG export, ...) through a native "Save as" dialog:
 *
 *   POST /api/desktop/save-file   { "name": "Riverside-land-value-2026-03-05.png", "data": "<base64>" }
 *     -> { "status": "saved", "path": "C:\Users\me\Pictures\...png" }   the user picked a place
 *     -> { "status": "cancelled" }                                          the user closed the dialog
 *
 * Why a route instead of `<a download>`: the renderer has no preload and no IPC, so it could not
 * learn whether a download happened, and Electron's default download dialog neither remembers the
 * folder nor opens in Pictures. Here the dialog is ours: file name pre-filled, starting in the
 * last folder used (setting `save-file.lastFolder`, not exposed to the settings page) or, the
 * first time, in Pictures (Downloads for non-images), and the page gets the outcome.
 *
 * The page cannot choose a path: it sends a bare file name (directories are stripped), the user
 * picks the folder, and only a short list of document/image extensions is written.
 *
 * `CS2MCP_DESKTOP_SAVE_DIR=<folder>` skips the dialog and writes into that folder (used by the
 * smoke test, which cannot click a native dialog).
 */
import { mkdir, stat, writeFile } from "node:fs/promises"
import { basename, dirname, extname, join } from "node:path"

import type { BrowserWindow } from "electron"
import { z } from "zod"

import { defineFeature, type DesktopFeature } from "../context.ts"
import { RouteError } from "../routes.ts"

/** Extensions the page may save; the dialog's file-type filter is derived from it. */
const FILE_TYPES: Record<string, string> = {
  ".png": "PNG image",
  ".jpg": "JPEG image",
  ".webp": "WebP image",
  ".svg": "SVG image",
  ".csv": "CSV table",
  ".json": "JSON file",
  ".txt": "Text file",
}
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".webp", ".svg"])
/** Upper bound for one file's bytes (a 4x export of a large view is a few tens of MB). */
export const MAX_SAVE_BYTES = 256 * 1024 * 1024
/** Characters Windows (and so every platform here) does not allow in a file name. */
const INVALID_NAME = /[<>:"/\|?*\u0000-\u001f]/g

export interface ChooseRequest {
  /** Absolute suggested path: the starting folder plus the file name. */
  suggestedPath: string
  extension: string
  parent: BrowserWindow | null
}

/** Asks where to save; resolves the chosen absolute path, or undefined when cancelled. */
export type ChoosePath = (request: ChooseRequest) => Promise<string | undefined>
/** The folder a first-time dialog starts in. */
export type DefaultFolder = (kind: "image" | "other") => Promise<string>

const showDialog: ChoosePath = async ({ suggestedPath, extension, parent }) => {
  const { dialog } = await import("electron")
  const options = {
    title: "Save as",
    defaultPath: suggestedPath,
    filters: [{ name: FILE_TYPES[extension] ?? "File", extensions: [extension.slice(1)] }],
  }
  const result = parent ? await dialog.showSaveDialog(parent, options) : await dialog.showSaveDialog(options)
  return result.canceled || !result.filePath ? undefined : result.filePath
}

const electronFolder: DefaultFolder = async (kind) => {
  const { app } = await import("electron")
  return app.getPath(kind === "image" ? "pictures" : "downloads")
}

/** A safe bare file name with a whitelisted extension; throws a 400 otherwise. */
export function cleanFileName(name: string): { name: string; extension: string } {
  const bare = basename(name.replaceAll("\\", "/")).replace(INVALID_NAME, "-").trim()
  const extension = extname(bare).toLowerCase()
  if (!FILE_TYPES[extension]) {
    throw new RouteError(400, `files of type "${extension || "(none)"}" cannot be saved here`)
  }
  const stem = bare.slice(0, bare.length - extension.length).replace(/[. ]+$/, "").slice(0, 150)
  return { name: `${stem || "file"}${extension}`, extension }
}

async function isFolder(path: string) {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

/** The feature with injectable dialog and folders (tests pass fakes; the app uses Electron). */
export function createSaveFile(
  choosePath: ChoosePath = showDialog,
  defaultFolder: DefaultFolder = electronFolder,
  env: Record<string, string | undefined> = process.env
): DesktopFeature {
  return defineFeature({
    id: "save-file",
    setup(ctx) {
      const lastFolder = ctx.settings.define("save-file.lastFolder", {
        schema: z.string().nullable(),
        default: null,
        expose: false,
      })
      let dialogOpen = false

      ctx.routes.post("/desktop/save-file", async (req) => {
        const { name: requested, data } = req.parse(z.object({ name: z.string().min(1).max(400), data: z.string() }))
        const { name, extension } = cleanFileName(requested)
        if (data.length > Math.ceil((MAX_SAVE_BYTES * 4) / 3) + 4) {
          throw new RouteError(413, "the file is too large to save")
        }
        const bytes = Buffer.from(data, "base64")

        let target: string | undefined
        const forced = env.CS2MCP_DESKTOP_SAVE_DIR?.trim()
        if (forced) {
          await mkdir(forced, { recursive: true })
          target = join(forced, name)
        } else {
          if (dialogOpen) throw new RouteError(409, "a save dialog is already open")
          dialogOpen = true
          try {
            const remembered = lastFolder.get()
            const folder =
              remembered && (await isFolder(remembered))
                ? remembered
                : await defaultFolder(IMAGE_EXTENSIONS.has(extension) ? "image" : "other")
            target = await choosePath({
              suggestedPath: join(folder, name),
              extension,
              parent: ctx.getMainWindow(),
            })
          } finally {
            dialogOpen = false
          }
        }
        if (!target) return { status: "cancelled" }

        // The user may have typed another name; it still has to be an extension we allow.
        if (!FILE_TYPES[extname(target).toLowerCase()]) {
          throw new RouteError(400, `files of type "${extname(target) || "(none)"}" cannot be saved here`)
        }
        try {
          await writeFile(target, bytes)
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          ctx.log.warn(`could not write ${basename(target)}: ${message}`)
          throw new RouteError(500, `could not write the file: ${message}`)
        }
        if (!forced) await lastFolder.set(dirname(target))
        ctx.log.info(`saved ${basename(target)} (${bytes.length} bytes)`)
        return { status: "saved", path: target }
      })
    },
  })
}

export default createSaveFile()
