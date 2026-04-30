// Heuristics for identifying non-production / test plans by provider name.
// `\btest` (start-only boundary) catches "TEST100", "TestOp", "Meile Test",
// "testnet" — but not "Latest" or "Contest". Privacy is handled separately
// by the Public-only filter.
const TEST_NAME_PATTERNS: RegExp[] = [
  /\btest/i,
  /\bstaging\b/i,
  /do\s*not\s*use/i,
  /\bdemo\b/i,
]

export function isTestPlan(providerName?: string | null): boolean {
  if (!providerName) return false
  return TEST_NAME_PATTERNS.some((re) => re.test(providerName))
}
