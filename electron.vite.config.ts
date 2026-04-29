import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

// Bundle everything except native modules and electron builtins.
// The CosmJS / Sentinel SDK ecosystem has ESM-only transitive deps
// (@scure/base, @noble/*) that Electron's CJS require() can't load,
// so we must let Vite transpile the entire dependency tree.
const DEPS_TO_BUNDLE = [
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
      rollupOptions: {
        // ws optional native deps — must stay as runtime require() so they
        // gracefully no-op when not installed
        external: ['bufferutil', 'utf-8-validate'],
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
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
  },
})
