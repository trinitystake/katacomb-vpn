import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { version } from './package.json'

// Bundle everything except native modules and electron builtins.
// The CosmJS / dVPN SDK ecosystem has ESM-only transitive deps
// (@scure/base, @noble/*) that Electron's CJS require() can't load,
// so we must let Vite transpile the entire dependency tree.
const DEPS_TO_BUNDLE = [
  // Bundle the one remaining externalized main-process dep so NOTHING needs
  // node_modules at runtime — lets us drop the whole tree from the package
  // (everything else main/renderer use is already inlined by the bundler).
  '@electron-toolkit/utils',
  '@sentinel-official/sentinel-js-sdk',
  '@cosmjs/encoding',
  '@cosmjs/crypto',
  '@cosmjs/amino',
  '@cosmjs/math',
  '@cosmjs/proto-signing',
  '@cosmjs/stargate',
  '@cosmjs/tendermint-rpc',
  '@cosmjs/stream',
  '@cosmjs/utils',
  '@cosmjs/json-rpc',
  '@cosmjs/socket',
  '@scure/base',
  '@scure/bip32',
  '@scure/bip39',
  '@noble/hashes',
  '@noble/curves',
  'long',
  'protobufjs',
  'axios',
  'cosmjs-types',
]

// electron-vite defaults build.minify to FALSE (unlike plain Vite, which minifies
// production builds), so every section below has to ask for it explicitly. Without
// these the packaged app ships readable source: 4.2 MB for the globe chunk alone,
// and ~4.8 MB across main + renderer.
// Vite emits an asset the moment it resolves a url() in CSS, which happens in a
// postcss plugin that runs BEFORE the one in postcss.config.js that drops the
// unused 1x1 flag rules. The rules go, the ~1.8 MB of SVG they pointed at stays.
// This sweeps anything the finished bundle no longer mentions. It is deliberately
// generic rather than flag-specific: an asset nothing references is dead weight
// whatever it is.
function dropUnreferencedAssets() {
  return {
    name: 'drop-unreferenced-assets',
    generateBundle(_options: unknown, bundle: Record<string, { type: string; code?: string; source?: string | Uint8Array }>) {
      const haystack = Object.values(bundle)
        .map((c) => (c.type === 'chunk' ? c.code : typeof c.source === 'string' ? c.source : ''))
        .join('\n')
      for (const name of Object.keys(bundle)) {
        const entry = bundle[name]
        if (entry.type !== 'asset') continue
        const base = name.split('/').pop() as string
        // Never sweep the entry CSS/JS themselves; only referenced-by-name assets.
        if (base.endsWith('.css') || base.endsWith('.js')) continue
        if (!haystack.includes(base)) delete bundle[name]
      }
    },
  }
}

export default defineConfig({
  main: {
    plugins: [
      externalizeDepsPlugin({
        exclude: DEPS_TO_BUNDLE,
      }),
    ],
    build: {
      // Never ship source maps in the packaged app (would expose full main
      // source incl. wallet flow inside the AppImage/deb).
      sourcemap: false,
      minify: 'esbuild',
      rollupOptions: {
        // ws optional native deps — must stay as runtime require() so they
        // gracefully no-op when not installed
        external: ['bufferutil', 'utf-8-validate'],
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: { sourcemap: false, minify: 'esbuild' },
  },
  renderer: {
    resolve: {
      alias: {
        '@': resolve('src/renderer'),
      },
    },
    // The renderer has no other route to the app version (no Node access), and
    // an IPC round-trip for a constant would be overkill.
    define: {
      __APP_VERSION__: JSON.stringify(version),
    },
    plugins: [react(), dropUnreferencedAssets()],
    css: {
      postcss: resolve(__dirname, 'postcss.config.js'),
    },
    build: { sourcemap: false, minify: 'esbuild' },
  },
})
