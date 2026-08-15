import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import Long from 'long'
import { handshake as sdkHandshake } from '@sentinel-official/sentinel-js-sdk'
import { buildHandshakeBody, buildHandshakeMessage, postHandshake } from './node-handshake.ts'

// A fixed key and session, so every assertion below is deterministic.
const PRIV_KEY = Uint8Array.from(Buffer.from('7b'.repeat(32), 'hex'))
const SESSION_ID = '55112370'
const PEER_DATA = { uuid: '11111111-2222-3333-4444-555555555555' }

/** Capture one POST body and answer like a node. */
function captureServer(
  reply: { status: number; body: unknown } = { status: 200, body: { result: { data: 'ok', addrs: [] } } },
): Promise<{ url: string; bodies: string[]; close: () => void }> {
  const bodies: string[] = []
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', () => {
      bodies.push(raw)
      res.writeHead(reply.status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(reply.body))
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number }
      resolve({ url: `http://127.0.0.1:${port}`, bodies, close: () => server.close() })
    })
  })
}

test('the signed message is the session id big-endian, then the peer JSON', () => {
  const msg = buildHandshakeMessage('1', { a: 1 })
  assert.deepEqual([...msg.subarray(0, 8)], [0, 0, 0, 0, 0, 0, 0, 1])
  assert.equal(Buffer.from(msg.subarray(8)).toString('utf8'), '{"a":1}')
})

test('a session id too large for a double still encodes exactly', () => {
  // uint64 goes past Number.MAX_SAFE_INTEGER; the id must survive as bytes.
  const msg = buildHandshakeMessage('18446744073709551615', {})
  assert.deepEqual([...msg.subarray(0, 8)], [255, 255, 255, 255, 255, 255, 255, 255])
})

test('a non-numeric session id is refused rather than signed', async () => {
  await assert.rejects(buildHandshakeBody('12x', PEER_DATA, PRIV_KEY), /Invalid session id/)
})

// --- the one that matters ------------------------------------------------------

test('our body is byte-for-byte what the SDK puts on the wire', async () => {
  // The whole justification for reimplementing this: the SDK cannot take a proxy
  // agent, so the multihop path builds the request itself. If the two ever diverge —
  // signature encoding, low-S normalisation, key compression, field names — a node
  // rejects us with a signature error and this test is the only thing that would have
  // said why. Capturing the REAL SDK call is the point; a hand-written fixture would
  // only prove we agree with ourselves.
  const server = await captureServer()
  try {
    await sdkHandshake(Long.fromString(SESSION_ID, true), PEER_DATA, PRIV_KEY, server.url)
    const fromSdk = JSON.parse(server.bodies[0])
    const ours = await buildHandshakeBody(SESSION_ID, PEER_DATA, PRIV_KEY)
    assert.deepEqual(ours, fromSdk)
  } finally {
    server.close()
  }
})

test('the signature is deterministic, so the comparison above is meaningful', async () => {
  // RFC 6979 nonces: sign the same thing twice, get the same bytes. Without this the
  // equivalence test could pass by luck on a run where both happened to agree.
  const a = await buildHandshakeBody(SESSION_ID, PEER_DATA, PRIV_KEY)
  const b = await buildHandshakeBody(SESSION_ID, PEER_DATA, PRIV_KEY)
  assert.equal(a.signature, b.signature)
  assert.equal(a.signature.length, 88, '64 raw bytes, base64 encoded')
  assert.ok(a.pub_key.startsWith('secp256k1:'))
  assert.equal(Buffer.from(a.pub_key.slice('secp256k1:'.length), 'base64').length, 33, 'compressed pubkey')
})

// --- transport ------------------------------------------------------------------

test('postHandshake returns the node result', async () => {
  const server = await captureServer({ status: 200, body: { result: { data: 'payload', addrs: ['1.2.3.4'] } } })
  try {
    const body = await buildHandshakeBody(SESSION_ID, PEER_DATA, PRIV_KEY)
    const result = await postHandshake(server.url, body, { timeoutMs: 5000 })
    assert.deepEqual(result, { data: 'payload', addrs: ['1.2.3.4'] })
    assert.deepEqual(JSON.parse(server.bodies[0]), body)
  } finally {
    server.close()
  }
})

test('a node error is shaped like the axios one the connect path already reads', async () => {
  // describeNodeApiError and the 409 branch both read err.response.status and
  // err.response.data.error.message, so this shape is load-bearing.
  const server = await captureServer({
    status: 409,
    body: { success: false, error: { code: 3, message: 'session already exists in database' } },
  })
  try {
    const body = await buildHandshakeBody(SESSION_ID, PEER_DATA, PRIV_KEY)
    await assert.rejects(
      postHandshake(server.url, body, { timeoutMs: 5000 }),
      (err: Error & { response?: { status: number; data?: { error?: { message?: string } } } }) => {
        assert.equal(err.response?.status, 409)
        assert.equal(err.response?.data?.error?.message, 'session already exists in database')
        return true
      },
    )
  } finally {
    server.close()
  }
})

test('a 200 with no result is refused rather than passed on as undefined', async () => {
  const server = await captureServer({ status: 200, body: { success: true } })
  try {
    const body = await buildHandshakeBody(SESSION_ID, PEER_DATA, PRIV_KEY)
    await assert.rejects(postHandshake(server.url, body, { timeoutMs: 5000 }), /invalid handshake response/)
  } finally {
    server.close()
  }
})
