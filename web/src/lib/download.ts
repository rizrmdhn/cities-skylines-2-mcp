import { ApiError, apiPost } from "@/lib/api"
import { fetchDesktopInfo } from "@/lib/desktop"

/**
 * Saving a generated file (a PNG export, a CSV, ...). One helper for the browser companion and
 * the desktop app:
 *
 *  - browser: a Blob URL on a hidden `<a download>`, which saves to the browser's downloads folder
 *    (or asks, depending on the user's browser settings);
 *  - desktop app: the bytes go to the main process (`POST /api/desktop/save-file`, feature
 *    `save-file`), which shows a native "Save as" dialog with the file name filled in, starting in
 *    the last folder used (else Pictures) and writes the file. Only the desktop app can say what
 *    happened, so only there is `path` set.
 */
export type DownloadResult =
  | { status: "saved"; /** Where the desktop app wrote it; unknown in a browser. */ path?: string }
  | { status: "cancelled" }

/** The desktop feature that saves files; its presence in /api/desktop/info decides which path is taken. */
export const SAVE_FILE_FEATURE = "save-file"

/** `data:` URL payload of a blob without the prefix. */
export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error ?? new Error("could not read the file"))
    reader.onload = () => {
      const url = String(reader.result)
      resolve(url.slice(url.indexOf(",") + 1))
    }
    reader.readAsDataURL(blob)
  })
}

/** Starts a browser download. Resolves once the click was made; the browser reports nothing more. */
export function downloadWithAnchor(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement("a")
  anchor.href = url
  anchor.download = filename
  anchor.rel = "noopener"
  anchor.style.display = "none"
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
  // Revoking at once can cancel the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

export async function downloadBlob(blob: Blob, filename: string): Promise<DownloadResult> {
  const desktop = await fetchDesktopInfo().catch(() => null)
  if (desktop?.features.includes(SAVE_FILE_FEATURE)) {
    try {
      return await apiPost<DownloadResult>("/desktop/save-file", {
        name: filename,
        data: await blobToBase64(blob),
      })
    } catch (err) {
      // A real failure (disk full, folder not writable) must reach the caller; only "no such route" falls back.
      if (!(err instanceof ApiError) || err.status !== 404) throw err
    }
  }
  downloadWithAnchor(blob, filename)
  return { status: "saved" }
}
