import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildMultihopConfig,
  buildEntryOnlyConfig,
  buildHopOutbound,
  selectHopEntry,
  isCleartextEntry,
  isUsableReality,
  normalizeTlsPin,
  transportName,
  classifyHopEligibility,
  ENTRY_TAG,
  EXIT_TAG,
  type HopSpec,
  type HopMetadataEntry,
} from './multihop-config.ts'
import { classifyV2RayInbound, assertSafeV2RayConfig } from './config-guard.ts'
import { isUsableXRayReality } from './xray-config.ts'
import { SOCKS_PORT } from '../shared/socks.ts'

// The proxy/transport/security triples below are real combinations captured from
// live v9.0.0 nodes on 2026-08-14 (probed at each node's root path). Their
// `service_metadata` reports an EMPTY port — the real port only arrives in the
// handshake response — so ports here are filled in with plausible values.
//
// Observed distribution across 40 healthy v9.0.0 v2ray nodes, for context on why
// grpc matters most: grpc 39, websocket 16, tcp 19, quic 12, gun 7, mkcp 3, http 4.

const v2rayHop = (metadata: HopMetadataEntry[], addrs = ['entry.example.net']): HopSpec => ({
  protocol: 'v2ray',
  metadata,
  addrs,
  uuid: '11111111-2222-3333-4444-555555555555',
})

const xrayHop = (metadata: HopMetadataEntry[], addrs = ['exit.example.net']): HopSpec => ({
  protocol: 'xray',
  metadata,
  addrs,
  uuid: '99999999-8888-7777-6666-555555555555',
})

// vmess/grpc/tls — the single most common buildable v2ray inbound.
const V2RAY_GRPC_TLS: HopMetadataEntry = {
  port: '20491', proxy_protocol: 2, transport_protocol: 3, transport_security: 2, tls_pin: 'c'.repeat(64),
}
// vless/websocket/tls
const V2RAY_WS_TLS: HopMetadataEntry = {
  port: '23457', proxy_protocol: 1, transport_protocol: 8, transport_security: 2, tls_pin: 'd'.repeat(64),
}
// vless/tcp/tls
const V2RAY_TCP_TLS: HopMetadataEntry = {
  port: '18407', proxy_protocol: 1, transport_protocol: 7, transport_security: 2, tls_pin: 'b'.repeat(64),
}
// A second plain-TCP inbound, for the EXIT side of a chain — the exit must be TCP
// (see EXIT_TRANSPORTS), so tests need two distinguishable TCP hops.
const V2RAY_TCP_TLS_EXIT: HopMetadataEntry = {
  port: '4876', proxy_protocol: 1, transport_protocol: 7, transport_security: 2, tls_pin: '9'.repeat(64),
}

test('chains exit through entry: exit is default egress and dials via the entry tag', () => {
  const config = buildMultihopConfig(
    v2rayHop([V2RAY_TCP_TLS]),
    v2rayHop([V2RAY_TCP_TLS_EXIT], ['exit.example.net']),
  )
  const outbounds = config.outbounds as Record<string, unknown>[]
  assert.equal(outbounds.length, 2)

  // Exit first — v2ray/xray treat outbounds[0] as the default egress.
  assert.equal(outbounds[0].tag, EXIT_TAG)
  assert.deepEqual(outbounds[0].proxySettings, { tag: ENTRY_TAG })
  assert.equal(outbounds[1].tag, ENTRY_TAG)
  assert.equal(outbounds[1].proxySettings, undefined)
})

test('exactly one outbound dials directly, and it is the entry (extractV2RayRemoteHost contract)', () => {
  const config = buildMultihopConfig(
    v2rayHop([V2RAY_TCP_TLS], ['entry.example.net']),
    v2rayHop([V2RAY_TCP_TLS_EXIT], ['exit.example.net']),
  )
  const outbounds = config.outbounds as Record<string, unknown>[]
  const direct = outbounds.filter((o) => o.proxySettings === undefined)
  assert.equal(direct.length, 1, 'exactly one outbound must be a direct dial')

  // vpn-manager pins/whitelists whatever this resolves to; it must be the entry.
  const vnext = (direct[0].settings as { vnext: { address: string }[] }).vnext
  assert.equal(vnext[0].address, 'entry.example.net')
})

test('the socks inbound is loopback-only, so assertSafeV2RayConfig accepts it', () => {
  const config = buildMultihopConfig(v2rayHop([V2RAY_TCP_TLS]), v2rayHop([V2RAY_TCP_TLS_EXIT]))
  const inbounds = config.inbounds as Record<string, unknown>[]
  assert.equal(inbounds.length, 1)
  assert.equal(inbounds[0].listen, '127.0.0.1')
  assert.equal(inbounds[0].port, SOCKS_PORT) // cross-check vs shared/socks.ts
  assert.equal(inbounds[0].protocol, 'socks')
})

// --- the enum divergence: same number, different transport, per protocol -------

test('transport_protocol is decoded with the hop protocol own table', () => {
  // 1 = domainsocket on v2ray (not remotely dialable) but TCP on xray.
  assert.equal(transportName('v2ray', 1), null)
  assert.equal(transportName('xray', 1), 'tcp')
  // 2 = gun on v2ray, websocket on xray.
  assert.equal(transportName('v2ray', 2), 'gun')
  assert.equal(transportName('xray', 2), 'websocket')
  // 7 = tcp on v2ray, undefined on xray (its table stops at 5).
  assert.equal(transportName('v2ray', 7), 'tcp')
  assert.equal(transportName('xray', 7), null)
  // 3 = grpc on both — the one value that happens to agree.
  assert.equal(transportName('v2ray', 3), 'grpc')
  assert.equal(transportName('xray', 3), 'grpc')
})

test('transport_protocol 1 builds tcp for an xray hop and is rejected for a v2ray hop', () => {
  const meta: HopMetadataEntry = {
    port: '37545', proxy_protocol: 1, transport_protocol: 1, transport_security: 3,
    flow: 2, reality_server_name: 'www.apple.com',
    reality_public_key: 'xVP4a6JqZL3tG9Cc3m6Ytn8xtdNnHyyEcCBxFpDFhzg',
    reality_short_id: '252f43c7d3719ef6', reality_fingerprint: 'chrome',
  }
  assert.notEqual(selectHopEntry(xrayHop([meta]), 'exit'), null)
  // Same number on a v2ray node means domainsocket → nothing buildable.
  assert.equal(selectHopEntry(v2rayHop([meta]), 'exit'), null)
})

// --- exit-hop transport rule --------------------------------------------------

test('only plain TCP is accepted as the exit hop; the entry may use any transport', () => {
  // Measured against xray 26.3.27 with two local vless servers chained via
  // proxySettings: entry tcp -> exit grpc FAILS, entry tcp -> exit ws FAILS,
  // entry grpc -> exit tcp WORKS. Both transports work as a DIRECT hop, so this is
  // a property of chaining. Do not widen the exit set without re-running that test.
  const grpcTls = V2RAY_GRPC_TLS      // transport_protocol 3
  const wsTls = V2RAY_WS_TLS          // transport_protocol 8
  const tcpTls = V2RAY_TCP_TLS        // transport_protocol 7

  assert.equal(selectHopEntry(v2rayHop([grpcTls]), 'exit'), null, 'grpc must be refused as exit')
  assert.equal(selectHopEntry(v2rayHop([wsTls]), 'exit'), null, 'websocket must be refused as exit')
  assert.equal(selectHopEntry(v2rayHop([tcpTls]), 'exit'), tcpTls)

  // ...but all three are fine for the entry, which is dialled directly.
  assert.equal(selectHopEntry(v2rayHop([grpcTls]), 'entry'), grpcTls)
  assert.equal(selectHopEntry(v2rayHop([wsTls]), 'entry'), wsTls)

  // A grpc entry chained to a tcp exit is the combination proven to work.
  const cfg = buildMultihopConfig(v2rayHop([grpcTls]), v2rayHop([tcpTls]))
  const obs = cfg.outbounds as Record<string, unknown>[]
  assert.equal((obs[0].streamSettings as Record<string, unknown>).network, 'tcp')   // exit
  assert.equal((obs[1].streamSettings as Record<string, unknown>).network, 'grpc')  // entry
})

test('an exit node offering only non-TCP transports is rejected with an actionable message', () => {
  assert.throws(
    () => buildMultihopConfig(v2rayHop([V2RAY_TCP_TLS]), v2rayHop([V2RAY_GRPC_TLS])),
    /exit node offers no plain-TCP inbound/,
  )
})

test('UDP transports are refused as the exit hop', () => {
  const quic: HopMetadataEntry = {
    port: '20000', proxy_protocol: 2, transport_protocol: 6, transport_security: 2, tls_pin: 'e'.repeat(64),
  }
  const mkcp: HopMetadataEntry = {
    port: '20001', proxy_protocol: 2, transport_protocol: 5, transport_security: 2, tls_pin: 'f'.repeat(64),
  }
  assert.equal(selectHopEntry(v2rayHop([quic]), 'exit'), null)
  assert.equal(selectHopEntry(v2rayHop([mkcp]), 'exit'), null)

  assert.throws(
    () => buildMultihopConfig(v2rayHop([V2RAY_TCP_TLS]), v2rayHop([quic])),
    /exit node offers no plain-TCP inbound/,
  )
})

test('a node offering several transports is usable as the exit if one of them is TCP', () => {
  const quic: HopMetadataEntry = {
    port: '20000', proxy_protocol: 2, transport_protocol: 6, transport_security: 2, tls_pin: 'e'.repeat(64),
  }
  // quic and grpc are both unusable as an exit; the TCP inbound is what makes it work.
  const picked = selectHopEntry(v2rayHop([quic, V2RAY_GRPC_TLS, V2RAY_TCP_TLS_EXIT]), 'exit')
  assert.equal(picked, V2RAY_TCP_TLS_EXIT)
})

// --- security policy ----------------------------------------------------------

test('isCleartextEntry agrees with config-guard classifyV2RayInbound', () => {
  // The rule is inlined in multihop-config to keep it import-free for the native
  // runner; this asserts it has not drifted from the single-hop source of truth.
  const cases: HopMetadataEntry[] = [
    { port: '1', proxy_protocol: 1, transport_protocol: 7, transport_security: 1 }, // vless/none
    { port: '1', proxy_protocol: 1, transport_protocol: 7, transport_security: 2 }, // vless/tls
    { port: '1', proxy_protocol: 2, transport_protocol: 7, transport_security: 1 }, // vmess/none
    { port: '1', proxy_protocol: 2, transport_protocol: 7, transport_security: 2 }, // vmess/tls
    { port: '1', proxy_protocol: 1, transport_protocol: 3, transport_security: 0 }, // vless/unspec
  ]
  for (const c of cases) {
    const expected = classifyV2RayInbound(c as never) === 'cleartext'
    assert.equal(isCleartextEntry(c), expected, JSON.stringify(c))
  }
})

test('a cleartext-only node is refused on either hop', () => {
  // vless + no transport security — the combination config-guard rejects single-hop.
  const cleartext: HopMetadataEntry = {
    port: '23457', proxy_protocol: 1, transport_protocol: 8, transport_security: 1,
  }
  assert.throws(
    () => buildMultihopConfig(v2rayHop([cleartext]), v2rayHop([V2RAY_TCP_TLS_EXIT])),
    /entry node offers only cleartext/,
  )
  assert.throws(
    () => buildMultihopConfig(v2rayHop([V2RAY_GRPC_TLS]), v2rayHop([cleartext])),
    /exit node offers only cleartext/,
  )
})

test('vmess without transport security is refused for a chain, though it is not cleartext', () => {
  // The stricter CHAIN rule: VMess carries its own AEAD cipher, so this inbound is
  // encrypted and an ordinary single-hop connect still accepts it — but over gRPC
  // with no TLS it is cleartext HTTP/2 on the wire, which is exactly what a chain
  // is paid for to avoid. It is also the most common inbound on the live network,
  // so this rule has a real cost and the message must say the node is still usable.
  const vmessNone: HopMetadataEntry = {
    port: '18407', proxy_protocol: 2, transport_protocol: 7, transport_security: 1,
  }
  assert.equal(isCleartextEntry(vmessNone), false, 'not cleartext...')
  assert.equal(selectHopEntry(v2rayHop([vmessNone]), 'exit'), null, '...but still not chain-grade')
  assert.equal(selectHopEntry(v2rayHop([vmessNone]), 'entry'), null)
  assert.throws(
    () => buildMultihopConfig(v2rayHop([vmessNone]), v2rayHop([V2RAY_TCP_TLS_EXIT])),
    /no TLS or Reality inbound[\s\S]*single-hop/,
  )
})

test('prefers reality, then tls, over an unsecured inbound', () => {
  const vmessNone: HopMetadataEntry = {
    port: '1', proxy_protocol: 2, transport_protocol: 1, transport_security: 1,
  }
  const reality: HopMetadataEntry = {
    port: '3', proxy_protocol: 1, transport_protocol: 1, transport_security: 3,
    reality_server_name: 'www.apple.com',
    reality_public_key: 'xVP4a6JqZL3tG9Cc3m6Ytn8xtdNnHyyEcCBxFpDFhzg',
  }
  const tls: HopMetadataEntry = {
    port: '2', proxy_protocol: 1, transport_protocol: 1, transport_security: 2, tls_pin: 'a'.repeat(64),
  }
  assert.equal(selectHopEntry(xrayHop([vmessNone, tls, reality]), 'exit'), reality)
  assert.equal(selectHopEntry(xrayHop([vmessNone, tls]), 'exit'), tls)
  // The unsecured inbound is not a last resort any more — it is not eligible at all.
  assert.equal(selectHopEntry(xrayHop([vmessNone]), 'exit'), null)
})

// --- outbound shape -----------------------------------------------------------

test('grpc and websocket get their stream sub-blocks', () => {
  const grpc = buildHopOutbound(v2rayHop([V2RAY_GRPC_TLS]), V2RAY_GRPC_TLS, 'node.example.net', 'x')
  const grpcStream = grpc.streamSettings as Record<string, unknown>
  assert.equal(grpcStream.network, 'grpc')
  assert.deepEqual(grpcStream.grpcSettings, {})
  assert.deepEqual(grpcStream.tlsSettings, {
    fingerprint: 'chrome',
    pinnedPeerCertSha256: 'c'.repeat(64),
  })

  const ws = buildHopOutbound(v2rayHop([V2RAY_WS_TLS]), V2RAY_WS_TLS, 'node.example.net', 'x')
  const wsStream = ws.streamSettings as Record<string, unknown>
  assert.equal(wsStream.network, 'ws')
  assert.deepEqual(wsStream.wsSettings, {})
})

test('vless and vmess get their own user settings', () => {
  const vless = buildHopOutbound(v2rayHop([V2RAY_TCP_TLS]), V2RAY_TCP_TLS, 'n', 'x')
  assert.equal(vless.protocol, 'vless')
  const vlessUser = (vless.settings as { vnext: { users: Record<string, unknown>[] }[] }).vnext[0].users[0]
  assert.equal(vlessUser.encryption, 'none')

  const vmess = buildHopOutbound(v2rayHop([V2RAY_GRPC_TLS]), V2RAY_GRPC_TLS, 'n', 'x')
  assert.equal(vmess.protocol, 'vmess')
  const vmessUser = (vmess.settings as { vnext: { users: Record<string, unknown>[] }[] }).vnext[0].users[0]
  assert.equal(vmessUser.alterId, 0)
})

test('reality carries its handshake parameters through', () => {
  const reality: HopMetadataEntry = {
    port: '37545', proxy_protocol: 1, transport_protocol: 1, transport_security: 3, flow: 2,
    reality_server_name: 'www.apple.com', reality_short_id: '252f43c7d3719ef6',
    reality_public_key: 'xVP4a6JqZL3tG9Cc3m6Ytn8xtdNnHyyEcCBxFpDFhzg', reality_fingerprint: 'chrome',
  }
  const ob = buildHopOutbound(xrayHop([reality]), reality, 'node.example.net', 'x')
  const stream = ob.streamSettings as Record<string, unknown>
  assert.equal(stream.security, 'reality')
  assert.deepEqual(stream.realitySettings, {
    serverName: 'www.apple.com',
    fingerprint: 'chrome',
    publicKey: 'xVP4a6JqZL3tG9Cc3m6Ytn8xtdNnHyyEcCBxFpDFhzg',
    shortId: '252f43c7d3719ef6',
    spiderX: '',
  })
  const user = (ob.settings as { vnext: { users: Record<string, unknown>[] }[] }).vnext[0].users[0]
  assert.equal(user.flow, 'xtls-rprx-vision')
})

// --- refusals that must reach the refund path ---------------------------------

test('missing metadata, missing address and an unusable port all throw', () => {
  assert.throws(
    () => buildMultihopConfig(v2rayHop([]), v2rayHop([V2RAY_GRPC_TLS])),
    /entry node returned no service metadata/,
  )
  assert.throws(
    () => buildMultihopConfig(v2rayHop([V2RAY_TCP_TLS], []), v2rayHop([V2RAY_TCP_TLS_EXIT])),
    /entry node returned no address/,
  )
  assert.throws(
    () => buildMultihopConfig(v2rayHop([V2RAY_TCP_TLS]), v2rayHop([V2RAY_TCP_TLS_EXIT], [])),
    /exit node returned no address/,
  )
  // A node that advertises an empty port (what /info returns) is not buildable.
  const noPort: HopMetadataEntry = {
    port: '', proxy_protocol: 2, transport_protocol: 3, transport_security: 2,
  }
  assert.equal(selectHopEntry(v2rayHop([noPort]), 'exit'), null)
})

// --- TLS pinning (xray 26.x removed `allowInsecure`; the pin is now mandatory) ---

test('normalizeTlsPin accepts hex (xray SDK) and base64 (v2ray SDK), both to hex', () => {
  const hex = 'a'.repeat(64)
  assert.equal(normalizeTlsPin(hex), hex)
  assert.equal(normalizeTlsPin(hex.toUpperCase()), hex)
  // Same 32 bytes, base64 — this is what a v2ray node sends (v2ray/server.go
  // base64-encodes the digest where xray/server.go hex-encodes it).
  const b64 = Buffer.from(hex, 'hex').toString('base64')
  assert.equal(normalizeTlsPin(b64), hex)
})

test('normalizeTlsPin rejects anything that is not a 32-byte digest', () => {
  for (const bad of [undefined, '', '   ', 'not-a-pin', 'a'.repeat(63), 'a'.repeat(65),
                     Buffer.alloc(16).toString('base64'), Buffer.alloc(33).toString('base64')]) {
    assert.equal(normalizeTlsPin(bad as string | undefined), null, JSON.stringify(bad))
  }
})

test('a TLS inbound without a usable pin is not selectable', () => {
  // Its self-signed cert could not be verified against anything, and xray no longer
  // has an "accept anything" mode, so this must never be built.
  const noPin: HopMetadataEntry = {
    port: '443', proxy_protocol: 1, transport_protocol: 7, transport_security: 2,
  }
  assert.equal(selectHopEntry(v2rayHop([noPin]), 'exit'), null)
  assert.throws(
    () => buildMultihopConfig(v2rayHop([V2RAY_TCP_TLS]), v2rayHop([noPin])),
    /no usable certificate pin/,
  )
})

test('a TLS outbound pins the node cert and never sends allowInsecure', () => {
  const ob = buildHopOutbound(v2rayHop([V2RAY_TCP_TLS]), V2RAY_TCP_TLS, 'node.example.net', 'x')
  const tls = (ob.streamSettings as Record<string, unknown>).tlsSettings as Record<string, unknown>
  assert.equal(tls.pinnedPeerCertSha256, 'b'.repeat(64))
  assert.equal(tls.fingerprint, 'chrome')
  // `allowInsecure` is a hard config error in xray 26.x, and serverName is redundant
  // once the exact certificate is pinned (upstream's own template omits it too).
  assert.ok(!('allowInsecure' in tls))
  assert.ok(!('serverName' in tls))
})

// A real Reality inbound: 43-char base64url x25519 key (32 bytes) plus the server
// name that becomes the outer ClientHello's SNI.
const XRAY_REALITY: HopMetadataEntry = {
  port: '37545', proxy_protocol: 1, transport_protocol: 1, transport_security: 3,
  reality_public_key: 'xVP4a6JqZL3tG9Cc3m6Ytn8xtdNnHyyEcCBxFpDFhzg',
  reality_server_name: 'www.apple.com', reality_short_id: '252f43c7d3719ef6',
}

test('a Reality inbound needs no tls_pin (Reality authenticates by public key)', () => {
  assert.equal(selectHopEntry(xrayHop([XRAY_REALITY]), 'exit'), XRAY_REALITY)
  const ob = buildHopOutbound(xrayHop([XRAY_REALITY]), XRAY_REALITY, 'n', 'x')
  assert.equal((ob.streamSettings as Record<string, unknown>).security, 'reality')
})

test('an empty short id is still a usable Reality inbound', () => {
  // A server configured with `shortIds: [""]` is ordinary; only the key and the
  // server name are load-bearing.
  const noShortId = { ...XRAY_REALITY, reality_short_id: '' }
  assert.equal(selectHopEntry(xrayHop([noShortId]), 'exit'), noShortId)
})

test('a Reality inbound without usable keys is not selectable', () => {
  // The failure this prevents lands AFTER the money moves: the config builds fine
  // with publicKey '', xray refuses it at spawn, and establishChainOrRefund has
  // already returned, so neither deposit is refunded.
  for (const broken of [
    { ...XRAY_REALITY, reality_public_key: '' },
    { ...XRAY_REALITY, reality_public_key: undefined },
    { ...XRAY_REALITY, reality_public_key: 'xVP4a6JqZ' },        // not 32 bytes
    { ...XRAY_REALITY, reality_server_name: '' },
    { ...XRAY_REALITY, reality_server_name: undefined },
  ] as HopMetadataEntry[]) {
    assert.equal(selectHopEntry(xrayHop([broken]), 'exit'), null)
  }
  assert.throws(
    () => buildMultihopConfig(v2rayHop([V2RAY_TCP_TLS]), xrayHop([{ ...XRAY_REALITY, reality_public_key: '' }])),
    /Reality inbound with no usable public key/,
  )
})

test('an unusable Reality inbound is skipped in favour of a pinned TLS one', () => {
  // Reality is preferred, so an unusable Reality entry used to shadow a perfectly
  // good TLS inbound on the SAME node and turn a working chain into a paid-for one
  // that cannot start. (transport_protocol 1 is TCP on an xray node, 7 on a v2ray
  // one — hence the separate constant.)
  const xrayTcpTls: HopMetadataEntry = {
    port: '18407', proxy_protocol: 1, transport_protocol: 1, transport_security: 2, tls_pin: 'a'.repeat(64),
  }
  const node = xrayHop([{ ...XRAY_REALITY, reality_public_key: '' }, xrayTcpTls])
  assert.equal(selectHopEntry(node, 'exit'), xrayTcpTls)
})

test('isUsableReality agrees with the single-hop builder xray-config uses', () => {
  // The two pure builders stay import-free of each other (see normalizeTlsPin), so
  // this is what stops the duplicated validators drifting apart.
  const cases: HopMetadataEntry[] = [
    XRAY_REALITY,
    { ...XRAY_REALITY, reality_public_key: '' },
    { ...XRAY_REALITY, reality_public_key: 'not-base64!!' },
    { ...XRAY_REALITY, reality_public_key: 'xVP4a6JqZ' },
    { ...XRAY_REALITY, reality_server_name: '' },
    { ...XRAY_REALITY, reality_short_id: '' },
  ]
  for (const c of cases) {
    assert.equal(isUsableReality(c), isUsableXRayReality(c as never), JSON.stringify(c))
  }
})

test('a Reality inbound on a transport the exit cannot use reports the transport, not the keys', () => {
  // grpc can't be chained as an exit whatever its keys look like; saying "no usable
  // public key" there would send the user off fixing the wrong thing.
  const grpcReality: HopMetadataEntry = {
    ...XRAY_REALITY, transport_protocol: 3, reality_public_key: '',
  }
  assert.throws(
    () => buildMultihopConfig(v2rayHop([V2RAY_TCP_TLS]), xrayHop([grpcReality])),
    /no plain-TCP inbound/,
  )
})

// --- the entry-only provisioning config ---------------------------------------

test('buildEntryOnlyConfig exposes only the entry, on its own loopback port', () => {
  const config = buildEntryOnlyConfig(v2rayHop([V2RAY_TCP_TLS]), 1081)
  const outbounds = config.outbounds as Record<string, unknown>[]
  assert.equal(outbounds.length, 1, 'the exit must not be reachable from this config')
  assert.equal(outbounds[0].tag, ENTRY_TAG)
  // Nothing dials through anything else: this IS the direct hop.
  assert.ok(!('proxySettings' in outbounds[0]))

  const inbounds = config.inbounds as Record<string, unknown>[]
  assert.equal(inbounds.length, 1)
  assert.equal(inbounds[0].listen, '127.0.0.1')
  assert.equal(inbounds[0].port, 1081)
  assert.equal(inbounds[0].protocol, 'socks')
  // TCP CONNECT is all the provisioning agent needs.
  assert.deepEqual(inbounds[0].settings, { udp: false })
})

test('buildEntryOnlyConfig passes the same guard the real config does', () => {
  // It goes through assertSafeV2RayConfig unchanged, so a loopback listener and a
  // file-free log are not optional.
  const config = buildEntryOnlyConfig(v2rayHop([V2RAY_TCP_TLS]), 1081)
  assert.doesNotThrow(() => assertSafeV2RayConfig(config))
})

test('buildEntryOnlyConfig grades the entry by the CHAIN rule, before any money moves', () => {
  // A node with nothing wrapped cannot be a chain entry, and failing here costs nothing.
  const cleartext: HopMetadataEntry = {
    port: '80', proxy_protocol: 1, transport_protocol: 7, transport_security: 1,
  }
  assert.throws(() => buildEntryOnlyConfig(v2rayHop([cleartext]), 1081), /cleartext/)
})

test('buildEntryOnlyConfig refuses a port it cannot listen on', () => {
  assert.throws(() => buildEntryOnlyConfig(v2rayHop([V2RAY_TCP_TLS]), 0), /invalid port/)
  assert.throws(() => buildEntryOnlyConfig(v2rayHop([V2RAY_TCP_TLS]), 70000), /invalid port/)
})

// --- classifyHopEligibility: the PRE-PURCHASE grade -------------------------
//
// The metadata below is shaped like the real thing: nodes publish this array at
// their root path with `port` and `tls_pin` blank (verified on 241/241 healthy
// v9.0.0 nodes), because both are minted per session at handshake time.

const listed = (
  proxy: number, transport: number, security: number,
): HopMetadataEntry => ({ port: '', proxy_protocol: proxy, transport_protocol: transport, transport_security: security })

test('classifyHopEligibility grades a node with no TCP inbound as entry-only', () => {
  // grpc+TLS and mkcp+TLS: dialable directly, but neither survives being chained.
  const e = classifyHopEligibility('v2ray', [listed(2, 3, 2), listed(2, 5, 2)])
  assert.deepEqual(e.transports, ['grpc', 'mkcp'])
  assert.equal(e.entry, true, 'grpc is dialable directly, so it can be an entry')
  assert.equal(e.entrySecurity, 'tls')
  assert.equal(e.exit, false, 'only plain TCP survives the detour dialer')
  assert.equal(e.exitSecurity, null)
})

test('classifyHopEligibility applies the chain TLS rule, not the single-hop one', () => {
  // The most common v9 shape is vmess/grpc with no TLS. Usable single-hop, and
  // refused at both ends of a chain.
  const e = classifyHopEligibility('v2ray', [listed(2, 3, 1), listed(2, 7, 1)])
  assert.equal(e.entry, false)
  assert.equal(e.exit, false)
  assert.equal(e.entrySecurity, null)
  assert.deepEqual(e.transports, ['grpc', 'tcp'], 'still reported, so the UI can say why')
})

test('classifyHopEligibility reports the security the exit would actually be built with', () => {
  // Prefers reality, then TLS, then whatever is left — the same order selectHopEntry
  // picks in, so the badge cannot promise more than the config delivers.
  assert.equal(classifyHopEligibility('v2ray', [listed(1, 7, 2)]).exitSecurity, 'tls')
  assert.equal(classifyHopEligibility('xray', [listed(1, 1, 3)]).exitSecurity, 'reality')
  assert.equal(classifyHopEligibility('xray', [listed(1, 1, 2), listed(1, 1, 3)]).exitSecurity, 'reality')
  // VMess with no transport security no longer qualifies at all, so there is no
  // security to report for it.
  assert.equal(classifyHopEligibility('v2ray', [listed(2, 7, 1)]).exitSecurity, null)
})

test('classifyHopEligibility grades a node with a TCP inbound as usable at both ends', () => {
  const e = classifyHopEligibility('v2ray', [listed(2, 3, 2), listed(1, 7, 2)])
  assert.equal(e.entry, true)
  assert.equal(e.exit, true)
})

test('classifyHopEligibility decodes the transport with the hop\'s OWN protocol table', () => {
  // transport_protocol 1 is domainsocket on v2ray and TCP on xray. Reading it with
  // the wrong table would advertise a UNIX socket as a usable exit.
  assert.equal(classifyHopEligibility('v2ray', [listed(1, 1, 2)]).exit, false)
  assert.equal(classifyHopEligibility('xray', [listed(1, 1, 3)]).exit, true)
})

test('classifyHopEligibility refuses a cleartext-only node at both ends', () => {
  // vless with no transport security — the one combination that is cleartext.
  const e = classifyHopEligibility('v2ray', [listed(1, 7, 1)])
  assert.equal(e.entry, false)
  assert.equal(e.exit, false)
  assert.deepEqual(e.transports, ['tcp'], 'still reported, so the UI can say why')
})

test('classifyHopEligibility ignores the blank port and pin the root path reports', () => {
  // selectHopEntry rejects both (it builds the real config); this must not, or every
  // node on the network would grade as unusable and the picker would show an empty list.
  const listing = listed(1, 7, 2)
  assert.equal(selectHopEntry(v2rayHop([listing]), 'exit'), null)
  assert.equal(classifyHopEligibility('v2ray', [listing]).exit, true)
})

test('classifyHopEligibility survives a node that sends no metadata array', () => {
  const e = classifyHopEligibility('v2ray', undefined as unknown as HopMetadataEntry[])
  assert.deepEqual(e, { transports: [], entry: false, exit: false, entrySecurity: null, exitSecurity: null })
})
