// Generate the app's PNG icon set from build/icons/1024x1024.svg.
//
// Two reasons this script exists rather than committing hand-made PNGs:
//   1. Electron's nativeImage cannot decode SVG at all, so every OS-level icon
//      (window/taskbar, tray, About) must be a PNG.
//   2. The source artwork only fills ~41% of its canvas. Rendered 1:1 that
//      leaves the glyph tiny in the taskbar and tray, so we trim to the glyph
//      bounds and re-pad to a consistent margin.
//
// Colors come from src/renderer/styles/tokens.css so the icon matches the app:
//   light surfaces -> text-primary slate-900 + accent blue-500
//   dark surfaces  -> text-primary slate-100 + accent blue-400
//
// Run: node scripts/build-icons.mjs

import sharp from 'sharp'
import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const iconDir = join(root, 'build/icons')
const SOURCE = join(iconDir, '1024x1024.svg')

// Fills used by the source artwork, replaced per variant.
const SRC_MARK = '#1E1E1E'
const SRC_ACCENT = '#00C8FF'

const VARIANTS = {
  // For LIGHT backgrounds (light OS panel, light app theme).
  light: { mark: '#0f172a', accent: '#3b82f6' },
  // For DARK backgrounds (dark OS panel, dark app theme).
  dark: { mark: '#f1f5f9', accent: '#60a5fa' },
}

const SIZES = [16, 20, 24, 32, 48, 64, 128, 256, 512, 1024]

// Fraction of the canvas the glyph should occupy. 0.88 keeps a small breathing
// margin (icons that bleed to the edge look clipped in docks) while still being
// more than twice the source artwork's 0.41.
const GLYPH_SCALE = 0.88

function recolor(svg, { mark, accent }) {
  return svg
    .replaceAll(SRC_MARK, mark)
    .replaceAll(SRC_MARK.toLowerCase(), mark)
    .replaceAll(SRC_ACCENT, accent)
    .replaceAll(SRC_ACCENT.toLowerCase(), accent)
}

/** Render one variant at one size: trim the empty margin, then re-pad evenly. */
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

const source = readFileSync(SOURCE, 'utf-8')

for (const [name, colors] of Object.entries(VARIANTS)) {
  const svg = recolor(source, colors)
  const outDir = join(iconDir, name)
  mkdirSync(outDir, { recursive: true })
  // Keep the recolored vector next to its PNGs as the variant's source.
  writeFileSync(join(outDir, 'mark.svg'), svg)

  for (const size of SIZES) {
    const png = await renderSize(svg, size)
    writeFileSync(join(outDir, `${size}x${size}.png`), png)
    // electron-builder's `linux.icon: build/icons` reads NxN.png from the top
    // level for the packaged launcher icon. That one is baked into the .desktop
    // entry and can't follow a theme, so it gets the dark-surface variant —
    // Linux docks/panels are dark far more often than not.
    if (name === 'dark') writeFileSync(join(iconDir, `${size}x${size}.png`), png)
  }
  console.log(`${name}: ${SIZES.length} sizes -> build/icons/${name}/`)
}
console.log(`packaging set (dark variant) -> build/icons/NxN.png`)
