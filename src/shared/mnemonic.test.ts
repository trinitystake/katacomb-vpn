import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkMnemonic, normalizeMnemonic } from './mnemonic.ts'

// The canonical all-zero-entropy BIP-39 vectors: every word but the last is
// "abandon", and the last word IS the checksum.
const VALID_12 = `${'abandon '.repeat(11)}about`
const VALID_24 = `${'abandon '.repeat(23)}art`
// A phrase whose words actually differ, so swapping two of them changes it.
const VARIED_12 = 'abandon math mimic master filter design carbon crystal rookie group knife young'

test('a valid 12-word phrase passes', () => {
  const check = checkMnemonic(VALID_12)
  assert.equal(check.status, 'valid')
  assert.equal(check.wordCount, 12)
  assert.equal(check.phrase, VALID_12.trim())
})

test('a valid 24-word phrase passes', () => {
  assert.equal(checkMnemonic(VALID_24).status, 'valid')
})

test('every word real but the checksum wrong is rejected', () => {
  // "abandon" in place of the checksum word — 1 in 16 chance of passing by luck,
  // and this one doesn't.
  const check = checkMnemonic(`${'abandon '.repeat(11)}abandon`)
  assert.equal(check.status, 'invalid')
  assert.match(check.message, /Checksum/)
})

test('two words swapped is caught by the checksum', () => {
  const words = VARIED_12.split(' ')
  ;[words[0], words[1]] = [words[1], words[0]]
  const check = checkMnemonic(words.join(' '))
  assert.equal(check.status, 'invalid')
  assert.match(check.message, /Checksum/)
})

test('a misspelled word is named with its position', () => {
  const words = VALID_12.trim().split(' ')
  words[2] = 'abandonn'
  const check = checkMnemonic(words.join(' '))
  assert.equal(check.status, 'invalid')
  assert.equal(check.message, 'Not a BIP-39 word: "abandonn" (word 3)')
})

test('several misspelled words are all named', () => {
  const check = checkMnemonic(`zzz ${'abandon '.repeat(10)}qqq`)
  assert.equal(check.status, 'invalid')
  assert.equal(check.message, 'Not BIP-39 words: "zzz" (word 1), "qqq" (word 12)')
})

test('a short phrase is incomplete, not an error', () => {
  const check = checkMnemonic('abandon abandon abandon ')
  assert.equal(check.status, 'incomplete')
  assert.equal(check.message, '3 of 12 words')
})

test('between 12 and 24 words counts towards 24', () => {
  const check = checkMnemonic(`${'abandon '.repeat(13)}`)
  assert.equal(check.status, 'incomplete')
  assert.equal(check.message, '13 of 24 words')
})

test('more than 24 words is rejected outright', () => {
  const check = checkMnemonic('abandon '.repeat(25))
  assert.equal(check.status, 'invalid')
  assert.match(check.message, /Too many words/)
})

test('the word being typed is not called a typo yet', () => {
  // No trailing space: "aban" could still become "abandon".
  const check = checkMnemonic('abandon aban')
  assert.equal(check.status, 'incomplete')
  assert.equal(check.message, '1 of 12 words')
})

test('a half-typed last word does not trigger the checksum', () => {
  const check = checkMnemonic(`${'abandon '.repeat(11)}abou`)
  assert.equal(check.status, 'incomplete')
  assert.equal(check.message, '11 of 12 words')
})

test('a typed word that can never become real is still flagged', () => {
  const check = checkMnemonic('abandon zzzz')
  assert.equal(check.status, 'invalid')
  assert.match(check.message, /"zzzz" \(word 2\)/)
})

test('empty input says nothing', () => {
  assert.deepEqual(checkMnemonic('   '), { status: 'empty', message: '', phrase: '', wordCount: 0 })
})

test('capitals, newlines and double spaces are normalized away', () => {
  const messy = `  ABANDON\n abandon\tabandon  ${'abandon '.repeat(8)}About  `
  const check = checkMnemonic(messy)
  assert.equal(check.status, 'valid')
  assert.equal(check.phrase, VALID_12.trim())
})

test('normalizeMnemonic is what gets imported', () => {
  assert.equal(normalizeMnemonic('  Foo   BAR\nbaz '), 'foo bar baz')
})
