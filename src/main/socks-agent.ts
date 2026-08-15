// SOCKS5 client, just enough of RFC 1928 to make ONE HTTPS request through a local
// proxy we started ourselves.
//
// Why this exists: a multihop chain must not let the EXIT node see the user's real
// address. The exit is provisioned (graded, preflighted, handshaked) BEFORE any tunnel
// exists, so those calls have to go through the entry hop instead — and the entry hop,
// at that point, is an xray process with nothing but a loopback SOCKS5 listener. Neither
// the bundled JS SDK's `handshake()` nor `node:https` can dial through one: the SDK's is
// a bare axios POST with a fixed agent, and the Go SDK's node client offers only
// `WithInsecure`/`WithTimeout` (both checked against upstream). So we own it.
//
// Deliberately hand-rolled rather than pulling in socks-proxy-agent: the exchange below
// is ~40 bytes of well-specified protocol on the path that authenticates us to a node,
// and this app already treats new runtime dependencies on that path as a cost.
//
// Only what we need: version 5, no authentication, CONNECT. No BIND, no UDP ASSOCIATE,
// no GSSAPI, no username/password. The proxy is our own child process on loopback, so
// there is nothing to authenticate to and nothing else to negotiate.

import net from 'node:net'
import tls from 'node:tls'
import https from 'node:https'

const VERSION = 0x05
const AUTH_NONE = 0x00
const CMD_CONNECT = 0x01
const RSV = 0x00
const ATYP_IPV4 = 0x01
const ATYP_DOMAIN = 0x03
const ATYP_IPV6 = 0x04

/** RFC 1928 §6 reply codes, in the words we want the user to see. */
const REPLY_REASON: Record<number, string> = {
  0x01: 'general SOCKS server failure',
  0x02: 'connection not allowed by ruleset',
  0x03: 'network unreachable',
  0x04: 'host unreachable',
  0x05: 'connection refused',
  0x06: 'TTL expired',
  0x07: 'command not supported',
  0x08: 'address type not supported',
}

/** The greeting: version, one method offered, and that method is "no auth". */
export function encodeGreeting(): Buffer {
  return Buffer.from([VERSION, 0x01, AUTH_NONE])
}

/**
 * Check the method-selection reply. Throws unless the proxy agreed to no-auth: 0xFF
 * means it wants an authentication method we do not offer, and anything else is not a
 * SOCKS5 proxy at all.
 */
export function parseGreetingReply(reply: Buffer): void {
  if (reply.length < 2) throw new Error('SOCKS5 proxy sent a truncated greeting reply')
  if (reply[0] !== VERSION) throw new Error(`SOCKS5 proxy replied with version ${reply[0]}, expected 5`)
  if (reply[1] === 0xff) throw new Error('SOCKS5 proxy requires authentication, which this client does not offer')
  if (reply[1] !== AUTH_NONE) throw new Error(`SOCKS5 proxy selected auth method ${reply[1]}, expected none`)
}

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/

/**
 * A CONNECT request for `host:port`. An IPv4 literal goes as ATYP 1 and anything else as
 * a domain name (ATYP 3), which lets the PROXY resolve it — useful in its own right,
 * since a name we resolve ourselves is a name our own resolver has seen.
 */
export function encodeConnect(host: string, port: number): Buffer {
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`SOCKS5 CONNECT: invalid port ${port}`)
  }
  const head = Buffer.from([VERSION, CMD_CONNECT, RSV])
  const tail = Buffer.alloc(2)
  tail.writeUInt16BE(port, 0)

  const v4 = host.match(IPV4)
  if (v4 && v4.slice(1).every((o) => Number(o) <= 255)) {
    return Buffer.concat([head, Buffer.from([ATYP_IPV4]), Buffer.from(v4.slice(1).map(Number)), tail])
  }
  const name = Buffer.from(host, 'utf8')
  if (name.length === 0 || name.length > 255) {
    throw new Error(`SOCKS5 CONNECT: host name must be 1-255 bytes, got ${name.length}`)
  }
  return Buffer.concat([head, Buffer.from([ATYP_DOMAIN, name.length]), name, tail])
}

/**
 * Read the CONNECT reply. Returns how many bytes it occupied, or null when `reply` does
 * not hold all of it yet (the bound-address field is variable length, so this cannot be
 * a fixed read). Throws on a refusal, carrying the proxy's own reason.
 */
export function parseConnectReply(reply: Buffer): number | null {
  if (reply.length < 4) return null
  if (reply[0] !== VERSION) throw new Error(`SOCKS5 proxy replied with version ${reply[0]}, expected 5`)
  if (reply[1] !== 0x00) {
    throw new Error(`SOCKS5 proxy refused the connection: ${REPLY_REASON[reply[1]] ?? `reply code ${reply[1]}`}`)
  }
  // VER REP RSV ATYP | BND.ADDR | BND.PORT
  const atyp = reply[3]
  let addrLen: number
  if (atyp === ATYP_IPV4) addrLen = 4
  else if (atyp === ATYP_IPV6) addrLen = 16
  else if (atyp === ATYP_DOMAIN) {
    if (reply.length < 5) return null
    addrLen = 1 + reply[4]
  } else throw new Error(`SOCKS5 proxy replied with unknown address type ${atyp}`)

  const total = 4 + addrLen + 2
  return reply.length < total ? null : total
}

/**
 * Drive the handshake on an already-connected socket, resolving once the proxy has
 * opened the tunnel to `host:port`. Split out from the agent so the byte exchange can be
 * tested against a stub server without TLS in the way.
 */
export function socks5Connect(socket: net.Socket, host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let stage: 'greeting' | 'connect' = 'greeting'
    let buffered = Buffer.alloc(0)

    const done = (err?: Error): void => {
      socket.removeListener('data', onData)
      socket.removeListener('error', onError)
      socket.removeListener('close', onClose)
      if (err) reject(err)
      else resolve()
    }
    const onError = (err: Error): void => done(err)
    const onClose = (): void => done(new Error('SOCKS5 proxy closed the connection during the handshake'))

    const onData = (chunk: Buffer): void => {
      buffered = Buffer.concat([buffered, chunk])
      try {
        if (stage === 'greeting') {
          if (buffered.length < 2) return
          parseGreetingReply(buffered)
          buffered = buffered.subarray(2)
          stage = 'connect'
          socket.write(encodeConnect(host, port))
        }
        if (stage === 'connect') {
          const consumed = parseConnectReply(buffered)
          if (consumed === null) return
          // Anything after the reply belongs to the tunnelled stream. The proxy cannot
          // have sent any yet (we have not spoken TLS), but push it back rather than
          // dropping it, so this stays correct if that ever changes.
          const rest = buffered.subarray(consumed)
          if (rest.length > 0) socket.unshift(rest)
          done()
        }
      } catch (err) {
        done(err instanceof Error ? err : new Error(String(err)))
      }
    }

    socket.on('data', onData)
    socket.on('error', onError)
    socket.on('close', onClose)
    socket.write(encodeGreeting())
  })
}

/**
 * An https.Agent that reaches every host through a loopback SOCKS5 proxy, accepting
 * self-signed certificates.
 *
 * `rejectUnauthorized: false` matches what the SDK and `node-tester` already do for node
 * API calls: dVPN nodes serve self-signed certificates and there is nothing on chain to
 * check them against (`sentinel/node/v3/node.proto` carries no key or fingerprint), so
 * this adds no weakness that the direct path does not already have. See the audit's S3.
 */
export class SocksHttpsAgent extends https.Agent {
  private readonly proxyPort: number
  private readonly connectTimeoutMs: number

  constructor(proxyPort: number, connectTimeoutMs = 15_000) {
    // keepAlive off: these agents are built per provisioning attempt and thrown away,
    // and a pooled socket would outlive the proxy child it was dialled through.
    super({ keepAlive: false, rejectUnauthorized: false })
    this.proxyPort = proxyPort
    this.connectTimeoutMs = connectTimeoutMs
  }

  // Signature mirrors the base Agent's exactly (options are loosely typed there, and
  // the callback is optional) so this stays a real override rather than a shadow.
  createConnection(
    options: Parameters<https.Agent['createConnection']>[0],
    callback?: Parameters<https.Agent['createConnection']>[1],
  ): ReturnType<https.Agent['createConnection']> {
    // Node hands these over untyped, and `port` really can be either: http.get(urlString)
    // runs the URL through urlToHttpOptions, which coerces to a Number, but a caller that
    // builds options itself from `new URL(...)` passes URL.port, which is a STRING. Both
    // reach here, so narrow to what Node actually promises rather than what is convenient.
    // Asserting `port?: number` here is what shipped a chain that bought two sessions and
    // then failed the exit handshake on "invalid port 6636".
    const target = options as {
      host?: string
      hostname?: string
      port?: number | string
      servername?: string
    }
    if (!callback) {
      // Every https.Agent path that reaches here passes one; without it there is no way
      // to hand back a socket that only exists after two round trips.
      throw new Error('SOCKS5 agent requires the async createConnection callback')
    }
    // `hostname` is always the bare name; `host` can carry host:port depending on the
    // caller, so prefer the unambiguous one.
    const host = target.hostname ?? target.host ?? ''
    const port = target.port === undefined || target.port === ''
      ? 443
      : Number(target.port)
    const socket = net.connect({ host: '127.0.0.1', port: this.proxyPort })

    const fail = (err: Error): void => {
      socket.destroy()
      // The typed callback wants a stream even on failure; the caller only reads it
      // when err is null, and the socket is already destroyed by then.
      callback(err, socket)
    }
    socket.setTimeout(this.connectTimeoutMs, () => {
      fail(new Error(`SOCKS5 proxy on 127.0.0.1:${this.proxyPort} did not respond within ${this.connectTimeoutMs}ms`))
    })
    socket.once('error', fail)

    socket.once('connect', () => {
      socks5Connect(socket, host, port).then(
        () => {
          socket.setTimeout(0)
          socket.removeListener('error', fail)
          const secured = tls.connect({
            socket,
            servername: target.servername,
            rejectUnauthorized: false,
          })
          secured.once('error', (err) => callback(err, secured))
          secured.once('secureConnect', () => callback(null, secured))
        },
        (err: Error) => fail(err),
      )
    })
    return undefined
  }
}
