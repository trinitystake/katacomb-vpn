import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sessionFailureMessage, decideReconnect, backoffDelayMs, serviceTypeToNodeType, isDnsProvisionError, stripDnsLines, evaluateQuota, isTunnelOneWay, describeNodeApiError, deadTunnelMessage, decideFirewallAction, ONE_WAY_TX_FLOOR_BYTES, ONE_WAY_SILENCE_MS } from './connect-decisions.ts'

// --- sessionFailureMessage ---

test('sessionFailureMessage: not refunded surfaces the session id and manual-cancel steps', () => {
  const msg = sessionFailureMessage({
    refunded: false, isDeposit: true, sessionId: '4242', nodeMoniker: 'nodeA',
    reason: 'boom', policyRejected: false,
  })
  assert.match(msg, /#4242/)
  assert.match(msg, /cancel .*manually/i)
  assert.doesNotMatch(msg, /refunded/i)
})

test('sessionFailureMessage: refunded deposit says deposit refunded, no session id', () => {
  const msg = sessionFailureMessage({
    refunded: true, isDeposit: true, sessionId: '4242', nodeMoniker: 'nodeA',
    reason: 'boom', policyRejected: false,
  })
  assert.match(msg, /deposit refunded/i)
  assert.doesNotMatch(msg, /#4242/)
})

test('sessionFailureMessage: refunded plan (non-deposit) omits deposit wording and session id', () => {
  const msg = sessionFailureMessage({
    refunded: true, isDeposit: false, sessionId: '4242', nodeMoniker: 'nodeA',
    reason: 'boom', policyRejected: false,
  })
  assert.match(msg, /cancelled/i)
  assert.doesNotMatch(msg, /deposit/i)
  assert.doesNotMatch(msg, /#4242/)
})

test('sessionFailureMessage: policy rejection uses the VLess-none preamble', () => {
  const msg = sessionFailureMessage({
    refunded: true, isDeposit: true, sessionId: '1', nodeMoniker: 'nodeA',
    reason: 'ignored', policyRejected: true,
  })
  assert.match(msg, /VLess-none/i)
  assert.match(msg, /nodeA/)
})

test('sessionFailureMessage: generic failure includes the underlying reason', () => {
  const msg = sessionFailureMessage({
    refunded: true, isDeposit: true, sessionId: '1', nodeMoniker: 'nodeA',
    reason: 'connection refused', policyRejected: false,
  })
  assert.match(msg, /connection refused/)
  assert.doesNotMatch(msg, /VLess-none/i)
})

// --- decideReconnect ---

const base = { attempt: 0, maxAttempts: 5, autoReconnect: true, intentional: false, hasSession: true }

test('decideReconnect: aborts when there is no active session', () => {
  assert.deepEqual(decideReconnect({ ...base, hasSession: false }), { action: 'abort' })
})

test('decideReconnect: aborts on an intentional disconnect', () => {
  assert.deepEqual(decideReconnect({ ...base, intentional: true }), { action: 'abort' })
})

test('decideReconnect: aborts when auto-reconnect is off', () => {
  assert.deepEqual(decideReconnect({ ...base, autoReconnect: false }), { action: 'abort' })
})

test('decideReconnect: gives up once the next attempt would exceed the max', () => {
  assert.deepEqual(decideReconnect({ ...base, attempt: 5, maxAttempts: 5 }), { action: 'give-up' })
})

test('decideReconnect: retries with the incremented attempt and its backoff', () => {
  assert.deepEqual(decideReconnect({ ...base, attempt: 0 }), { action: 'retry', attempt: 1, delayMs: 2000 })
})

test('decideReconnect: abort takes precedence over give-up', () => {
  assert.deepEqual(
    decideReconnect({ ...base, attempt: 5, maxAttempts: 5, intentional: true }),
    { action: 'abort' },
  )
})

// --- backoffDelayMs ---

test('backoffDelayMs: exponential growth', () => {
  assert.equal(backoffDelayMs(1), 2000)
  assert.equal(backoffDelayMs(2), 4000)
  assert.equal(backoffDelayMs(5), 32000)
})

test('backoffDelayMs: capped at 60000', () => {
  assert.equal(backoffDelayMs(6), 60000)
  assert.equal(backoffDelayMs(10), 60000)
})

// --- serviceTypeToNodeType ---

test('serviceTypeToNodeType: canonical names', () => {
  assert.equal(serviceTypeToNodeType('wireguard'), 1)
  assert.equal(serviceTypeToNodeType('v2ray'), 2)
  assert.equal(serviceTypeToNodeType('openvpn'), 3)
  assert.equal(serviceTypeToNodeType('xray'), 4)
  assert.equal(serviceTypeToNodeType('amneziawg'), 5)
  assert.equal(serviceTypeToNodeType('hysteria2'), 6)
})

test('serviceTypeToNodeType: separator and case variants nodes actually report', () => {
  assert.equal(serviceTypeToNodeType('WireGuard'), 1)
  assert.equal(serviceTypeToNodeType('wire_guard'), 1)
  assert.equal(serviceTypeToNodeType('V2Ray'), 2)
  assert.equal(serviceTypeToNodeType('open-vpn'), 3)
  assert.equal(serviceTypeToNodeType('amnezia_wg'), 5)
  assert.equal(serviceTypeToNodeType('Amnezia WG'), 5)
  assert.equal(serviceTypeToNodeType('awg'), 5)
  assert.equal(serviceTypeToNodeType('HYSTERIA2'), 6)
  assert.equal(serviceTypeToNodeType('hysteria_2'), 6)
  assert.equal(serviceTypeToNodeType('hy2'), 6)
})

test('serviceTypeToNodeType: numeric passthrough only inside 1-6', () => {
  assert.equal(serviceTypeToNodeType(1), 1)
  assert.equal(serviceTypeToNodeType(6), 6)
  assert.equal(serviceTypeToNodeType('4'), 4)
  assert.equal(serviceTypeToNodeType(0), null)
  assert.equal(serviceTypeToNodeType(7), null)
  assert.equal(serviceTypeToNodeType(1.5), null)
})

test('serviceTypeToNodeType: unknown or malformed input is null', () => {
  assert.equal(serviceTypeToNodeType('shadowsocks'), null)
  assert.equal(serviceTypeToNodeType(''), null)
  assert.equal(serviceTypeToNodeType(undefined), null)
  assert.equal(serviceTypeToNodeType(null), null)
  assert.equal(serviceTypeToNodeType({}), null)
  assert.equal(serviceTypeToNodeType(['wireguard']), null)
})

// --- isDnsProvisionError ---

test('isDnsProvisionError: matches the resolvconf failures wg-quick/awg-quick emit', () => {
  assert.equal(isDnsProvisionError('/usr/bin/wg-quick: line 32: resolvconf: command not found'), true)
  assert.equal(isDnsProvisionError('RESOLVCONF: command not found'), true)
  assert.equal(isDnsProvisionError('sh: 1: resolvconf: not found'), true)
  assert.equal(isDnsProvisionError('Error: resolvconf is required but missing'), true)
})

test('isDnsProvisionError: unrelated bring-up failures are not DNS failures', () => {
  assert.equal(isDnsProvisionError('RTNETLINK answers: Operation not permitted'), false)
  assert.equal(isDnsProvisionError('wg-quick: `sntl0` already exists'), false)
  assert.equal(isDnsProvisionError(''), false)
})

// --- stripDnsLines ---

test('stripDnsLines: removes DNS lines, leaves the rest of the INI byte-identical', () => {
  const config = [
    '[Interface]',
    'PrivateKey = abc123',
    'Address = 10.0.0.2/32',
    'DNS = 1.1.1.1, 8.8.8.8',
    '',
    '[Peer]',
    'PublicKey = def456',
    'Endpoint = 1.2.3.4:51820',
  ].join('\n')
  const stripped = stripDnsLines(config)
  assert.doesNotMatch(stripped, /DNS/)
  assert.match(stripped, /PrivateKey = abc123/)
  assert.match(stripped, /Endpoint = 1\.2\.3\.4:51820/)
  assert.match(stripped, /\[Peer\]/)
})

test('stripDnsLines: tolerates spacing/case variants and leading whitespace', () => {
  assert.equal(stripDnsLines('DNS=1.1.1.1\nAddress = 10.0.0.2/32'), 'Address = 10.0.0.2/32')
  assert.equal(stripDnsLines('  dns   =  1.1.1.1  \nAddress = 10.0.0.2/32'), 'Address = 10.0.0.2/32')
})

test('stripDnsLines: a config without DNS is returned unchanged', () => {
  const config = '[Interface]\nPrivateKey = abc\nAddress = 10.0.0.2/32'
  assert.equal(stripDnsLines(config), config)
})

test('stripDnsLines: does not eat keys that merely start with DNS', () => {
  const config = 'DNSSomething = keepme\nDNS = 1.1.1.1'
  assert.equal(stripDnsLines(config), 'DNSSomething = keepme')
})

// --- evaluateQuota ---

// A capless session: no byte cap, no time cap, nothing used. Every case below
// overrides only the fields it is actually testing.
const CAPLESS = {
  maxDurationSeconds: null, baselineDurationSeconds: 0, connectedSeconds: 0,
  maxBytes: 0, baselineBytes: 0, liveRxBytes: 0,
}

test('evaluateQuota: a session with NO cap never expires, however long it runs', () => {
  const v = evaluateQuota({ ...CAPLESS, connectedSeconds: 400 * 3600, liveRxBytes: 900e9 })
  assert.equal(v.level, 'ok')
})

// The regression this whole measure exists for. Session #53647217 on mainnet sat
// for 53 minutes without being connected: chain `duration` 0, 0 bytes. Measured by
// wall-clock since startAt that reads 88% and the watchdog tears it down, throwing
// away a full paid hour that was never used.
test('evaluateQuota: an idle unused session reads 0%, no matter how old it is', () => {
  assert.deepEqual(
    evaluateQuota({ ...CAPLESS, maxDurationSeconds: 3600, baselineDurationSeconds: 0, connectedSeconds: 0 }),
    { level: 'ok', pct: 0 },
  )
})

test('evaluateQuota: time counts the chain baseline PLUS this tunnel, warns at 90%, expires at 100%', () => {
  const hour = { ...CAPLESS, maxDurationSeconds: 3600 }
  // 20 min already metered on chain + 10 min on this tunnel = 50%.
  assert.deepEqual(
    evaluateQuota({ ...hour, baselineDurationSeconds: 1200, connectedSeconds: 600 }),
    { level: 'ok', pct: 50 },
  )
  const warn = evaluateQuota({ ...hour, baselineDurationSeconds: 3000, connectedSeconds: 300 })
  assert.equal(warn.level, 'warn')
  assert.equal(warn.level === 'warn' && warn.reason, 'time')
  assert.equal(warn.level === 'warn' && warn.remaining, 300) // 5 min left, in seconds
  assert.deepEqual(
    evaluateQuota({ ...hour, baselineDurationSeconds: 3000, connectedSeconds: 600 }),
    { level: 'expired', reason: 'time' },
  )
})

test('evaluateQuota: data counts the on-chain baseline PLUS the live interface bytes', () => {
  const gig = { ...CAPLESS, maxBytes: 1000 }
  assert.deepEqual(evaluateQuota({ ...gig, baselineBytes: 400, liveRxBytes: 100 }), { level: 'ok', pct: 50 })
  const warn = evaluateQuota({ ...gig, baselineBytes: 400, liveRxBytes: 550 })
  assert.equal(warn.level, 'warn')
  assert.equal(warn.level === 'warn' && warn.reason, 'data')
  assert.equal(warn.level === 'warn' && warn.remaining, 50) // bytes left
  assert.deepEqual(
    evaluateQuota({ ...gig, baselineBytes: 400, liveRxBytes: 600 }),
    { level: 'expired', reason: 'data' },
  )
})

test('evaluateQuota: with both caps the WORST one decides, and names itself as the reason', () => {
  const both = { ...CAPLESS, maxDurationSeconds: 3600, maxBytes: 1000 }
  // 10% of the time, 95% of the data → data warns.
  const dataWorst = evaluateQuota({ ...both, connectedSeconds: 360, liveRxBytes: 950 })
  assert.equal(dataWorst.level === 'warn' && dataWorst.reason, 'data')
  // 95% of the time, 10% of the data → time warns.
  const timeWorst = evaluateQuota({ ...both, connectedSeconds: 3420, liveRxBytes: 100 })
  assert.equal(timeWorst.level === 'warn' && timeWorst.reason, 'time')
  // Either cap alone reaching 100% expires the session.
  assert.deepEqual(
    evaluateQuota({ ...both, connectedSeconds: 60, liveRxBytes: 1000 }),
    { level: 'expired', reason: 'data' },
  )
})

test('evaluateQuota: boundaries are inclusive — exactly 90% warns, exactly 100% expires', () => {
  const gig = { ...CAPLESS, maxBytes: 1000 }
  assert.equal(evaluateQuota({ ...gig, liveRxBytes: 899 }).level, 'ok')
  assert.equal(evaluateQuota({ ...gig, liveRxBytes: 900 }).level, 'warn')
  assert.equal(evaluateQuota({ ...gig, liveRxBytes: 999 }).level, 'warn')
  assert.equal(evaluateQuota({ ...gig, liveRxBytes: 1000 }).level, 'expired')
})

test('evaluateQuota: a node metering slightly past the cap still reads as expired, not negative', () => {
  // #53634305 recorded 3618s against a 3600s cap.
  const v = evaluateQuota({ ...CAPLESS, maxDurationSeconds: 3600, baselineDurationSeconds: 3618 })
  assert.deepEqual(v, { level: 'expired', reason: 'time' })
})

// --- isTunnelOneWay ---

test('isTunnelOneWay: traffic leaving with no reply, for long enough, is a dead tunnel', () => {
  assert.equal(isTunnelOneWay(ONE_WAY_TX_FLOOR_BYTES, ONE_WAY_SILENCE_MS), true)
  assert.equal(isTunnelOneWay(5 * 1024 * 1024, 10 * 60_000), true)
})

test('isTunnelOneWay: an idle tunnel is not a dead one', () => {
  // The case that makes a naive "no rx" check wrong: nothing is going out either,
  // so there is no evidence of anything being wrong.
  assert.equal(isTunnelOneWay(0, ONE_WAY_SILENCE_MS * 10), false)
  assert.equal(isTunnelOneWay(200, 60 * 60_000), false)
})

test('isTunnelOneWay: a brief stall is not a dead tunnel', () => {
  assert.equal(isTunnelOneWay(10 * 1024 * 1024, ONE_WAY_SILENCE_MS - 1), false)
})

test('isTunnelOneWay: both thresholds are inclusive, and both are required', () => {
  assert.equal(isTunnelOneWay(ONE_WAY_TX_FLOOR_BYTES - 1, ONE_WAY_SILENCE_MS), false)
  assert.equal(isTunnelOneWay(ONE_WAY_TX_FLOOR_BYTES, ONE_WAY_SILENCE_MS - 1), false)
  assert.equal(isTunnelOneWay(ONE_WAY_TX_FLOOR_BYTES, ONE_WAY_SILENCE_MS), true)
})

test('isTunnelOneWay: the #53647217 shape — a node that never answered the handshake', () => {
  // Measured live: ~3 KB out over minutes, 0 bytes in. Below the tx floor, so the
  // watchdog abstains and the CONNECT-time probe is what has to catch this one.
  assert.equal(isTunnelOneWay(3119, 3 * 60_000), false)
  // Left up longer, the app's own retries push it past the floor and it trips.
  assert.equal(isTunnelOneWay(80 * 1024, 5 * 60_000), true)
})

// --- describeNodeApiError ---

/** The rejection shape axios produces, trimmed to the fields that matter. */
function axiosError(status: number, nodeMessage: string) {
  return {
    isAxiosError: true,
    message: `Request failed with status code ${status}`,
    response: { status, data: { success: false, error: { code: 3, message: nodeMessage } } },
  }
}

test('describeNodeApiError: the node\'s own sentence wins over axios\' generic one', () => {
  // Verbatim from a reconnect to mainnet #53670474 on helen.busur.cc.
  const d = describeNodeApiError(axiosError(409, 'session 53670474 already exists in database'))
  assert.equal(d.status, 409)
  assert.equal(d.message, 'session 53670474 already exists in database')
})

test('describeNodeApiError: falls back to the error message when the node sent no body', () => {
  assert.deepEqual(describeNodeApiError({ message: 'node handshake timed out after 20000ms' }), {
    status: null,
    message: 'node handshake timed out after 20000ms',
  })
  assert.deepEqual(describeNodeApiError(new Error('socket hang up')), {
    status: null,
    message: 'socket hang up',
  })
})

test('describeNodeApiError: a status with an unusable body still reports the status', () => {
  assert.deepEqual(describeNodeApiError({ message: 'Request failed with status code 502', response: { status: 502 } }), {
    status: 502,
    message: 'Request failed with status code 502',
  })
  // An empty node message is not an explanation — keep axios' own.
  assert.equal(describeNodeApiError(axiosError(500, '')).message, 'Request failed with status code 500')
})

test('describeNodeApiError: survives shapes it was never given', () => {
  assert.deepEqual(describeNodeApiError(null), { status: null, message: 'null' })
  assert.deepEqual(describeNodeApiError('plain string'), { status: null, message: 'plain string' })
  assert.equal(describeNodeApiError({ response: { status: '409' } }).status, null)
})

// --- deadTunnelMessage ---

test('deadTunnelMessage: a replayed config that carries nothing is unrecoverable, not retryable', () => {
  // Mainnet #53670474: the node answered 409 (record present, no new peer), the
  // saved config was replayed, and the tunnel moved nothing. Verified by sending a
  // real WireGuard initiation with that config's own keys — no answer at all.
  const msg = deadTunnelMessage(false)
  // It must NOT send the user back round the loop that just failed — which is
  // exactly what the single old message did ("reconnect from the Sessions tab to
  // renew the handshake with the node"), for a node that cannot renew it.
  assert.equal(/retry/i.test(msg), false)
  assert.equal(/reconnect from|reconnect(ing)? (to|and)/i.test(msg), false)
  // It must say the session is finished and name the way out.
  assert.match(msg, /cannot be reconnected/i)
  assert.match(msg, /new session/i)
})

test('deadTunnelMessage: a freshly issued peer that carries nothing is worth one retry', () => {
  // The node minted a peer for this very tunnel, so the dead-peer verdict does not
  // apply — the fault may be local (routing, kill switch) or a momentary node stall.
  const msg = deadTunnelMessage(true)
  assert.match(msg, /retry/i)
  // Still true in both cases: the session is paid for and stays open.
  assert.match(msg, /still open/i)
})

test('deadTunnelMessage: neither wording promises money back', () => {
  // Ending a session forfeits the remainder (the confirm dialog says so); the panel
  // must not contradict it.
  for (const msg of [deadTunnelMessage(true), deadTunnelMessage(false)]) {
    assert.equal(/refund|reclaim|deposit back/i.test(msg), false)
  }
})

// --- decideFirewallAction ---

test('decideFirewallAction disarms when the kill switch is switched off', () => {
  assert.equal(decideFirewallAction({
    killSwitch: false, lanSharing: false, armed: true, armedLanSharing: false, tunnelActive: true,
  }), 'disarm')
})

test('decideFirewallAction disarms an armed chain even with no tunnel up', () => {
  // The stand-down state ("expired, traffic blocked") — this is the user's way out.
  assert.equal(decideFirewallAction({
    killSwitch: false, lanSharing: false, armed: true, armedLanSharing: false, tunnelActive: false,
  }), 'disarm')
})

test('decideFirewallAction re-arms when LAN sharing changes under an armed chain', () => {
  assert.equal(decideFirewallAction({
    killSwitch: true, lanSharing: true, armed: true, armedLanSharing: false, tunnelActive: true,
  }), 'rearm')
  assert.equal(decideFirewallAction({
    killSwitch: true, lanSharing: false, armed: true, armedLanSharing: true, tunnelActive: true,
  }), 'rearm')
})

test('decideFirewallAction re-arms in the stand-down state too', () => {
  assert.equal(decideFirewallAction({
    killSwitch: true, lanSharing: true, armed: true, armedLanSharing: false, tunnelActive: false,
  }), 'rearm')
})

test('decideFirewallAction arms when the kill switch goes on over a live tunnel', () => {
  assert.equal(decideFirewallAction({
    killSwitch: true, lanSharing: false, armed: false, armedLanSharing: false, tunnelActive: true,
  }), 'arm')
})

test('decideFirewallAction does nothing with no tunnel to protect', () => {
  // Also covers proxy mode: isVpnActive() is false there by design, and the kill
  // switch is deliberately never armed for it.
  assert.equal(decideFirewallAction({
    killSwitch: true, lanSharing: true, armed: false, armedLanSharing: false, tunnelActive: false,
  }), 'none')
})

test('decideFirewallAction does nothing when the chain already matches the settings', () => {
  assert.equal(decideFirewallAction({
    killSwitch: true, lanSharing: true, armed: true, armedLanSharing: true, tunnelActive: true,
  }), 'none')
  assert.equal(decideFirewallAction({
    killSwitch: false, lanSharing: true, armed: false, armedLanSharing: false, tunnelActive: true,
  }), 'none')
})

test('decideFirewallAction ignores a LAN change while nothing is armed', () => {
  assert.equal(decideFirewallAction({
    killSwitch: false, lanSharing: true, armed: false, armedLanSharing: false, tunnelActive: true,
  }), 'none')
})
