import test from 'node:test'
import assert from 'node:assert/strict'
import { shortestAngleDelta } from './angles.ts'

test('a plain difference well inside half a turn is unchanged', () => {
  assert.equal(shortestAngleDelta(10, 40), 30)
  assert.equal(shortestAngleDelta(40, 10), -30)
})

test('it goes the short way rather than the long way round', () => {
  // 350 -> 10 is +20 forwards, not -340 backwards
  assert.equal(shortestAngleDelta(350, 10), 20)
  assert.equal(shortestAngleDelta(10, 350), -20)
})

test('whole spins cost nothing: the reported bug', () => {
  // Four full drags round the globe leave longitude at 1425 while home is -15.
  // Same orientation, so recentring must not move at all, let alone unwind
  // four spins.
  assert.equal(shortestAngleDelta(1425, -15), 0)
  assert.equal(shortestAngleDelta(-15 + 360 * 4, -15), 0)
  assert.equal(shortestAngleDelta(-15 - 360 * 3, -15), 0)
})

test('a spin plus a bit only pays for the bit', () => {
  assert.equal(shortestAngleDelta(-15 + 360 * 4 + 30, -15), -30)
})

test('the result never exceeds half a turn in either direction', () => {
  for (let from = -1000; from <= 1000; from += 7) {
    for (const to of [-15, 0, 90, 179, 180, -180]) {
      const d = shortestAngleDelta(from, to)
      assert.ok(d > -180 && d <= 180, `${from}->${to} gave ${d}`)
      // and it must actually land on the target orientation
      const landed = ((from + d - to) % 360 + 360) % 360
      assert.ok(landed < 1e-9 || Math.abs(landed - 360) < 1e-9, `${from}->${to} landed ${landed}`)
    }
  }
})

test('exactly half a turn resolves positively, never to -180', () => {
  assert.equal(shortestAngleDelta(0, 180), 180)
  assert.equal(shortestAngleDelta(0, -180), 180)
})
