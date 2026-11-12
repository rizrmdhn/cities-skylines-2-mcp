#!/usr/bin/env node
/**
 * Puts a "CS2MCP Companion" shortcut on the Windows desktop (or with --remove, takes it away).
 * Double-clicking it starts the web companion in the background and opens it in the browser,
 * so playing needs no terminal or editor.
 *
 *   npm run web:shortcut          build the web companion, then create the shortcut
 *   npm run web:shortcut:remove   delete the shortcut
 */
import { spawnSync } from "node:child_process"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

if (process.platform !== "win32") {
  console.error("The desktop shortcut is Windows only. Elsewhere run: node scripts/web-launch.mjs")
  process.exit(1)
}

const NAME = "CS2MCP Companion"
const repoDir = fileURLToPath(new URL("../", import.meta.url))
const launcher = fileURLToPath(new URL("./web-launch.mjs", import.meta.url))
const runtimeDir = fileURLToPath(new URL("../web/.runtime/", import.meta.url))
const iconFile = `${runtimeDir}companion.ico`

/** Runs a PowerShell script with values passed as environment variables (no quoting issues). */
function powershell(script, env) {
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  })
  if (result.status !== 0) {
    console.error(result.stderr || result.stdout)
    process.exit(result.status ?? 1)
  }
  return result.stdout.trim()
}

// The desktop may be redirected (OneDrive), so ask Windows where it is.
const desktop = powershell("[Environment]::GetFolderPath('Desktop')")
const shortcutPath = `${desktop}\\${NAME}.lnk`

if (process.argv.includes("--remove")) {
  rmSync(shortcutPath, { force: true })
  console.log(`Removed ${shortcutPath}`)
  process.exit(0)
}

// --- icon: the favicon (dark tile, yellow towers, green ground line) drawn at several sizes ---

const TILE = [0x1f, 0x29, 0x37]
const TOWERS = [0xfd, 0xe7, 0x25]
const GROUND = [0x35, 0xb7, 0x79]
// favicon.svg paths in its 32 x 32 space, stroke width 2
const TOWER_SEGMENTS = [
  [7, 25, 7, 14], [7, 14, 12, 11], [12, 11, 12, 25],
  [14, 25, 14, 8], [14, 8, 19, 6], [19, 6, 19, 25],
  [21, 25, 21, 12], [21, 12, 25, 14], [25, 14, 25, 25],
]
const GROUND_SEGMENT = [5, 25, 27, 25]

function distanceToSegment(px, py, [x1, y1, x2, y2]) {
  const dx = x2 - x1
  const dy = y2 - y1
  const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy)))
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy))
}

function insideTile(x, y) {
  const r = 7
  const cx = Math.max(r, Math.min(32 - r, x))
  const cy = Math.max(r, Math.min(32 - r, y))
  return x >= 0 && y >= 0 && x <= 32 && y <= 32 && Math.hypot(x - cx, y - cy) <= r
}

/** Colour of one point of the 32 x 32 design, or null outside the tile. */
function sample(x, y) {
  if (!insideTile(x, y)) return null
  if (distanceToSegment(x, y, GROUND_SEGMENT) <= 1) return GROUND
  if (TOWER_SEGMENTS.some((segment) => distanceToSegment(x, y, segment) <= 1)) return TOWERS
  return TILE
}

/** 32-bit BMP icon image (BGRA rows bottom-up, then an empty AND mask), 4 x 4 supersampled. */
function iconImage(size) {
  const header = Buffer.alloc(40)
  header.writeUInt32LE(40, 0)
  header.writeInt32LE(size, 4)
  header.writeInt32LE(size * 2, 8)
  header.writeUInt16LE(1, 12)
  header.writeUInt16LE(32, 14)
  const pixels = Buffer.alloc(size * size * 4)
  const n = 4
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      let r = 0, g = 0, b = 0, a = 0
      for (let sy = 0; sy < n; sy++) {
        for (let sx = 0; sx < n; sx++) {
          const colour = sample(((col + (sx + 0.5) / n) * 32) / size, ((row + (sy + 0.5) / n) * 32) / size)
          if (!colour) continue
          r += colour[0]; g += colour[1]; b += colour[2]; a += 1
        }
      }
      const o = ((size - 1 - row) * size + col) * 4
      if (a > 0) {
        pixels[o] = Math.round(b / a)
        pixels[o + 1] = Math.round(g / a)
        pixels[o + 2] = Math.round(r / a)
      }
      pixels[o + 3] = Math.round((a / (n * n)) * 255)
    }
  }
  const mask = Buffer.alloc(Math.ceil(size / 32) * 4 * size)
  return Buffer.concat([header, pixels, mask])
}

function icoFile(sizes) {
  const images = sizes.map(iconImage)
  const dir = Buffer.alloc(6 + 16 * sizes.length)
  dir.writeUInt16LE(1, 2)
  dir.writeUInt16LE(sizes.length, 4)
  let offset = dir.length
  sizes.forEach((size, i) => {
    const e = 6 + 16 * i
    dir.writeUInt8(size >= 256 ? 0 : size, e)
    dir.writeUInt8(size >= 256 ? 0 : size, e + 1)
    dir.writeUInt16LE(1, e + 4)
    dir.writeUInt16LE(32, e + 6)
    dir.writeUInt32LE(images[i].length, e + 8)
    dir.writeUInt32LE(offset, e + 12)
    offset += images[i].length
  })
  return Buffer.concat([dir, ...images])
}

mkdirSync(runtimeDir, { recursive: true })
writeFileSync(iconFile, icoFile([16, 24, 32, 48, 64, 128, 256]))

// --- shortcut: node.exe runs the launcher in a minimised console that closes after a second ---

powershell(
  `$s = (New-Object -ComObject WScript.Shell).CreateShortcut($env:CS2_LNK)
$s.TargetPath = $env:CS2_NODE
$s.Arguments = '"' + $env:CS2_LAUNCHER + '" --gui'
$s.WorkingDirectory = $env:CS2_REPO
$s.IconLocation = $env:CS2_ICON + ',0'
$s.WindowStyle = 7
$s.Description = 'Open the CS2MCP web companion (starts it in the background if needed)'
$s.Save()`,
  {
    CS2_LNK: shortcutPath,
    CS2_NODE: process.execPath,
    CS2_LAUNCHER: launcher,
    CS2_REPO: repoDir,
    CS2_ICON: iconFile,
  }
)

console.log(`Created ${shortcutPath}
Double-click it to open the companion; the server keeps running in the background
(stop it with npm run web:stop). After changing the code, npm run build:web then npm run web:restart.`)
