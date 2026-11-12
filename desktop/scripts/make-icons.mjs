#!/usr/bin/env node
/**
 * Draws the app icon from the web app's favicon design (web/public/favicon.svg: dark rounded
 * tile, yellow towers, green ground line) and writes:
 *   assets/icon.ico  16-256 px (window, taskbar, installer)
 *   assets/icon.png  512 px    (other platforms, packaging)
 *   assets/tray-<connected|no-city|offline>[@1.5x|@2x].png  16/24/32 px tray icons: the same
 *                    design with a status dot in the corner (green / amber / red + greyed out).
 *                    Electron loads the @ variants by itself for the display scale.
 * Pure JS (same rasteriser as scripts/web-shortcut.mjs). The output is committed; rerun with
 * `npm run icons` only when the favicon changes.
 */
import { mkdirSync, writeFileSync } from "node:fs"
import { crc32, deflateSync } from "node:zlib"

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

// Tray status variants: a dot in the bottom-right corner, ringed in the tile colour.
const STATUS_DOT = { cx: 24.5, cy: 24.5, radius: 6.2, ring: 8 }
const TRAY_VARIANTS = {
  connected: { dot: [0x22, 0xc5, 0x5e], grey: false },
  "no-city": { dot: [0xf5, 0x9e, 0x0b], grey: false },
  offline: { dot: [0xef, 0x44, 0x44], grey: true },
}
const TRAY_SIZES = [
  [16, ""],
  [24, "@1.5x"],
  [32, "@2x"],
]

function grey([r, g, b]) {
  const y = Math.round(0.3 * r + 0.59 * g + 0.11 * b)
  return [y, y, y]
}

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
function sample(x, y, variant) {
  if (!insideTile(x, y)) return null
  if (variant) {
    const d = Math.hypot(x - STATUS_DOT.cx, y - STATUS_DOT.cy)
    if (d <= STATUS_DOT.radius) return variant.dot
    if (d <= STATUS_DOT.ring) return TILE
  }
  const colour =
    distanceToSegment(x, y, GROUND_SEGMENT) <= 1
      ? GROUND
      : TOWER_SEGMENTS.some((segment) => distanceToSegment(x, y, segment) <= 1)
        ? TOWERS
        : TILE
  return variant?.grey ? grey(colour) : colour
}

/** RGBA pixels, rows top-down, 4 x 4 supersampled. */
function rasterise(size, variant) {
  const pixels = Buffer.alloc(size * size * 4)
  const n = 4
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      let r = 0, g = 0, b = 0, a = 0
      for (let sy = 0; sy < n; sy++) {
        for (let sx = 0; sx < n; sx++) {
          const colour = sample(((col + (sx + 0.5) / n) * 32) / size, ((row + (sy + 0.5) / n) * 32) / size, variant)
          if (!colour) continue
          r += colour[0]; g += colour[1]; b += colour[2]; a += 1
        }
      }
      const o = (row * size + col) * 4
      if (a > 0) {
        pixels[o] = Math.round(r / a)
        pixels[o + 1] = Math.round(g / a)
        pixels[o + 2] = Math.round(b / a)
      }
      pixels[o + 3] = Math.round((a / (n * n)) * 255)
    }
  }
  return pixels
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, "ascii"), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, crc])
}

function png(size, variant) {
  const rgba = rasterise(size, variant)
  const header = Buffer.alloc(13)
  header.writeUInt32BE(size, 0)
  header.writeUInt32BE(size, 4)
  header[8] = 8 // bit depth
  header[9] = 6 // RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1))
  for (let row = 0; row < size; row++) {
    raw[row * (size * 4 + 1)] = 0 // no filter
    rgba.copy(raw, row * (size * 4 + 1) + 1, row * size * 4, (row + 1) * size * 4)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(raw, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ])
}

/** 32-bit BMP icon image (BGRA rows bottom-up, then an empty AND mask). */
function bmpImage(size) {
  const rgba = rasterise(size)
  const header = Buffer.alloc(40)
  header.writeUInt32LE(40, 0)
  header.writeInt32LE(size, 4)
  header.writeInt32LE(size * 2, 8)
  header.writeUInt16LE(1, 12)
  header.writeUInt16LE(32, 14)
  const pixels = Buffer.alloc(size * size * 4)
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      const from = (row * size + col) * 4
      const to = ((size - 1 - row) * size + col) * 4
      pixels[to] = rgba[from + 2]
      pixels[to + 1] = rgba[from + 1]
      pixels[to + 2] = rgba[from]
      pixels[to + 3] = rgba[from + 3]
    }
  }
  const mask = Buffer.alloc(Math.ceil(size / 32) * 4 * size)
  return Buffer.concat([header, pixels, mask])
}

/** ICO with BMP entries, and a PNG entry for 256 px (as Windows' own icons do). */
function ico(sizes) {
  const images = sizes.map((size) => (size >= 256 ? png(size) : bmpImage(size)))
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

const assets = new URL("../assets/", import.meta.url)
mkdirSync(assets, { recursive: true })
writeFileSync(new URL("icon.ico", assets), ico([16, 20, 24, 32, 40, 48, 64, 128, 256]))
writeFileSync(new URL("icon.png", assets), png(512))
for (const [name, variant] of Object.entries(TRAY_VARIANTS)) {
  for (const [size, suffix] of TRAY_SIZES) {
    writeFileSync(new URL(`tray-${name}${suffix}.png`, assets), png(size, variant))
  }
}
console.log("wrote assets/icon.ico, assets/icon.png and assets/tray-*.png")
