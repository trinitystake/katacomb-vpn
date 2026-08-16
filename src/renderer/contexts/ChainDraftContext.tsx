import { createContext, useCallback, useContext, useMemo, useState, ReactNode } from 'react'
import type { SentNode } from '../types'
import { useChainEligibility } from '../hooks/useChainEligibility'
import type { BillingType, ChainRole } from '../utils/chain-node'

interface ChainDraftValue {
  entry: SentNode | null
  exit: SentNode | null
  /** Which hop a click in the table fills. */
  activeSlot: ChainRole
  setActiveSlot: (role: ChainRole) => void
  /** Fill a hop, or empty it with null. Moves the active slot to whatever is next. */
  setSlot: (role: ChainRole, node: SentNode | null) => void
  billing: BillingType
  setBilling: (t: BillingType) => void
  amount: number
  setAmount: (n: number) => void
  clear: () => void
  eligibility: ReturnType<typeof useChainEligibility>
}

const ChainDraftContext = createContext<ChainDraftValue | null>(null)

/**
 * The half-built chain: which two nodes are picked, what they would be bought with,
 * and how every candidate graded.
 *
 * It lives above the tab rather than inside the page for two reasons. The grades are
 * hundreds of HTTPS requests to node operators, so coming back to the tab must show
 * what was already learned instead of a screen of "checking…" and a second sweep; and
 * the draft and its grades then expire together, since a grade is only meaningful for
 * the nodes still on offer. `clear()` runs once the draft has become a pair of
 * sessions: it is spent at that point, and leaving it would re-offer nodes the user
 * has already bought.
 */
export function ChainDraftProvider({ children }: { children: ReactNode }) {
  const [entry, setEntry] = useState<SentNode | null>(null)
  const [exit, setExit] = useState<SentNode | null>(null)
  const [activeSlot, setActiveSlot] = useState<ChainRole>('entry')
  const [billing, setBilling] = useState<BillingType>('gigabytes')
  const [amount, setAmount] = useState(1)
  const eligibility = useChainEligibility()

  const setSlot = useCallback((role: ChainRole, node: SentNode | null) => {
    const setThis = role === 'entry' ? setEntry : setExit
    const other = role === 'entry' ? 'exit' : 'entry'
    setThis(node)
    if (node === null) {
      // Emptying a slot is how you say "pick this one again".
      setActiveSlot(role)
      return
    }
    // Advance, but only onto a slot that still needs a node. Replacing one half of a
    // finished pair must leave the rail where the user is looking.
    const otherNode = role === 'entry' ? exit : entry
    if (otherNode === null) setActiveSlot(other)
  }, [entry, exit])

  const clear = useCallback(() => {
    setEntry(null)
    setExit(null)
    setActiveSlot('entry')
  }, [])

  const value = useMemo(
    () => ({
      entry, exit, activeSlot, setActiveSlot, setSlot,
      billing, setBilling, amount, setAmount, clear, eligibility,
    }),
    [entry, exit, activeSlot, setSlot, billing, amount, clear, eligibility],
  )

  return <ChainDraftContext.Provider value={value}>{children}</ChainDraftContext.Provider>
}

export function useChainDraft(): ChainDraftValue {
  const ctx = useContext(ChainDraftContext)
  if (!ctx) {
    throw new Error('useChainDraft must be used within a ChainDraftProvider')
  }
  return ctx
}
