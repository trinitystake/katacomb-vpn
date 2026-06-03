import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, statSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeFileAtomic } from './fs-utils.ts'

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), 'fsutil-'))
}

test('writeFileAtomic writes the content', () => {
  const p = join(freshDir(), 'a.json')
  writeFileAtomic(p, '{"x":1}')
  assert.equal(readFileSync(p, 'utf-8'), '{"x":1}')
})

test('writeFileAtomic applies 0o600 perms by default', () => {
  const p = join(freshDir(), 'a.json')
  writeFileAtomic(p, 'secret')
  assert.equal(statSync(p).mode & 0o777, 0o600)
})

test('writeFileAtomic leaves no temp file behind', () => {
  const dir = freshDir()
  writeFileAtomic(join(dir, 'a.json'), 'data')
  assert.deepEqual(readdirSync(dir), ['a.json'])
})

test('writeFileAtomic overwrites an existing file', () => {
  const p = join(freshDir(), 'a.json')
  writeFileAtomic(p, 'old')
  writeFileAtomic(p, 'new')
  assert.equal(readFileSync(p, 'utf-8'), 'new')
})
