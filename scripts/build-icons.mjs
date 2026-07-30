// Generate the app's PNG icon set from build/icons/1024x1024.svg.
//
// This script exists because Electron's nativeImage cannot decode SVG at all,
// so every OS-level icon (window/taskbar, tray, About) must be a PNG.
//
// Run: node scripts/build-icons.mjs

import sharp from 'sharp'
import { readFileSync, writeFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const iconDir = join(root, 'build/icons')
const SOURCE = join(iconDir, '1024x1024.svg')

const SIZES = [16, 20, 24, 32, 48, 64, 128, 256, 512, 1024]

// Fraction of the canvas the icon should occupy. 0.88 keeps a small breathing
// margin — icons that bleed to the edge look clipped in docks.
const GLYPH_SCALE = 0.88

/** Render the icon at one size: trim the empty margin, then re-pad evenly. */
async function renderSize(svg, size) {
  const glyphPx = Math.round(size * GLYPH_SCALE)
  // Rasterize large, trim to the ink, then downscale — trimming a small render
  // would quantize the bounds and wobble between sizes.
  const trimmed = await sharp(Buffer.from(svg), { density: 384 })
    .resize(1024, 1024)
    .png()
    .trim({ threshold: 1 })
    .resize(glyphPx, glyphPx, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .toBuffer()

  const pad = size - glyphPx
  const left = Math.floor(pad / 2)
  const top = Math.floor(pad / 2)
  return sharp({
    create: { width: size, height: size, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite([{ input: trimmed, left, top }])
    .png()
    .toBuffer()
}

const svg = readFileSync(SOURCE, 'utf-8')

for (const size of SIZES) {
  const png = await renderSize(svg, size)
  writeFileSync(join(iconDir, `${size}x${size}.png`), png)
}
console.log(`${SIZES.length} sizes -> build/icons/`)
