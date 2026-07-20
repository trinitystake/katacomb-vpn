import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseDefaultRoute, v2rayRunArgs, firstIPv4FromGetent } from './vpn-parse.ts'

// --- parseDefaultRoute: `ip route show default` output ---

test('parseDefaultRoute reads gateway + iface from a normal default route', () => {
  assert.deepEqual(
    parseDefaultRoute('default via 192.168.1.1 dev eth0 proto dhcp metric 100'),
    { gateway: '192.168.1.1', iface: 'eth0' },
  )
})

test('parseDefaultRoute handles a wifi interface', () => {
  assert.deepEqual(
    parseDefaultRoute('default via 10.0.0.1 dev wlp3s0'),
    { gateway: '10.0.0.1', iface: 'wlp3s0' },
  )
})

test('parseDefaultRoute returns null when there is no default route', () => {
  assert.equal(parseDefaultRoute('192.168.1.0/24 dev eth0 proto kernel scope link'), null)
})

test('parseDefaultRoute returns null for empty output', () => {
  assert.equal(parseDefaultRoute(''), null)
})

// --- v2rayRunArgs: V5 `run` subcommand vs V4 flat flags ---

test('v2rayRunArgs uses the run subcommand on V5+', () => {
  assert.deepEqual(v2rayRunArgs(5, '/tmp/c.json'), ['run', '-config', '/tmp/c.json'])
  assert.deepEqual(v2rayRunArgs(6, '/tmp/c.json'), ['run', '-config', '/tmp/c.json'])
})

test('v2rayRunArgs uses flat flags on V4 and unknown (0)', () => {
  assert.deepEqual(v2rayRunArgs(4, '/tmp/c.json'), ['-config', '/tmp/c.json'])
  assert.deepEqual(v2rayRunArgs(0, '/tmp/c.json'), ['-config', '/tmp/c.json'])
})

// --- firstIPv4FromGetent: `getent ahostsv4 <host>` output ---

test('firstIPv4FromGetent returns the first IPv4 in getent output', () => {
  const out = '93.184.216.34  STREAM example.com\n93.184.216.34  DGRAM\n93.184.216.34  RAW\n'
  assert.equal(firstIPv4FromGetent(out), '93.184.216.34')
})

test('firstIPv4FromGetent returns null for empty / non-IPv4 output', () => {
  assert.equal(firstIPv4FromGetent(''), null)
  assert.equal(firstIPv4FromGetent('garbage without an ip\n'), null)
})
