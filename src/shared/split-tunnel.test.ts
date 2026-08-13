import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  isAllowedBypassCidr,
  parseSplitTunnelRoutes,
  MAX_SPLIT_TUNNEL_ROUTES,
} from './split-tunnel.ts'
import {
  isAllowedBypassCidr as guardIsAllowedBypassCidr,
  sanitizeBypassRoutes,
} from '../main/config-guard.ts'

test('isAllowedBypassCidr agrees with the main-process guard that enforces it', () => {
  // The pane can only pre-empt a rejection by applying the identical rule. This
  // mirror exists because config-guard.ts must stay free of local runtime
  // imports; if the two ever drift, the silent-save bug comes back — so assert
  // agreement over every shape either side cares about.
  const cases = [
    '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '192.168.1.0/24', '203.0.113.7/32',
    '0.0.0.0/0', '0.0.0.0/1', '0.0.0.0/8', '0.0.0.0/32',
    '10.0.0.0/0', '10.0.0.0/33', '10.0.0.0/99', '999.0.0.1/8', '256.0.0.0/8',
    '10.0.0/8', '10.0.0.0', '10.0.0.0/', '/8', 'garbage', '', '   ',
    'fd00::/8', '::/0', 'netflix.com', '10.0.0.0/8  # home lan', '10.0.0.0/8, 192.168.0.0/16',
    ' 10.0.0.0/8 ', '10.0.0.0/08', '1.2.3.4/1',
  ]
  for (const c of cases) {
    assert.equal(
      isAllowedBypassCidr(c),
      guardIsAllowedBypassCidr(c),
      `mirror disagrees with config-guard on ${JSON.stringify(c)}`,
    )
  }
})

test('the cap matches the one the main process applies', () => {
  const overCap = Array.from({ length: MAX_SPLIT_TUNNEL_ROUTES + 5 }, (_, i) => `10.${i}.0.0/16`)
  assert.equal(sanitizeBypassRoutes(overCap).length, MAX_SPLIT_TUNNEL_ROUTES)
})

test('parseSplitTunnelRoutes keeps valid CIDRs and ignores blank lines', () => {
  const parsed = parseSplitTunnelRoutes('10.0.0.0/8\n\n  172.16.0.0/12  \n192.168.0.0/16\n')
  assert.deepEqual(parsed.routes, ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'])
  assert.deepEqual(parsed.invalid, [])
  assert.equal(parsed.tooMany, false)
})

test('parseSplitTunnelRoutes reports the lines the save would be rejected for', () => {
  // Each of these silently killed the Save Routes click: the handler sent them
  // to SETTINGS_SET, which threw, and nothing caught the rejection.
  const parsed = parseSplitTunnelRoutes(
    '10.0.0.0/8\n192.168.1.50\nnetflix.com\nfd00::/8\n0.0.0.0/0\n10.0.0.0/8  # home lan',
  )
  assert.deepEqual(parsed.routes, ['10.0.0.0/8'])
  assert.deepEqual(parsed.invalid, [
    '192.168.1.50',
    'netflix.com',
    'fd00::/8',
    '0.0.0.0/0',
    '10.0.0.0/8  # home lan',
  ])
})

test('parseSplitTunnelRoutes flags a list over the cap instead of silently truncating', () => {
  const overCap = Array.from({ length: MAX_SPLIT_TUNNEL_ROUTES + 1 }, (_, i) => `10.${i}.0.0/16`)
  const parsed = parseSplitTunnelRoutes(overCap.join('\n'))
  assert.equal(parsed.tooMany, true)
  assert.equal(parsed.routes.length, MAX_SPLIT_TUNNEL_ROUTES + 1)

  const atCap = overCap.slice(0, MAX_SPLIT_TUNNEL_ROUTES)
  assert.equal(parseSplitTunnelRoutes(atCap.join('\n')).tooMany, false)
})

test('parseSplitTunnelRoutes accepts an emptied textarea as an empty list', () => {
  const parsed = parseSplitTunnelRoutes('   \n\n  ')
  assert.deepEqual(parsed.routes, [])
  assert.deepEqual(parsed.invalid, [])
  assert.equal(parsed.tooMany, false)
})
