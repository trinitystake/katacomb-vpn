import { test, before, describe } from 'node:test'
import assert from 'node:assert/strict'
import { buildSync } from 'esbuild'
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { createRequire } from 'node:module'
import { LAN_SHARING_ARG } from '../config-guard.ts'

// privileged.ts is THE routing decision for every operation that runs as root:
// daemon socket when one is installed, pkexec one-shot otherwise. Two things here
// are security rules rather than plumbing, and neither had a test:
//
//   - a daemon that REJECTED an op must never be retried under pkexec (that would
//     re-run a validation failure with a password prompt in front of it);
//   - a daemon that is UNREACHABLE must fall back, or a stale socket after a crash
//     leaves the user with no route to root at all.
//
// It uses extensionless relative imports, so - like daemon-client.test.ts - it is
// bundled with esbuild and required as CJS. Its two relative imports and its two
// node builtins are aliased to recording stubs, so the whole verb->op mapping can
// be driven without a socket, a helper binary or a polkit prompt.

interface Harness {
  runPrivileged: (args: string[]) => Promise<void>
  canEscalatePrivileges: () => boolean
  calls: Array<{ op: string; args: unknown }>
  execCalls: Array<{ cmd: string; argv: string[] }>
  Unreachable: new (m: string) => Error
  set: (c: Partial<{ daemonUp: boolean; helperInstalled: boolean; fail: Error | null }>) => void
}

let H: Harness

before(() => {
  const dir = mkdtempSync(join(tmpdir(), 'privileged-test-'))
  const root = join(dir, 'main')
  mkdirSync(join(root, 'helper'), { recursive: true })

  // The module under test, verbatim from source - never a copy that can drift.
  const realSrc = readFileSync('src/main/helper/privileged.ts', 'utf-8')
  writeFileSync(join(root, 'helper', 'privileged.ts'), realSrc)

  // Recording stubs in the places its relative imports resolve to.
  writeFileSync(join(root, 'helper', 'daemon-client.ts'), `
export class DaemonUnreachableError extends Error {}
export const state = { daemonUp: true, fail: null as Error | null }
export const calls: Array<{ op: string; args: unknown }> = []
export function isDaemonAvailable(): boolean { return state.daemonUp }
export async function daemonRequest(op: string, args?: unknown): Promise<unknown> {
  calls.push({ op, args })
  if (state.fail) throw state.fail
  return {}
}
`)
  writeFileSync(join(root, 'config-guard.ts'),
    `export const LAN_SHARING_ARG = ${JSON.stringify(LAN_SHARING_ARG)}\n`)

  // Node builtins, so no helper binary or pkexec is ever touched.
  writeFileSync(join(dir, 'fs-stub.ts'), `
export const fsState = { helperInstalled: false }
export function existsSync(_p: string): boolean { return fsState.helperInstalled }
export function readFileSync(p: string): string { return 'CONFIG-OF:' + p }
`)
  writeFileSync(join(dir, 'cp-stub.ts'), `
export const execCalls: Array<{ cmd: string; argv: string[] }> = []
export function execFile(cmd: string, argv: string[], _o: unknown, cb: Function) {
  execCalls.push({ cmd, argv }); cb(null, { stdout: '', stderr: '' })
}
execFile.__promisify__ = undefined
`)
  // Re-export everything the test needs to drive from one entry point.
  const entry = join(dir, 'entry.ts')
  writeFileSync(entry, `
export * from './main/helper/privileged'
export { state, calls, DaemonUnreachableError } from './main/helper/daemon-client'
export { fsState } from './fs-stub'
export { execCalls } from './cp-stub'
`)

  const out = join(dir, 'bundle.cjs')
  buildSync({
    entryPoints: [entry],
    bundle: true, platform: 'node', format: 'cjs', target: 'node20',
    outfile: out, logLevel: 'silent',
    alias: { fs: join(dir, 'fs-stub.ts'), child_process: join(dir, 'cp-stub.ts') },
  })
  const mod = createRequire(import.meta.url)(out)
  H = {
    runPrivileged: mod.runPrivileged,
    canEscalatePrivileges: mod.canEscalatePrivileges,
    calls: mod.calls,
    execCalls: mod.execCalls,
    Unreachable: mod.DaemonUnreachableError,
    set: (c) => {
      if (c.daemonUp !== undefined) mod.state.daemonUp = c.daemonUp
      if (c.fail !== undefined) mod.state.fail = c.fail
      if (c.helperInstalled !== undefined) mod.fsState.helperInstalled = c.helperInstalled
    },
  }
})

function reset(daemonUp = true) {
  H.calls.length = 0
  H.execCalls.length = 0
  H.set({ daemonUp, fail: null, helperInstalled: false })
}

describe('verb to daemon op mapping', () => {
  test('the four config-carrying verbs send CONTENT, never the caller path', async () => {
    for (const [verb, op] of [['up', 'wireguard_up'], ['awg-up', 'amneziawg_up'], ['ovpn-up', 'openvpn_up']] as const) {
      reset()
      // awg-up carries an extra, deliberately ignored bindir slot.
      await H.runPrivileged(verb === 'awg-up' ? [verb, '/tmp/c.conf', '-'] : [verb, '/tmp/c.conf'])
      assert.deepEqual(H.calls, [{ op, args: { configString: 'CONFIG-OF:/tmp/c.conf' } }],
        `${verb} must send the file's content as ${op}`)
    }
  })

  test('the teardown verbs carry no payload', async () => {
    for (const [verb, op] of [
      ['down', 'wireguard_down'], ['awg-down', 'amneziawg_down'],
      ['ovpn-down', 'openvpn_down'], ['tun-down', 'tun_down'],
      ['killswitch-off', 'killswitch_off'], ['dns-restore', 'dns_restore'],
    ] as const) {
      reset()
      await H.runPrivileged([verb])
      assert.deepEqual(H.calls, [{ op, args: undefined }], `${verb} -> ${op}`)
    }
  })

  test('tun-up ignores the legacy binary slot and splits the bypass CSV', async () => {
    reset()
    await H.runPrivileged(['tun-up', '-', '127.0.0.1:1080', '1.2.3.4', '192.168.1.1', 'sntl-tun', '10.0.0.0/8,172.16.0.0/12'])
    assert.deepEqual(H.calls[0], {
      op: 'tun_up',
      args: { socksAddr: '127.0.0.1:1080', remoteHost: '1.2.3.4', gateway: '192.168.1.1', iface: 'sntl-tun', bypassRoutes: ['10.0.0.0/8', '172.16.0.0/12'] },
    })
  })

  test('tun-up with no bypass list sends an empty array, not undefined', async () => {
    reset()
    await H.runPrivileged(['tun-up', '-', '127.0.0.1:1080', '1.2.3.4', '192.168.1.1', 'sntl-tun'])
    assert.deepEqual((H.calls[0].args as { bypassRoutes: string[] }).bypassRoutes, [])
  })

  test('dns-set forwards the resolver', async () => {
    reset()
    await H.runPrivileged(['dns-set', '9.9.9.9'])
    assert.deepEqual(H.calls, [{ op: 'dns_set', args: { dnsIp: '9.9.9.9' } }])
  })

  test('an unknown verb is refused rather than passed through', async () => {
    reset()
    await assert.rejects(() => H.runPrivileged(['definitely-not-a-verb']), /unknown privileged verb/)
    assert.equal(H.calls.length, 0)
  })
})

// The LAN flag rides as a TRAILING SENTINEL because dnsIp is optional and the
// daemon isIPv4-checks it, so '' could not be passed for it positionally. Getting
// this wrong silently turns the sentinel into the dnsIp.
describe('killswitch-on sentinel handling', () => {
  test('without the sentinel, all three positionals land and lanSharing is false', async () => {
    reset()
    await H.runPrivileged(['killswitch-on', 'sntl0', '1.2.3.4', '9.9.9.9'])
    assert.deepEqual(H.calls[0].args, { iface: 'sntl0', remoteHost: '1.2.3.4', dnsIp: '9.9.9.9', lanSharing: false })
  })

  test('with the sentinel, it is stripped and never read as the dnsIp', async () => {
    reset()
    await H.runPrivileged(['killswitch-on', 'sntl0', '1.2.3.4', '9.9.9.9', LAN_SHARING_ARG])
    assert.deepEqual(H.calls[0].args, { iface: 'sntl0', remoteHost: '1.2.3.4', dnsIp: '9.9.9.9', lanSharing: true })
  })

  test('sentinel with no dnsIp leaves dnsIp undefined rather than the sentinel', async () => {
    reset()
    await H.runPrivileged(['killswitch-on', 'sntl0', '1.2.3.4', LAN_SHARING_ARG])
    assert.deepEqual(H.calls[0].args, { iface: 'sntl0', remoteHost: '1.2.3.4', dnsIp: undefined, lanSharing: true })
  })
})

// The security rule this module exists to enforce.
describe('daemon failure routing', () => {
  test('a REJECTED op propagates and is never retried under pkexec', async () => {
    reset()
    H.set({ fail: new Error('invalid config: line 3 rejected'), helperInstalled: true })
    await assert.rejects(() => H.runPrivileged(['up', '/tmp/c.conf']), /line 3 rejected/)
    assert.equal(H.execCalls.length, 0, 'a validation failure must NOT become a pkexec run')
  })

  test('an UNREACHABLE daemon falls back to the pkexec one-shot', async () => {
    reset()
    H.set({ fail: new H.Unreachable('ECONNREFUSED'), helperInstalled: true })
    await H.runPrivileged(['down'])
    assert.equal(H.execCalls.length, 1, 'a dead daemon must still reach root')
    assert.equal(H.execCalls[0].cmd, 'pkexec')
    assert.deepEqual(H.execCalls[0].argv, ['/usr/local/bin/katacomb-vpn-helper', 'down'])
  })

  test('the fallback forwards the ORIGINAL argv, not the daemon payload', async () => {
    reset()
    H.set({ fail: new H.Unreachable('EACCES'), helperInstalled: true })
    await H.runPrivileged(['killswitch-on', 'sntl0', '1.2.3.4', '9.9.9.9', LAN_SHARING_ARG])
    assert.deepEqual(H.execCalls[0].argv,
      ['/usr/local/bin/katacomb-vpn-helper', 'killswitch-on', 'sntl0', '1.2.3.4', '9.9.9.9', LAN_SHARING_ARG])
  })

  test('unreachable AND no helper installed is a readable error, not a silent no-op', async () => {
    reset()
    H.set({ fail: new H.Unreachable('ENOENT'), helperInstalled: false })
    await assert.rejects(() => H.runPrivileged(['down']), /VPN helper not installed/)
    assert.equal(H.execCalls.length, 0)
  })
})

describe('canEscalatePrivileges', () => {
  test('true when the daemon socket is there, even with no helper on disk', () => {
    reset(true)
    assert.equal(H.canEscalatePrivileges(), true)
  })

  test('true when only the helper binary is installed', () => {
    reset(false)
    H.set({ helperInstalled: true })
    assert.equal(H.canEscalatePrivileges(), true)
  })

  test('false when there is no route to root at all', () => {
    reset(false)
    H.set({ helperInstalled: false })
    assert.equal(H.canEscalatePrivileges(), false)
  })
})
