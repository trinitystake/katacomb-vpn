// The node handshake POST, reimplemented so it can be sent through a proxy.
//
// The bundled SDK's `handshake()` is a bare axios POST with a fixed
// `https.Agent({rejectUnauthorized:false})` and no way to supply another one (checked
// against the published 2.1.0 dist, and the Go SDK's node client is the same: only
// WithInsecure/WithTimeout). A multihop chain has to reach the EXIT node through the
// entry hop, so that one call needs an agent we choose — hence this.
//
// The SDK stays in charge of every DIRECT handshake, across all six protocols, because
// that path is proven in production. This exists for the proxied one, and
// `node-handshake.test.ts` pins the two together by capturing what the real SDK puts on
// the wire and asserting this produces the identical bytes. If the SDK ever changes its
// message construction, that test fails rather than a node silently rejecting us.
//
// Electron-free, so the native test runner can load it.

import https from 'node:https'
import http from 'node:http'
import { URL } from 'node:url'
import { Secp256k1, sha256 } from '@cosmjs/crypto'

/** The exact JSON body a dvpnx node expects at `POST /`. */
export interface HandshakeBody {
  data: string
  id: number
  pub_key: string
  signature: string
}

/**
 * The bytes the node verifies the signature over: the session id as 8 big-endian bytes,
 * followed by the UTF-8 JSON of the peer request. Mirrors the SDK's `buildMsg`.
 */
export function buildHandshakeMessage(sessionId: string, data: unknown): Uint8Array {
  const id = Buffer.alloc(8)
  id.writeBigUInt64BE(BigInt(sessionId))
  return Buffer.concat([id, Buffer.from(JSON.stringify(data), 'utf8')])
}

/**
 * Build the signed request body. Async because CosmJS signs asynchronously.
 *
 * The signature is the 64-byte compact form (r || s) that libsecp256k1's `ecdsaSign`
 * returns, which is what the SDK sends and what the node's Go side verifies. CosmJS
 * produces the same canonical low-S signature; the equivalence test is what proves it
 * rather than this comment.
 */
export async function buildHandshakeBody(
  sessionId: string,
  data: unknown,
  privKey: Uint8Array,
): Promise<HandshakeBody> {
  if (!/^\d+$/.test(sessionId)) throw new Error(`Invalid session id "${sessionId}"`)
  const hash = sha256(buildHandshakeMessage(sessionId, data))
  const signature = await Secp256k1.createSignature(hash, privKey)
  const compact = Buffer.concat([signature.r(32), signature.s(32)])
  const { pubkey } = await Secp256k1.makeKeypair(privKey)
  const compressed = Secp256k1.compressPubkey(pubkey)
  return {
    data: Buffer.from(JSON.stringify(data), 'utf8').toString('base64'),
    id: Number(sessionId),
    pub_key: `secp256k1:${Buffer.from(compressed).toString('base64')}`,
    signature: compact.toString('base64'),
  }
}

/** What a node returns from a successful handshake (`types.Response.result`). */
export interface HandshakeResult {
  data?: unknown
  addrs?: unknown
}

/**
 * POST a handshake and return the node's `result`, through `agent` when one is given.
 *
 * Errors are shaped like the axios ones the rest of the connect path already handles, so
 * `describeNodeApiError` and `describeHandshakeError` keep working unchanged: a non-2xx
 * carries `.response = {status, data}`, which is where dvpnx puts `{error:{code,message}}`
 * and where the 409-conflict logic reads from.
 */
export function postHandshake(
  remoteUrl: string,
  body: HandshakeBody,
  opts: { agent?: https.Agent; timeoutMs: number },
): Promise<HandshakeResult> {
  const trimmed = remoteUrl.replace(/\/$/, '').trim()
  const target = new URL(trimmed.startsWith('http') ? trimmed : `https://${trimmed}`)
  const payload = Buffer.from(JSON.stringify(body), 'utf8')

  // Nodes serve https, but `isSafeNodeApiUrl` allows a plain-http endpoint and the SDK
  // honours one too, so follow the URL rather than assuming.
  const transport = target.protocol === 'http:' ? http : https

  return new Promise((resolve, reject) => {
    const req = transport.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        // URL.port is a STRING, and '' when the URL carries no explicit port. Passing it
        // straight through is what broke the proxied exit handshake: http.get(urlString)
        // would have coerced it via urlToHttpOptions, but building options by hand skips
        // that. undefined lets Node pick the protocol default, which '' also did.
        port: target.port === '' ? undefined : Number(target.port),
        path: target.pathname === '' ? '/' : target.pathname,
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'Content-Length': payload.length,
        },
        // Self-signed node certificates: same posture as the SDK and node-tester. The
        // caller's agent carries its own rejectUnauthorized:false.
        agent: opts.agent,
        rejectUnauthorized: false,
      },
      (res) => {
        let raw = ''
        res.on('data', (chunk: Buffer) => { raw += chunk.toString() })
        res.on('end', () => {
          let parsed: { result?: HandshakeResult; error?: unknown } | undefined
          try { parsed = JSON.parse(raw) } catch { /* reported below */ }
          const status = res.statusCode ?? 0
          if (status < 200 || status >= 300) {
            const err = new Error(`Request failed with status code ${status}`) as Error & {
              response?: { status: number; data?: unknown }
            }
            err.response = { status, data: parsed ?? raw }
            reject(err)
            return
          }
          if (!parsed || parsed.result === undefined) {
            reject(new Error('Node returned an invalid handshake response'))
            return
          }
          resolve(parsed.result)
        })
      },
    )
    req.on('error', reject)
    req.setTimeout(opts.timeoutMs, () => {
      req.destroy(new Error(`Handshake timed out after ${opts.timeoutMs}ms`))
    })
    req.end(payload)
  })
}
