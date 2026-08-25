import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isProxyCapable } from './protocols.ts'

test('only the child-proxy protocols qualify for local proxy mode', () => {
  // v2ray (2), xray (4) and hysteria2 (6) expose a local SOCKS5 listener.
  assert.equal(isProxyCapable(2), true)
  assert.equal(isProxyCapable(4), true)
  assert.equal(isProxyCapable(6), true)
})

test('the root-path protocols and unknown are not proxy capable', () => {
  // WireGuard (1), OpenVPN (3) and AmneziaWG (5) route the whole device or
  // nothing; unknown (0) is never connectable at all.
  for (const type of [0, 1, 3, 5]) {
    assert.equal(isProxyCapable(type), false, `type ${type}`)
  }
})
