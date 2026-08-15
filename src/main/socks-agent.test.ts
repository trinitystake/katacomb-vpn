import { test } from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import {
  encodeGreeting,
  encodeConnect,
  parseGreetingReply,
  parseConnectReply,
  socks5Connect,
  SocksHttpsAgent,
} from './socks-agent.ts'

// --- the wire format (RFC 1928) ------------------------------------------------

test('the greeting offers exactly one method, and it is no-auth', () => {
  assert.deepEqual([...encodeGreeting()], [0x05, 0x01, 0x00])
})

test('a no-auth greeting reply is accepted; anything else is refused by name', () => {
  assert.doesNotThrow(() => parseGreetingReply(Buffer.from([0x05, 0x00])))
  assert.throws(() => parseGreetingReply(Buffer.from([0x05, 0xff])), /requires authentication/)
  assert.throws(() => parseGreetingReply(Buffer.from([0x05, 0x02])), /auth method 2/)
  assert.throws(() => parseGreetingReply(Buffer.from([0x04, 0x00])), /version 4/)
  assert.throws(() => parseGreetingReply(Buffer.from([0x05])), /truncated/)
})

test('CONNECT encodes an IPv4 literal as ATYP 1', () => {
  // 203.0.113.9:443
  assert.deepEqual(
    [...encodeConnect('203.0.113.9', 443)],
    [0x05, 0x01, 0x00, 0x01, 203, 0, 113, 9, 0x01, 0xbb],
  )
})

test('CONNECT encodes a hostname as ATYP 3, so the PROXY resolves it', () => {
  // The point of not resolving locally: our own resolver never sees the name.
  const buf = encodeConnect('exit.example.net', 8443)
  assert.deepEqual([...buf.subarray(0, 5)], [0x05, 0x01, 0x00, 0x03, 16])
  assert.equal(buf.subarray(5, 21).toString('utf8'), 'exit.example.net')
  assert.equal(buf.readUInt16BE(21), 8443)
})

test('CONNECT refuses ports and host names it cannot encode', () => {
  assert.throws(() => encodeConnect('example.net', 0), /invalid port/)
  assert.throws(() => encodeConnect('example.net', 70000), /invalid port/)
  assert.throws(() => encodeConnect('', 443), /1-255 bytes/)
  assert.throws(() => encodeConnect('a'.repeat(256), 443), /1-255 bytes/)
})

test('an octet above 255 is a hostname, not an IPv4 literal', () => {
  // Guards the regex: 999.0.0.1 matches the shape but is not an address.
  const buf = encodeConnect('999.0.0.1', 443)
  assert.equal(buf[3], 0x03)
})

test('the CONNECT reply length is derived from its address type', () => {
  const ipv4 = Buffer.from([0x05, 0x00, 0x00, 0x01, 127, 0, 0, 1, 0x04, 0x38])
  assert.equal(parseConnectReply(ipv4), 10)

  const ipv6 = Buffer.concat([Buffer.from([0x05, 0x00, 0x00, 0x04]), Buffer.alloc(16), Buffer.alloc(2)])
  assert.equal(parseConnectReply(ipv6), 22)

  // 4 header + 1 length byte + 3 name + 2 port
  const domain = Buffer.concat([Buffer.from([0x05, 0x00, 0x00, 0x03, 3]), Buffer.from('abc'), Buffer.alloc(2)])
  assert.equal(parseConnectReply(domain), 10)
})

test('an incomplete CONNECT reply asks for more rather than throwing', () => {
  assert.equal(parseConnectReply(Buffer.from([0x05, 0x00, 0x00])), null)
  // Domain replies need the length byte before the total is even knowable.
  assert.equal(parseConnectReply(Buffer.from([0x05, 0x00, 0x00, 0x03])), null)
  assert.equal(parseConnectReply(Buffer.from([0x05, 0x00, 0x00, 0x01, 127, 0])), null)
})

test('every documented refusal is reported with its reason', () => {
  const cases: [number, RegExp][] = [
    [0x01, /general SOCKS server failure/],
    [0x02, /not allowed by ruleset/],
    [0x03, /network unreachable/],
    [0x04, /host unreachable/],
    [0x05, /connection refused/],
    [0x06, /TTL expired/],
    [0x07, /command not supported/],
    [0x08, /address type not supported/],
  ]
  for (const [code, reason] of cases) {
    assert.throws(() => parseConnectReply(Buffer.from([0x05, code, 0x00, 0x01, 0, 0, 0, 0, 0, 0])), reason, `code ${code}`)
  }
  // An undocumented code still fails, and still says what it saw.
  assert.throws(
    () => parseConnectReply(Buffer.from([0x05, 0x42, 0x00, 0x01, 0, 0, 0, 0, 0, 0])),
    /reply code 66/,
  )
})

// --- the exchange, against a stub proxy ----------------------------------------

/**
 * A minimal SOCKS5 server. `onConnect` receives the parsed target so tests can assert
 * what was actually asked for, and returns the reply code to send back.
 */
function stubProxy(
  onConnect: (target: { atyp: number; host: string; port: number }) => number,
): Promise<{ port: number; close: () => void; targets: { host: string; port: number }[] }> {
  const targets: { host: string; port: number }[] = []
  // Held so close() can tear them down. A CONNECT the agent made is followed by a TLS
  // handshake this stub cannot answer, so without this the socket lingers and the test
  // runner waits on it forever.
  const live: net.Socket[] = []
  const server = net.createServer((socket) => {
    live.push(socket)
    let stage: 'greet' | 'connect' | 'done' = 'greet'
    socket.on('data', (chunk) => {
      if (stage === 'greet') {
        socket.write(Buffer.from([0x05, 0x00]))
        stage = 'connect'
        return
      }
      // Once CONNECT is answered the stream belongs to the tunnelled protocol. The
      // agent's next write is a TLS ClientHello, and parsing that as another CONNECT
      // invents a second bogus target.
      if (stage === 'done') return
      stage = 'done'
      const atyp = chunk[3]
      let host = ''
      let offset = 4
      if (atyp === 0x01) {
        host = [...chunk.subarray(4, 8)].join('.')
        offset = 8
      } else if (atyp === 0x03) {
        const len = chunk[4]
        host = chunk.subarray(5, 5 + len).toString('utf8')
        offset = 5 + len
      }
      const port = chunk.readUInt16BE(offset)
      targets.push({ host, port })
      const code = onConnect({ atyp, host, port })
      socket.write(Buffer.from([0x05, code, 0x00, 0x01, 0, 0, 0, 0, 0, 0]))
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as net.AddressInfo).port
      resolve({
        port,
        close: () => {
          for (const s of live) s.destroy()
          server.close()
        },
        targets,
      })
    })
  })
}

test('socks5Connect completes against a proxy that accepts, and asks for the right target', async () => {
  const proxy = await stubProxy(() => 0x00)
  try {
    const socket = net.connect({ host: '127.0.0.1', port: proxy.port })
    await new Promise((r) => socket.once('connect', r))
    await socks5Connect(socket, 'exit.example.net', 8443)
    assert.deepEqual(proxy.targets, [{ host: 'exit.example.net', port: 8443 }])
    socket.destroy()
  } finally {
    proxy.close()
  }
})

test('socks5Connect rejects with the proxy reason when the target is unreachable', async () => {
  const proxy = await stubProxy(() => 0x04)
  try {
    const socket = net.connect({ host: '127.0.0.1', port: proxy.port })
    await new Promise((r) => socket.once('connect', r))
    await assert.rejects(socks5Connect(socket, '203.0.113.9', 443), /host unreachable/)
    socket.destroy()
  } finally {
    proxy.close()
  }
})

test('socks5Connect rejects rather than hanging when the proxy hangs up mid-handshake', async () => {
  // The entry process dying between spawn and use is the realistic version of this.
  const server = net.createServer((socket) => socket.destroy())
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  const port = (server.address() as net.AddressInfo).port
  try {
    const socket = net.connect({ host: '127.0.0.1', port })
    await new Promise((r) => socket.once('connect', r))
    await assert.rejects(socks5Connect(socket, 'exit.example.net', 443), /closed the connection|ECONNRESET/)
  } finally {
    server.close()
  }
})

// --- the agent's own entry point -----------------------------------------------
//
// These exist because the tests above did not. Every one of them calls the codec with a
// numeric literal, so nothing ever exercised createConnection, which is the ONLY place
// Node's untyped options reach us — and the only place a string port can arrive. A live
// chain bought two sessions and then failed the exit handshake on "invalid port 6636"
// with all 12 of the tests above passing.
//
// The TLS handshake that follows CONNECT is not the subject here (the stub speaks no
// TLS), so each test reads what the proxy was ASKED for and stops.

/** What target did the agent request for these options? Ignores the TLS attempt after. */
function targetAskedFor(
  proxyPort: number,
  options: Record<string, unknown>,
  targets: { host: string; port: number }[],
): Promise<{ host: string; port: number }> {
  const agent = new SocksHttpsAgent(proxyPort)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('proxy was never asked for a target')), 2000)
    const poll = setInterval(() => {
      if (targets.length > 0) {
        clearInterval(poll)
        clearTimeout(timer)
        resolve(targets[0])
      }
    }, 5)
    // The callback fires once the stub's socket dies under the TLS attempt; the
    // assertion is on `targets`, so this only has to avoid leaving a stream open.
    agent.createConnection(options as never, (_err, stream) => {
      ;(stream as { destroy?: () => void } | undefined)?.destroy?.()
    })
  })
}

test('the agent accepts a STRING port, which is what URL.port and http options give it', async () => {
  const proxy = await stubProxy(() => 0x00)
  try {
    const asked = await targetAskedFor(proxy.port, { host: 'exit.example.net', port: '6636' }, proxy.targets)
    assert.deepEqual(asked, { host: 'exit.example.net', port: 6636 })
  } finally {
    proxy.close()
  }
})

test('the agent accepts a numeric port too', async () => {
  const proxy = await stubProxy(() => 0x00)
  try {
    const asked = await targetAskedFor(proxy.port, { host: 'exit.example.net', port: 6636 }, proxy.targets)
    assert.deepEqual(asked, { host: 'exit.example.net', port: 6636 })
  } finally {
    proxy.close()
  }
})

test('the agent defaults to 443 when the options carry no port', async () => {
  const proxy = await stubProxy(() => 0x00)
  try {
    const asked = await targetAskedFor(proxy.port, { host: 'exit.example.net' }, proxy.targets)
    assert.deepEqual(asked, { host: 'exit.example.net', port: 443 })
  } finally {
    proxy.close()
  }
})

test('the agent prefers hostname over host, since host can carry a port', async () => {
  const proxy = await stubProxy(() => 0x00)
  try {
    const asked = await targetAskedFor(
      proxy.port,
      { host: 'exit.example.net:6636', hostname: 'exit.example.net', port: '6636' },
      proxy.targets,
    )
    assert.deepEqual(asked, { host: 'exit.example.net', port: 6636 })
  } finally {
    proxy.close()
  }
})

test('an IPv4 target still goes out as ATYP 1 through the agent', async () => {
  const seen: number[] = []
  const proxy = await stubProxy((t) => { seen.push(t.atyp); return 0x00 })
  try {
    const asked = await targetAskedFor(proxy.port, { hostname: '203.0.113.9', port: '443' }, proxy.targets)
    assert.deepEqual(asked, { host: '203.0.113.9', port: 443 })
    assert.deepEqual(seen, [0x01])
  } finally {
    proxy.close()
  }
})
