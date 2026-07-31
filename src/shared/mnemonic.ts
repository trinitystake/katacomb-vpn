// BIP-39 checking for the import box, live as the user types.
//
// Three things can be wrong with a typed seed and they need different words:
// a word that isn't in the BIP-39 list (a typo), a phrase that isn't 12 or 24
// words, and a phrase whose every word is real but whose checksum doesn't add
// up (one word wrong or two swapped). Only the last one needs the crypto —
// @scure/bip39's validateMnemonic, the same package the app generates seeds
// with.
//
// Pure and Electron-free so it can be unit-tested; the renderer is the only
// caller. The normalized `phrase` is what must be imported — NFKD, lowercase,
// single-spaced — because that is the form the checksum was verified against
// and the only form CosmJS's EnglishMnemonic accepts.

import { validateMnemonic } from '@scure/bip39'
import { wordlist } from '@scure/bip39/wordlists/english'

const wordSet = new Set(wordlist)

/** Trim, collapse whitespace, lowercase. Paste-friendly; the checksum is verified on this. */
export function normalizeMnemonic(value: string): string {
  return value.normalize('NFKD').trim().toLowerCase().split(/\s+/).filter(Boolean).join(' ')
}

export type MnemonicStatus =
  | 'empty'
  /** Nothing wrong yet, just not finished — never shown as an error. */
  | 'incomplete'
  | 'invalid'
  | 'valid'

export interface MnemonicCheck {
  status: MnemonicStatus
  /** Empty only when status is 'empty'. */
  message: string
  /** The form to import. Only meaningful when status is 'valid'. */
  phrase: string
  wordCount: number
}

export function checkMnemonic(value: string): MnemonicCheck {
  const phrase = normalizeMnemonic(value)
  const words = phrase ? phrase.split(' ') : []
  const wordCount = words.length
  const base = { phrase, wordCount }

  if (wordCount === 0) return { ...base, status: 'empty', message: '' }

  // The word being typed right now isn't a typo yet — exempt it while it could
  // still grow into a real word, or every phrase would flash red on the way in.
  const last = wordCount - 1
  const pending =
    !/\s$/.test(value) && wordCount <= 24 && !wordSet.has(words[last]) && wordlist.some((w) => w.startsWith(words[last]))

  const unknown: number[] = []
  words.forEach((word, i) => {
    if (wordSet.has(word)) return
    if (pending && i === last) return
    unknown.push(i)
  })

  if (unknown.length > 0) {
    const listed = unknown.map((i) => `"${words[i]}" (word ${i + 1})`).join(', ')
    return {
      ...base,
      status: 'invalid',
      message: `Not ${unknown.length > 1 ? 'BIP-39 words' : 'a BIP-39 word'}: ${listed}`,
    }
  }

  if (wordCount > 24) {
    return { ...base, status: 'invalid', message: `Too many words — a seed phrase is 12 or 24, this is ${wordCount}` }
  }
  // A half-typed last word doesn't count towards the total yet.
  const done = pending ? wordCount - 1 : wordCount
  if (pending || (done !== 12 && done !== 24)) {
    return { ...base, status: 'incomplete', message: `${done} of ${done < 12 ? 12 : 24} words` }
  }

  if (!validateMnemonic(phrase, wordlist)) {
    return {
      ...base,
      status: 'invalid',
      message: 'Checksum does not match — a word is wrong or two are in the wrong order',
    }
  }

  return { ...base, status: 'valid', message: `Valid ${wordCount}-word seed phrase` }
}
