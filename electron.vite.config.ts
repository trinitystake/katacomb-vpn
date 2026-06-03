import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

// Bundle everything except native modules and electron builtins.
// The CosmJS / Sentinel SDK ecosystem has ESM-only transitive deps
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
      rollupOptions: {
        // ws optional native deps — must stay as runtime require() so they
        // gracefully no-op when not installed
        external: ['bufferutil', 'utf-8-validate'],
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: { sourcemap: false },
  },
  renderer: {
    resolve: {
      alias: {
        '@': resolve('src/renderer'),
      },
    },
    plugins: [react()],
    css: {
      postcss: resolve(__dirname, 'postcss.config.js'),
    },
    build: { sourcemap: false },
  },
})
