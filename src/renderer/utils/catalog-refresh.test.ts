import { test } from 'node:test'
import assert from 'node:assert/strict'
import { shouldAutoRescanCatalog, AUTO_DISCOVER_STALE_MS } from './catalog-refresh.ts'

const NOW = 1_756_000_000_000
const OLD = NOW - AUTO_DISCOVER_STALE_MS - 60_000
const FRESH = NOW - 3600_000

test('launch rescans only an EMPTY cache, never a merely old one', () => {
  // A My-plans-only user must not pay for catalog freshness at every launch;
  // an old catalog waits until the Catalog panel is actually shown.
  assert.equal(shouldAutoRescanCatalog('launch', false, null, NOW), true)
  assert.equal(shouldAutoRescanCatalog('launch', false, OLD, NOW), false)
  assert.equal(shouldAutoRescanCatalog('launch', false, FRESH, NOW), false)
})

test('catalog becoming visible rescans an empty or old cache, not a fresh one', () => {
  assert.equal(shouldAutoRescanCatalog('catalog-visible', false, null, NOW), true)
  assert.equal(shouldAutoRescanCatalog('catalog-visible', false, OLD, NOW), true)
  assert.equal(shouldAutoRescanCatalog('catalog-visible', false, FRESH, NOW), false)
})

test('never rescans while the chain half is stale (tunnel up)', () => {
  // stale means main answered from memory: a rescan would just return the
  // cache, and the Rescan button is disabled for the same reason.
  assert.equal(shouldAutoRescanCatalog('launch', true, null, NOW), false)
  assert.equal(shouldAutoRescanCatalog('catalog-visible', true, OLD, NOW), false)
})
