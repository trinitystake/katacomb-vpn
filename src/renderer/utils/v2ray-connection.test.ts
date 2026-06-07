import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isNodeConnection, isCleartextConnection, v2rayConnectionBadge, v2rayConnectionCategory } from './v2ray-connection.ts'

test('isNodeConnection narrows only full {proxy,transport,security} objects', () => {
  assert.equal(isNodeConnection({ proxy: 'vmess', transport: 'grpc', security: 'tls' }), true)
  assert.equal(isNodeConnection(null), false)
  assert.equal(isNodeConnection(undefined), false)
  assert.equal(isNodeConnection({}), false)
  assert.equal(isNodeConnection({ proto: 'udp' }), false)
  assert.equal(isNodeConnection('vmess'), false)
  assert.equal(isNodeConnection(42), false)
})

test('isCleartextConnection flags only vless+none', () => {
  assert.equal(isCleartextConnection({ proxy: 'vless', transport: 'tcp', security: 'none' }), true)
  assert.equal(isCleartextConnection({ proxy: 'vmess', transport: 'grpc', security: 'none' }), false)
  assert.equal(isCleartextConnection({ proxy: 'vmess', transport: 'quic', security: 'tls' }), false)
  assert.equal(isCleartextConnection({ proxy: 'vless', transport: 'grpc', security: 'tls' }), false)
  assert.equal(isCleartextConnection(null), false)
  assert.equal(isCleartextConnection({ proto: 'udp' }), false)
})

test('isCleartextConnection is case-insensitive', () => {
  assert.equal(isCleartextConnection({ proxy: 'VLess', transport: 'tcp', security: 'None' }), true)
})

test('v2rayConnectionCategory maps every combo', () => {
  assert.equal(v2rayConnectionCategory({ proxy: 'vmess', transport: 'grpc', security: 'none' }), 'vmess')
  assert.equal(v2rayConnectionCategory({ proxy: 'vmess', transport: 'quic', security: 'tls' }), 'vmess-tls')
  assert.equal(v2rayConnectionCategory({ proxy: 'vless', transport: 'grpc', security: 'tls' }), 'vless-tls')
  assert.equal(v2rayConnectionCategory({ proxy: 'vless', transport: 'tcp', security: 'none' }), 'vless-none')
  assert.equal(v2rayConnectionCategory(null), 'unknown')
  assert.equal(v2rayConnectionCategory({}), 'unknown')
  assert.equal(v2rayConnectionCategory({ proto: 'udp' }), 'unknown')
  assert.equal(v2rayConnectionCategory('vmess'), 'unknown')
  assert.equal(v2rayConnectionCategory(42), 'unknown')
})

test('v2rayConnectionCategory is case-insensitive', () => {
  assert.equal(v2rayConnectionCategory({ proxy: 'VLess', transport: 'tcp', security: 'None' }), 'vless-none')
  assert.equal(v2rayConnectionCategory({ proxy: 'VMess', transport: 'grpc', security: 'TLS' }), 'vmess-tls')
})

test('v2rayConnectionBadge matches config-guard badge strings', () => {
  assert.equal(v2rayConnectionBadge({ proxy: 'vmess', transport: 'grpc', security: 'none' }), 'VMess')
  assert.equal(v2rayConnectionBadge({ proxy: 'vmess', transport: 'quic', security: 'tls' }), 'VMess+TLS')
  assert.equal(v2rayConnectionBadge({ proxy: 'vless', transport: 'grpc', security: 'tls' }), 'VLess+TLS')
  assert.equal(v2rayConnectionBadge({ proxy: 'vless', transport: 'tcp', security: 'none' }), 'VLess ⚠')
  assert.equal(v2rayConnectionBadge(null), null)
  assert.equal(v2rayConnectionBadge({ proto: 'udp' }), null)
})
