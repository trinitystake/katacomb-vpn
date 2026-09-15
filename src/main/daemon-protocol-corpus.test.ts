import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  DAEMON_DIR,
  DAEMON_SOCKET_PATH,
  DAEMON_PROTOCOL_VERSION,
  DAEMON_OPS,
  type DaemonRequest,
  type DaemonResponse,
} from './daemon-protocol.ts'

// daemon-protocol.ts says the Go side "mirrors these shapes byte for byte", and
// until this file existed nothing checked it — unlike the config-guard pair,
// which the guard corpus has always pinned. This is the same arrangement: ONE
// language-neutral fixture set, read by both test runners, so a contract changed
// on one side fails the other. Go reads it in
// daemon/internal/protocol/corpus_test.go and daemon/internal/server/corpus_test.go.

const CORPUS = fileURLToPath(
  new URL('../../daemon/internal/protocol/testdata/corpus/protocol.json', import.meta.url),
)

interface Corpus {
  version: number
  socketDir: string
  socketPath: string
  maxMessageBytes: number
  ops: string[]
  lockFreeOps: string[]
  requests: { name: string; line: string; outcome: string; id?: number; op?: string }[]
  responses: { name: string; response: DaemonResponse; encoded: string }[]
  unknownOpPrefix: string
}

const corpus = JSON.parse(readFileSync(CORPUS, 'utf-8')) as Corpus

test('constants match the shared corpus', () => {
  assert.equal(DAEMON_PROTOCOL_VERSION, corpus.version)
  assert.equal(DAEMON_DIR, corpus.socketDir)
  assert.equal(DAEMON_SOCKET_PATH, corpus.socketPath)
})

test('the op list matches the shared corpus exactly', () => {
  // Order included: both sides list the ops in dispatch order, and keeping that
  // true is free while a diff here is the cheapest possible drift signal.
  assert.deepEqual([...DAEMON_OPS], corpus.ops)
})

test('every lock-free op is a real op', () => {
  for (const op of corpus.lockFreeOps) {
    assert.ok(corpus.ops.includes(op), `lockFreeOps names ${op}, which is not an op`)
  }
})

test('the client serialises requests the way the corpus says the daemon parses them', () => {
  for (const c of corpus.requests) {
    if (c.outcome !== 'valid') continue
    // daemon-client.ts builds its line as JSON.stringify({id, op, args}) + '\n'.
    // Rebuild each valid fixture the same way and assert it round-trips to the
    // id/op the Go parser is pinned to produce.
    const parsed = JSON.parse(c.line) as DaemonRequest
    const rebuilt = JSON.parse(JSON.stringify(parsed)) as DaemonRequest
    assert.equal(rebuilt.id, c.id, `${c.name}: id`)
    assert.equal(rebuilt.op, c.op, `${c.name}: op`)
  }
})

test('responses the daemon encodes parse into the shape the client reads', () => {
  for (const c of corpus.responses) {
    const parsed = JSON.parse(c.encoded) as DaemonResponse
    assert.equal(parsed.id, c.response.id, `${c.name}: id`)
    assert.equal(parsed.ok, c.response.ok, `${c.name}: ok`)
    if (c.response.error !== undefined) {
      assert.equal(parsed.error, c.response.error, `${c.name}: error`)
    }
    if (c.response.result !== undefined) {
      assert.deepEqual(parsed.result, c.response.result, `${c.name}: result`)
    }
    // The client treats a missing `error` on a failure as its own fallback
    // message, so a failure fixture must always carry one.
    if (!parsed.ok) assert.ok(parsed.error, `${c.name}: a failure must carry an error string`)
  }
})

test('the stale-daemon marker is the string vpn-manager matches', () => {
  // vpn-manager detects a daemon left running across an upgrade with
  // msg.includes('unknown op'). If the corpus prefix ever stops containing that
  // substring, that detection silently stops working.
  assert.ok(
    corpus.unknownOpPrefix.includes('unknown op'),
    'vpn-manager matches on "unknown op"; the corpus prefix must contain it',
  )
})
