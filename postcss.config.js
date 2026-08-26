// flag-icons ships every flag twice: `.fi-xx` points at flags/4x3/ and
// `.fi-xx.fis` at flags/1x1/. The square set is selected by the `fis` class,
// which this app never uses (all six call sites render a bare `fi fi-${code}`),
// but importing the stylesheet wholesale still made Vite emit both — 71 flags
// twice over, ~1.8 MB of SVG, plus the small ones inlined twice into the CSS.
//
// Matched on the SELECTOR, not the url(): Vite rewrites `../flags/1x1/ad.svg`
// to a hashed asset path in a postcss plugin of its own that runs before this
// one, so by the time we see the declaration there is no 1x1 left in the value.
// The bare `.fis{}` aspect-ratio rule carries no background-image and is left
// alone. If a square flag is ever wanted, delete this plugin rather than
// working around it.
const dropSquareFlags = () => ({
  postcssPlugin: 'drop-1x1-flags',
  Rule(rule) {
    if (!/(^|,)\s*\.fi-[a-z0-9-]+\.fis\s*$/i.test(rule.selector)) return
    if (rule.some((node) => node.prop === 'background-image')) rule.remove()
  },
})
dropSquareFlags.postcss = true

module.exports = {
  plugins: [
    require('tailwindcss'),
    require('autoprefixer'),
    dropSquareFlags,
  ],
}
