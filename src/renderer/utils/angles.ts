/**
 * Shortest signed rotation from one bearing to another, in degrees, always
 * within (-180, 180].
 *
 * The globe's longitude accumulates while the user drags, so after four spins
 * it holds 1425 rather than -15. Those are the same ORIENTATION, and animating
 * the raw difference makes the recenter button unwind every spin the user made.
 * Working mod 360 makes it take the short way round, and makes a whole number
 * of spins cost nothing at all.
 *
 * Pure, so it is unit-tested under the native runner.
 */
export function shortestAngleDelta(from: number, to: number): number {
  let d = (to - from) % 360
  if (d > 180) d -= 360
  if (d <= -180) d += 360
  // An exact whole number of turns leaves JS's modulo at -0, which animates
  // identically but is not `0` to Object.is, so it fails an equality check for
  // no reason. Hand back a plain zero.
  return d === 0 ? 0 : d
}
