// Generate the app's PNG icon set from build/icons/1024x1024.svg, plus the
// badged tray variants in build/tray/.
//
// This script exists because Electron's nativeImage cannot decode SVG at all,
// so every OS-level icon (window/taskbar, tray, About) must be a PNG.
//
// Run: node scripts/build-icons.mjs

import sharp from 'sharp'
import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const iconDir = join(root, 'build/icons')
const SOURCE = join(iconDir, '1024x1024.svg')

const SIZES = [16, 20, 24, 32, 48, 64, 128, 256, 512, 1024]

// Tray variants live OUTSIDE build/icons/ on purpose: `linux.icon` in
// electron-builder.yml points at that directory and derives the launcher/desktop
// icon set from the PNGs it finds, so a badged 32x32 sitting there risks being
// shipped as the app's launcher icon.
const trayDir = join(root, 'build/tray')

// Fraction of the canvas the icon should occupy. 0.88 keeps a small breathing
// margin — icons that bleed to the edge look clipped in docks.
const GLYPH_SCALE = 0.88

// The tray sits directly among flat OS status icons (network/volume/bell), which
// carry noticeably more internal padding than a dock icon — at GLYPH_SCALE the
// tray glyph visibly out-sized its neighbors. 0.68 was picked to close that gap.
const TRAY_GLYPH_SCALE = 0.68

/** Render the icon at one size: trim the empty margin, then re-pad evenly. */
async function renderSize(svg, size, scale = GLYPH_SCALE) {
  const glyphPx = Math.round(size * scale)
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

// --- Tray icon: flat silhouette + state badge --------------------------------
//
// The launcher icon (rounded white tile, two-tone bronze gradient) is a branded
// card meant for docks. Sitting in a system tray next to flat single-color
// glyphs (network/volume/bell), that treatment reads as a heavier, brighter
// "sticker" than its neighbors — verified against real light- and dark-panel
// screenshots. The tray gets its own, plainer rendering instead: no background
// tile, no gradient, just the K+keyhole shape as one flat color — matching how
// the OS's own tray icons are single-color silhouettes that invert between
// light and dark panels.

/** Strip the source SVG to a flat single-color silhouette: drop the white
 *  background tile and the two-tone gradient fills, leaving just the K+keyhole
 *  outline filled with `ink`. */
function silhouetteSvg(svg, ink) {
  return svg
    .replace(/<defs>[\s\S]*?<\/defs>/, '')
    .replace(/<rect class="st2"[^>]*\/>/, '')
    .replace(/class="st0"/g, `fill="${ink}"`)
    .replace(/class="st1"/g, `fill="${ink}"`)
}

// Ink pair, swapped at runtime by the tray's own dark/light-panel detection
// (see trayIconName in src/main/index.ts). Sourced from tokens.css rather than
// pure black/white so the tray still reads as this app's palette:
// --color-gunmetal-950 (near-black, for light panels) and --color-gunmetal-100
// (near-white, for dark panels) — the same pair the app uses for primary text.
const INK_DARK = '#101114'
const INK_LIGHT = '#eeeff2'

// 32 is what the tray actually loads; 256 is trayImage()'s empty-file fallback.
const TRAY_SIZES = [32, 256]

// The tray icon has to say connected / connecting / disconnected at ~22px on a
// panel whose background we don't control. Colour alone cannot carry that: a red
// and a green dot at this size are the classic red-green-blindness collapse, and
// roughly 8% of men would see one icon. So the badge SHAPE is the signal —
// nothing / hollow ring / solid disc, distinguishable in pure greyscale — and
// the colour only reinforces it.
//
// Disconnected gets NO badge and no red. It is this app's normal resting state
// (you are disconnected whenever you aren't paying for a session), and an icon
// that is permanently alarmed is an icon nobody reads. Red stays available for
// states that have actually gone wrong.

// Badge geometry, as fractions of the canvas. Placement was measured against the
// glyph's own alpha map, not guessed: the mark is a SOLID mass, and what makes it
// read as a K is only the notch cut out of its top-right (the upper third). So the
// badge is safe anywhere low, and the constraint is grounding — a disc that spills
// past the ink shows a slice sitting on bare panel and reads as a stray dot beside
// the icon rather than part of it. The freedesktop bottom-right convention is
// exactly where that fails here: the mass tapers away diagonally, measuring 71%
// coverage under the dot and 51% under the wider connecting-state ring. Low-centre
// grounds both (100% / 98%) while staying clear of the identifying notch. Do not
// push this left — at 0.30 the dot ate the stem's own left edge.
const BADGE_CX = 0.5
const BADGE_CY = 0.62
const BADGE_R = 0.2 // outer radius, i.e. the ring's edge
const BADGE_INNER = 0.62 // dot radius / ring centreline, as a fraction of BADGE_R
const BADGE_STROKE = 0.4 // ring thickness, as a fraction of BADGE_R

// Colours are the app's own semantic tokens (tokens.css): --color-warning and
// --color-success. No separating ring/halo behind the badge — that existed to
// keep a colored dot legible against the white tile, and there is no tile now;
// on a transparent background the mark sits directly on the panel, like every
// other tray icon's status accent.
const TRAY_STATES = {
  disconnected: null,
  connecting: { color: '#f0b429', filled: false },
  connected: { color: '#5fd98b', filled: true },
}

/** The status badge as an SVG overlay sized to the icon canvas. */
function badgeSvg(size, { color, filled }) {
  const cx = size * BADGE_CX
  const cy = size * BADGE_CY
  const r = size * BADGE_R
  const inner = r * BADGE_INNER
  const mark = filled
    ? `<circle cx="${cx}" cy="${cy}" r="${inner}" fill="${color}"/>`
    : `<circle cx="${cx}" cy="${cy}" r="${inner}" fill="none" stroke="${color}" stroke-width="${r * BADGE_STROKE}"/>`
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">${mark}</svg>`)
}

/** One tray icon: the flat silhouette, plus a state badge if any. */
async function renderTrayIcon(base, size, state) {
  const badge = TRAY_STATES[state]
  if (!badge) return base
  return sharp(base).composite([{ input: badgeSvg(size, badge) }]).png().toBuffer()
}

const svg = readFileSync(SOURCE, 'utf-8')

for (const size of SIZES) {
  const png = await renderSize(svg, size)
  writeFileSync(join(iconDir, `${size}x${size}.png`), png)
}
console.log(`${SIZES.length} sizes -> build/icons/`)

mkdirSync(trayDir, { recursive: true })
let trayCount = 0
// Filenames are keyed by the PANEL the variant is for, not the ink used, so the
// runtime pick (nativeTheme.shouldUseDarkColors ? 'dark' : 'light') maps to a
// filename with no inversion to get backwards.
for (const [panel, ink] of [['light', INK_DARK], ['dark', INK_LIGHT]]) {
  const silhouette = silhouetteSvg(svg, ink)
  for (const size of TRAY_SIZES) {
    const base = await renderSize(silhouette, size, TRAY_GLYPH_SCALE)
    for (const state of Object.keys(TRAY_STATES)) {
      writeFileSync(join(trayDir, `${state}-${panel}-${size}x${size}.png`), await renderTrayIcon(base, size, state))
      trayCount++
    }
  }
}
console.log(`${trayCount} tray icons -> build/tray/`)
