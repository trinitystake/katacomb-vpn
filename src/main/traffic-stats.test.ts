import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseProcNetDev } from './traffic-stats.ts'

// Realistic /proc/net/dev snapshot (rx = field 1, tx = field 9 after the iface label).
const PROC_NET_DEV = `Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo:  123456     100    0    0    0     0          0         0   123456     100    0    0    0     0       0          0
  sntl0: 14390024   15665    0    0    0     0          0         0  9255584   12998    0    0    0     0       0          0
`

test('parseProcNetDev reads the WireGuard interface rx/tx bytes', () => {
  // rx = download, tx = upload — verified against a live sntl0 interface.
  assert.deepEqual(parseProcNetDev(PROC_NET_DEV, 'sntl0'), { rx: 14390024, tx: 9255584 })
})

test('parseProcNetDev reads another interface', () => {
  assert.deepEqual(parseProcNetDev(PROC_NET_DEV, 'lo'), { rx: 123456, tx: 123456 })
})

test('parseProcNetDev returns null for a missing interface', () => {
  assert.equal(parseProcNetDev(PROC_NET_DEV, 'sntl-tun'), null)
})

test('parseProcNetDev returns null for garbage content', () => {
  assert.equal(parseProcNetDev('not a proc file', 'sntl0'), null)
})
