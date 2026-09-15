import { test } from 'node:test'
import assert from 'node:assert/strict'
import { V2Ray } from '@sentinel-official/sentinel-js-sdk'
import { buildV2RayConfig } from './v2ray-config.ts'
import { assertSafeV2RayConfig } from './config-guard.ts'

// The SDK stays a devDependency so this oracle keeps working. Every combination
// the SDK can emit is compared key for key and byte for byte: this config is what
// a paid session's tunnel runs on, and the swap must not change it.

const TRANSPORTS = [0, 1, 2, 3, 4, 5, 6, 7, 8]
const PROXIES = [0, 1, 2]
const SECURITIES = [0, 1, 2]

/** The SDK picks its api port with find-free-ports; read it back so we match. */
async function sdkConfig(metadata: unknown[], addrs: string[]): Promise<{ cfg: Record<string, unknown>; uuid: string; apiPort: number }> {
  const sdk = new V2Ray()
  await sdk.parseConfig({ metadata } as never, addrs)
  const cfg = sdk.config as Record<string, unknown>
  const inbounds = cfg.inbounds as { tag: string; port: number }[]
  const apiPort = inbounds.find((i) => i.tag === 'api')!.port
  // @ts-expect-error -- `uuid` is the SDK's own field, untyped in its .d.ts
  return { cfg, uuid: sdk.uuid as string, apiPort }
}

test('byte-identical to the SDK for every transport x proxy x security', async () => {
  let checked = 0
  for (const t of TRANSPORTS) {
    for (const p of PROXIES) {
      for (const s of SECURITIES) {
        const metadata = [{ port: '8443', transport_protocol: t, proxy_protocol: p, transport_security: s }]
        const { cfg, uuid, apiPort } = await sdkConfig(metadata, ['203.0.113.10'])
        const ours = buildV2RayConfig({ metadata }, ['203.0.113.10'], uuid, apiPort)
        assert.equal(
          JSON.stringify(ours, null, 2),
          JSON.stringify(cfg, null, 2),
          `transport ${t} proxy ${p} security ${s}`,
        )
        checked++
      }
    }
  }
  assert.equal(checked, 81)
})

test('byte-identical for a multi-inbound node, balancer selector included', async () => {
  const metadata = [
    { port: '8443', transport_protocol: 7, proxy_protocol: 2, transport_security: 1 },
    { port: '8444', transport_protocol: 3, proxy_protocol: 1, transport_security: 2 },
    { port: 8445, transport_protocol: 8, proxy_protocol: 2, transport_security: 2 },
  ]
  const { cfg, uuid, apiPort } = await sdkConfig(metadata, ['198.51.100.7'])
  const ours = buildV2RayConfig({ metadata }, ['198.51.100.7'], uuid, apiPort)
  assert.equal(JSON.stringify(ours, null, 2), JSON.stringify(cfg, null, 2))
  // The selector is what routes traffic; assert it explicitly rather than
  // trusting the whole-object compare to have covered it.
  const routing = ours.routing as { balancers: { selector: string[] }[] }
  assert.deepEqual(routing.balancers[0].selector, [
    '198.51.100.7_8443_vmess_tcp_none',
    '198.51.100.7_8444_vless_grpc_tls',
    '198.51.100.7_8445_vmess_ws_tls',
  ])
})

test('an unknown transport falls back to tcp, as the SDK does', async () => {
  const metadata = [{ port: '8443', transport_protocol: 99, proxy_protocol: 1, transport_security: 1 }]
  const { cfg, uuid, apiPort } = await sdkConfig(metadata, ['203.0.113.10'])
  const ours = buildV2RayConfig({ metadata }, ['203.0.113.10'], uuid, apiPort)
  assert.equal(JSON.stringify(ours), JSON.stringify(cfg))
})

test('the output passes the config guard that gates the real spawn', () => {
  const metadata = [{ port: '8443', transport_protocol: 7, proxy_protocol: 2, transport_security: 2 }]
  const cfg = buildV2RayConfig({ metadata }, ['203.0.113.10'], 'b831381d-6324-4d53-ad4f-8cda48b30811', 32451)
  assert.doesNotThrow(() => assertSafeV2RayConfig(cfg))
})

test('refuses incomplete node data rather than emitting a half-built config', () => {
  const uuid = 'b831381d-6324-4d53-ad4f-8cda48b30811'
  assert.throws(() => buildV2RayConfig({ metadata: [] }, ['1.2.3.4'], uuid, 1), /no inbounds/)
  assert.throws(
    () => buildV2RayConfig({ metadata: [{ port: 1, proxy_protocol: 1, transport_protocol: 7, transport_security: 1 }] }, [], uuid, 1),
    /no node address/,
  )
})
