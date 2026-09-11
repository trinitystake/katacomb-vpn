/**
 * Seed membership for stored wallets.
 *
 * Every wallet entry keeps its own encrypted copy of its seed phrase and nothing
 * on disk says which entries share one, so membership is computed by decrypting
 * and comparing (main side, `assignSeedGroups`) and then read back into display
 * groups (renderer side, `groupWalletsBySeed`). Import-free so both sides can
 * use it and the native test runner can load it.
 */

export interface SeedGrouped {
  /** False when the seed cannot be decrypted (saved under the app's previous name). */
  unlockable: boolean
  /**
   * Id of the FIRST stored wallet, in index order, holding the same phrase.
   * Stable within one store read and never persisted. Null when the seed cannot
   * be decrypted, so its membership is unknown.
   */
  seedGroup: string | null
}

function normalizedPhrase(readMnemonic: (id: string) => string, id: string): string | null {
  try {
    return readMnemonic(id).trim().split(/\s+/).join(' ')
  } catch {
    return null
  }
}

/**
 * Main side. `readMnemonic` returns a wallet's phrase and throws when it cannot
 * be decrypted. Phrases are compared trimmed and single-spaced: every writer
 * stores the wallet's own normalized `mnemonic`, but an entry migrated from the
 * old single-wallet file holds whatever was typed. The result carries no key
 * material, so it can cross IPC as-is.
 */
export function assignSeedGroups<T extends { id: string }>(
  entries: T[],
  readMnemonic: (id: string) => string,
): (T & SeedGrouped)[] {
  const firstIdByPhrase = new Map<string, string>()
  return entries.map((entry) => {
    const phrase = normalizedPhrase(readMnemonic, entry.id)
    if (phrase === null) return { ...entry, unlockable: false, seedGroup: null }
    const seedGroup = firstIdByPhrase.get(phrase) ?? entry.id
    firstIdByPhrase.set(phrase, seedGroup)
    return { ...entry, unlockable: true, seedGroup }
  })
}

export interface SeedGroup<T> {
  /** The `seedGroup` its members share. */
  key: string
  /** "Seed 1", "Seed 2", in order of first appearance. */
  label: string
  members: T[]
}

/**
 * Renderer side. Groups in order of first appearance, numbered from 1. Wallets
 * whose seed cannot be decrypted go to `locked` (index order) and take no number.
 */
export function groupWalletsBySeed<T extends { seedGroup: string | null }>(
  wallets: T[],
): { groups: SeedGroup<T>[]; locked: T[] } {
  const groups: SeedGroup<T>[] = []
  const locked: T[] = []
  for (const wallet of wallets) {
    if (wallet.seedGroup === null) {
      locked.push(wallet)
      continue
    }
    const group = groups.find((g) => g.key === wallet.seedGroup)
    if (group) group.members.push(wallet)
    else groups.push({ key: wallet.seedGroup, label: `Seed ${groups.length + 1}`, members: [wallet] })
  }
  return { groups, locked }
}
