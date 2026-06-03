import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseProcNetDev, maxUsageBytes } from './traffic-stats.ts'

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

// After disconnect the on-chain counter lags the usage we measured live, so the
// session display merges them as max(onChain, remembered) — picking whichever is
// larger keeps the just-measured value visible and self-clears once the chain
// settles (onChain >= remembered) without double-counting.
test('maxUsageBytes returns the larger of two byte strings', () => {
  assert.equal(maxUsageBytes('500', '3000000000'), '3000000000') // remembered live > stale chain
  assert.equal(maxUsageBytes('3000000000', '500'), '3000000000') // chain settled > remembered
})

test('maxUsageBytes handles equal values', () => {
  assert.equal(maxUsageBytes('1024', '1024'), '1024')
})

test('maxUsageBytes treats missing/empty/non-numeric as 0', () => {
  assert.equal(maxUsageBytes('', '42'), '42')
  assert.equal(maxUsageBytes('42', ''), '42')
  assert.equal(maxUsageBytes('garbage', '7'), '7')
  assert.equal(maxUsageBytes('0', '0'), '0')
})
