// Heuristics for identifying non-production / test plans.
// `\btest` (start-only boundary) catches "TEST100", "TestOp", "Meile Test",
// "testnet" — but not "Latest" or "Contest".
const TEST_NAME_PATTERNS: RegExp[] = [
  /\btest/i,
  /\bstaging\b/i,
  /do\s*not\s*use/i,
  /\bdemo\b/i,
]

export function isTestPlan(planPrivate: boolean, providerName?: string | null): boolean {
  if (planPrivate) return true
  if (!providerName) return false
  return TEST_NAME_PATTERNS.some((re) => re.test(providerName))
}
