// Bundle the root daemon into a single self-contained CJS file (no shared
// chunks), separate from the electron-vite main build. It runs via
// ELECTRON_RUN_AS_NODE on the bundled Electron's Node, so target node20 (Electron 33).
import { build } from 'esbuild'

await build({
  entryPoints: ['src/main/daemon.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  // The daemon must not pull in Electron; it's plain Node. (None of its imports
  // reference electron, but mark it external as a guard.)
  external: ['electron'],
  outfile: 'out/daemon/index.js',
  legalComments: 'none',
  logLevel: 'info',
})

console.log('built out/daemon/index.js')
