import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { buildSync } from 'esbuild'
import { createServer, type Server } from 'node:net'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'

// The crux of the stranded-kill-switch recovery: runPrivileged must fall back to
// pkexec when the daemon is UNREACHABLE (dead process / stale socket) but must NOT
// fall back when a live daemon REJECTS an op (retrying a rejected op as root would
// be a security hole). daemonRequest encodes that distinction via the error type.
//
// daemon-client uses extensionless relative imports (for tsc/bundler), which Node's
// native ESM test loader can't resolve — so bundle it (esbuild → CJS) and load it,
// the same approach as daemon-core.test.ts.
let daemonRequest: (op: string, args: unknown, socketPath?: string) => Promise<unknown>
let DaemonUnreachableError: new (m: string) => Error

before(() => {
  const out = join(mkdtempSync(join(tmpdir(), 'daemon-client-test-')), 'daemon-client.cjs')
  buildSync({
    entryPoints: ['src/main/daemon-client.ts'],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    external: ['electron'],
    outfile: out,
    logLevel: 'silent',
  })
  const mod = createRequire(import.meta.url)(out)
  daemonRequest = mod.daemonRequest
  DaemonUnreachableError = mod.DaemonUnreachableError
})

function tmpSock(): string {
  return join(mkdtempSync(join(tmpdir(), 'sntl-sock-')), 'd.sock')
}

// A daemon-shaped server that replies to each request with `response`.
function startServer(response: object): Promise<{ path: string; server: Server }> {
  const path = tmpSock()
  const server = createServer((conn) => {
    conn.setEncoding('utf-8')
    conn.on('data', (chunk: string) => {
      const req = JSON.parse(chunk.trim())
      conn.write(JSON.stringify({ id: req.id, ...response }) + '\n')
    })
  })
  return new Promise((resolve) => server.listen(path, () => resolve({ path, server })))
}

test('daemonRequest throws DaemonUnreachableError when the socket is absent (dead daemon)', async () => {
  const missing = tmpSock() // never bound → connect fails pre-connect (ENOENT)
  await assert.rejects(
    () => daemonRequest('status', undefined, missing),
    (e) => e instanceof DaemonUnreachableError,
  )
})

test('daemonRequest surfaces a daemon op-rejection as a plain Error (must NOT fall back)', async () => {
  const { path, server } = await startServer({ ok: false, error: 'dns_set: DNS resolver not allowed' })
  try {
    await assert.rejects(
      () => daemonRequest('dns_set', { dnsIp: '6.6.6.6' }, path),
      (e) => e instanceof Error && !(e instanceof DaemonUnreachableError) && /not allowed/.test((e as Error).message),
    )
  } finally {
    server.close()
  }
})

test('daemonRequest resolves with the daemon result on ok', async () => {
  const { path, server } = await startServer({ ok: true, result: { running: true } })
  try {
    const res = await daemonRequest('status', undefined, path)
    assert.deepEqual(res, { running: true })
  } finally {
    server.close()
  }
})
