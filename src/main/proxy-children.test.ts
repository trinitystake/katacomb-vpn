import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, existsSync, writeFileSync, readlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  parseProxyChildRecords,
  readProxyChildRecords,
  writeProxyChildRecords,
  isRecordedProxyChild,
  isPidAlive,
  trackProxyChildIn,
  reapOrphanedProxyChildrenIn,
  type ProxyChildRecord,
} from './proxy-children.ts'

const dir = mkdtempSync(join(tmpdir(), 'proxy-children-test-'))
const statePath = (name: string): string => join(dir, `${name}.json`)

/**
 * A stand-in for a proxy core: a real process that stays alive and carries the
 * config path as a whole argv entry, which is what the identity check reads.
 *
 * Deliberately NOT `env sleep 300 <path>`: env EXECs sleep, so /proc/<pid>/exe
 * changes a moment after spawn and any record built from a hardcoded exe passes or
 * fails depending on which side of the exec it lands. A shell running a script AT
 * the config path keeps both halves stable for the life of the process.
 */
function spawnFakeCore(configFile: string, opts?: { ignoreTerm?: boolean }): ReturnType<typeof spawn> {
  writeFileSync(
    configFile,
    `${opts?.ignoreTerm ? 'trap "" TERM\n' : ''}while true; do sleep 0.05; done\n`,
  )
  return spawn('/bin/sh', [configFile], { stdio: 'ignore' })
}

/** Build the record a real run would have written, reading back the exe actually
 *  running: /bin/sh is dash on Debian and bash elsewhere. */
function recordFor(pid: number, configFile: string): ProxyChildRecord {
  return { pid, exe: readlinkSync(`/proc/${pid}/exe`), configFile }
}

async function until(pred: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms
  while (!pred() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20))
}

test('parseProxyChildRecords keeps well-formed entries', () => {
  const raw = JSON.stringify([{ pid: 42, exe: '/usr/bin/xray', configFile: '/tmp/x/v2ray.json' }])
  assert.deepEqual(parseProxyChildRecords(raw), [
    { pid: 42, exe: '/usr/bin/xray', configFile: '/tmp/x/v2ray.json' },
  ])
})

test('parseProxyChildRecords rejects anything that could aim a signal wrongly', () => {
  // pid must be a real, integral, non-special pid: a string, a float, 0, 1 and a
  // negative (which would signal a whole process GROUP) are all refused.
  for (const pid of ['42', 42.5, 0, 1, -1, null, undefined, NaN]) {
    const raw = JSON.stringify([{ pid, exe: '/usr/bin/xray', configFile: '/tmp/x.json' }])
    assert.deepEqual(parseProxyChildRecords(raw), [], `pid ${String(pid)} should be rejected`)
  }
  // Missing or empty identity fields leave nothing to verify against.
  assert.deepEqual(parseProxyChildRecords(JSON.stringify([{ pid: 42, configFile: '/tmp/x.json' }])), [])
  assert.deepEqual(parseProxyChildRecords(JSON.stringify([{ pid: 42, exe: '', configFile: '/tmp/x.json' }])), [])
  assert.deepEqual(parseProxyChildRecords(JSON.stringify([{ pid: 42, exe: '/usr/bin/xray', configFile: '' }])), [])
})

test('parseProxyChildRecords survives a truncated or non-array file', () => {
  assert.deepEqual(parseProxyChildRecords('[{"pid":42,'), [])
  assert.deepEqual(parseProxyChildRecords(''), [])
  assert.deepEqual(parseProxyChildRecords('{"pid":42}'), [])
  assert.deepEqual(parseProxyChildRecords('null'), [])
})

test('writeProxyChildRecords removes the file rather than leaving an empty list', () => {
  const p = statePath('empty')
  writeProxyChildRecords(p, [{ pid: 42, exe: '/x', configFile: '/y' }])
  assert.ok(existsSync(p))
  writeProxyChildRecords(p, [])
  assert.equal(existsSync(p), false)
  assert.deepEqual(readProxyChildRecords(p), [])
})

test('a tracked child is recorded, then untracked when it exits', async () => {
  const p = statePath('lifecycle')
  const cfg = join(dir, 'lifecycle-v2ray.json')
  const child = spawnFakeCore(cfg)
  await until(() => readProxyChildRecords(p).length > 0 || !!child.pid)
  trackProxyChildIn(p, child, cfg)

  const recorded = readProxyChildRecords(p)
  assert.equal(recorded.length, 1)
  assert.equal(recorded[0].pid, child.pid)

  child.kill('SIGKILL')
  await until(() => readProxyChildRecords(p).length === 0)
  assert.deepEqual(readProxyChildRecords(p), [], 'exit handler should clear the record')
})

test('isRecordedProxyChild accepts a live match and refuses a reused pid', async () => {
  const cfg = join(dir, 'identity-v2ray.json')
  const child = spawnFakeCore(cfg)
  await until(() => isPidAlive(child.pid!))
  const rec = recordFor(child.pid!, cfg)

  assert.equal(isRecordedProxyChild(rec), true, 'exe and configFile both match')

  // The pid-reuse case: same live process, but the record describes a different
  // config. This is the check that stops us killing a stranger's process.
  assert.equal(isRecordedProxyChild({ ...rec, configFile: '/tmp/someone-elses.json' }), false)
  // And a record whose binary does not match what is actually running.
  assert.equal(isRecordedProxyChild({ ...rec, exe: '/usr/bin/definitely-not-this' }), false)

  child.kill('SIGKILL')
  await until(() => !isPidAlive(child.pid!))
  assert.equal(isRecordedProxyChild(rec), false, 'a dead pid is never ours to kill')
})

test('reap kills a core that outlived its run, and clears the file', async () => {
  const p = statePath('reap')
  const cfg = join(dir, 'reap-v2ray.json')
  const child = spawnFakeCore(cfg)
  await until(() => isPidAlive(child.pid!))
  const pid = child.pid!

  // Simulate a crashed run: the record is on disk with no exit handler to clear it.
  writeProxyChildRecords(p, [recordFor(pid, cfg)])

  assert.equal(await reapOrphanedProxyChildrenIn(p), true)
  await until(() => !isPidAlive(pid))
  assert.equal(isPidAlive(pid), false, 'the orphaned core should be gone')
  assert.equal(existsSync(p), false, 'the spent record should be cleared')
})

test('reap leaves a process it cannot positively identify alone', async () => {
  const p = statePath('stranger')
  const cfg = join(dir, 'stranger-v2ray.json')
  const child = spawnFakeCore(cfg)
  await until(() => isPidAlive(child.pid!))
  const pid = child.pid!

  // Same pid, but the record claims a config this process does not carry: exactly
  // what a reused pid looks like.
  writeProxyChildRecords(p, [{ ...recordFor(pid, cfg), configFile: '/tmp/not-ours.json' }])

  assert.equal(await reapOrphanedProxyChildrenIn(p), false, 'nothing was ours, so nothing was killed')
  assert.equal(isPidAlive(pid), true, 'an unverified process must survive')
  assert.equal(existsSync(p), false, 'the spent record is dropped either way')

  child.kill('SIGKILL')
})

test('reap is a no-op with no state file', async () => {
  assert.equal(await reapOrphanedProxyChildrenIn(statePath('absent')), false)
})

test('reap escalates to SIGKILL for a core that ignores SIGTERM', async () => {
  const p = statePath('stubborn')
  const cfg = join(dir, 'stubborn.sh')
  // Traps SIGTERM and keeps running, standing in for a wedged core.
  const child = spawnFakeCore(cfg, { ignoreTerm: true })
  await until(() => isPidAlive(child.pid!))
  const pid = child.pid!
  writeProxyChildRecords(p, [recordFor(pid, cfg)])

  const started = Date.now()
  assert.equal(await reapOrphanedProxyChildrenIn(p, 300), true)
  await until(() => !isPidAlive(pid))
  assert.equal(isPidAlive(pid), false, 'SIGKILL should finish what SIGTERM could not')
  // Bounded: the grace period is respected rather than waited out indefinitely.
  assert.ok(Date.now() - started < 3000, 'reap must not stall startup')
})
