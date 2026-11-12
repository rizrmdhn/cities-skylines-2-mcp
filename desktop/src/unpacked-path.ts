/**
 * Files the OS (not Node) has to open by path, like the window icon, cannot be read from inside
 * app.asar: electron-builder unpacks them (electron-builder.yml asarUnpack) to the sibling folder
 * app.asar.unpacked. Electron-free, so tests can load it.
 */

/**
 * `<resources>/app.asar/dist/assets/icon.ico` -> `<resources>/app.asar.unpacked/dist/assets/icon.ico`.
 * Paths outside an asar archive (development, unpacked builds) come back unchanged.
 */
export function unpackedPath(path: string): string {
  return path.replace(/([\/])app\.asar(?=[\/])/i, "$1app.asar.unpacked")
}
