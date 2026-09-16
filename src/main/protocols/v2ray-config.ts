// Builds the v2ray-core JSON for a V2Ray session, replacing the SDK's `V2Ray`
// class (parseConfig + writeConfig).
//
// Why replace it: the class is a connection manager. Constructing one pulls
// axios, qrcode, find-free-ports and child_process into the main process, and it
// can spawn `v2ray`, mkdtemp a config and print QR codes. The connect path used
// none of that — it called parseConfig, wrote the config to a temp file under
// os.tmpdir() at default permissions, read it straight back, and unlinked it,
// all to obtain a string. That temp file held the session UUID.
//
// Output is byte-identical to the SDK's, pinned by v2ray-config.test.ts. This
// swap is meant to drop a dependency, not to change what a node sees: the dead
// weight it emits (the global `transport` block of empty defaults, the unused
// StatsService api inbound) is reproduced deliberately rather than tidied, since
// trimming it would change wire behaviour for transports we cannot test offline.
//
// Same shape as xray-config.ts / hysteria-config.ts: pure, unit-tested, no imports.

// Mirrors the SDK's TransportProtocol / TransportSecurity / ProxyProtocol enums.
// Named constants rather than a runtime import, the way config-guard.ts already
// mirrors the two it needs; v2ray-config.test.ts pins them against the SDK.
const NETWORK_BY_TRANSPORT: Record<number, string> = {
  0: 'tcp', // Unspecified
  1: 'domainsocket',
  2: 'gun',
  3: 'grpc',
  4: 'http',
  5: 'kcp', // MKCP
  6: 'quic',
  7: 'tcp',
  8: 'ws', // WebSocket
}
const SECURITY_TLS = 2
const PROXY_VMESS = 2

export interface V2RayInboundMetadata {
  port: number | string
  proxy_protocol: number
  transport_protocol: number
  transport_security: number
}

export interface V2RayHandshakeData {
  metadata: V2RayInboundMetadata[]
}

/** The local SOCKS5 listener every child-proxy protocol exposes. */
export const V2RAY_SOCKS_PORT = 1080

/**
 * Build the v2ray config object for a session.
 *
 * `apiPort` is supplied by the caller rather than looked up here, so this stays
 * pure and testable; the SDK awaited find-free-ports inside parseConfig for it.
 * `uuid` is the peer id minted for this session.
 *
 * One outbound per node inbound, balanced by least ping. Callers filter the
 * metadata for encryption policy BEFORE calling (filterV2RayMetadata), because
 * the balancer here will happily use whatever it is given.
 */
export function buildV2RayConfig(
  handshake: V2RayHandshakeData,
  nodeAddrs: string[],
  uuid: string,
  apiPort: number,
): Record<string, unknown> {
  const address = nodeAddrs?.[0]
  if (!address) throw new Error('V2Ray handshake returned no node address')
  const metadata = handshake.metadata ?? []
  if (metadata.length === 0) throw new Error('V2Ray handshake returned no inbounds')

  const outbounds: Record<string, unknown>[] = []
  const outboundTags: string[] = []
  for (const meta of metadata) {
    const port = parseInt(String(meta.port), 10)
    const network = NETWORK_BY_TRANSPORT[meta.transport_protocol] ?? 'tcp'
    const security = meta.transport_security === SECURITY_TLS ? 'tls' : 'none'
    const protocol = meta.proxy_protocol === PROXY_VMESS ? 'vmess' : 'vless'
    const tag = `${address}_${port}_${protocol}_${network}_${security}`
    outboundTags.push(tag)

    const userEntry = protocol === 'vmess'
      ? { id: uuid, alterId: 0 }
      : { id: uuid, encryption: 'none' }
    const streamSettings: Record<string, unknown> = { network, security }
    // Self-signed node certificates: the hop is only as good as the proxy
    // protocol's own cipher. See the node-trust invariant — nothing on chain
    // authenticates a node's certificate, so there is nothing to pin against.
    if (security === 'tls') streamSettings.tlsSettings = { allowInsecure: true }

    outbounds.push({
      protocol,
      settings: { vnext: [{ address, port, users: [userEntry] }] },
      streamSettings,
      tag,
    })
  }

  // Key order matches the SDK's object literal: the config is serialised to disk
  // and the app's transforms spread it, so the order survives into the file.
  return {
    api: { services: ['StatsService'], tag: 'api' },
    inbounds: [
      {
        listen: '127.0.0.1',
        port: apiPort,
        protocol: 'dokodemo-door',
        settings: { address: '127.0.0.1' },
        tag: 'api',
      },
      {
        listen: '127.0.0.1',
        port: V2RAY_SOCKS_PORT,
        protocol: 'socks',
        settings: { ip: '127.0.0.1', udp: true },
        sniffing: { destOverride: ['http', 'tls'], enabled: true },
        tag: 'proxy',
      },
    ],
    log: { access: 'none', error: 'none', loglevel: 'none' },
    outbounds,
    policy: {
      levels: { '0': { downlinkOnly: 0, uplinkOnly: 0 } },
      system: { statsOutboundDownlink: true, statsOutboundUplink: true },
    },
    routing: {
      domainStrategy: 'IPIfNonMatch',
      rules: [
        { inboundTag: ['api'], outboundTag: 'api', type: 'field' },
        { inboundTag: ['proxy'], balancerTag: 'balancer', type: 'field' },
      ],
      balancers: [{ selector: outboundTags, strategy: { type: 'leastping' }, tag: 'balancer' }],
    },
    transport: {
      dsSettings: {},
      grpcSettings: {},
      gunSettings: {},
      httpSettings: {},
      kcpSettings: {},
      quicSettings: { security: 'chacha20-poly1305' },
      tcpSettings: {},
      wsSettings: {},
    },
    stats: {},
  }
}
