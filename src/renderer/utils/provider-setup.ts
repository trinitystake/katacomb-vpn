// The provider setup path, derived from chain state on every call.
//
// This is the tab's guided flow WITHOUT a wizard: the console is a stateless
// view over chain state (see CLAUDE.md's provider design invariant), so the
// current step is computed from what the chain says, never stored. Closing the
// app half-way through changes nothing; the same state produces the same step.
//
// Import-free so the native test runner covers it.

export type SetupStepState = 'done' | 'next' | 'later' | 'unknown'

export interface SetupStep {
  key: 'register' | 'activate' | 'plan' | 'link' | 'publish'
  label: string
  /** One sentence on what the step means, shown for the step that is next. */
  detail: string
  state: SetupStepState
}

export interface SetupInput {
  registered: boolean
  /** Provider status is active. */
  active: boolean
  planCount: number
  activePlanCount: number
  leaseCount: number
  /**
   * Total nodes confirmed linked across the provider's plans, or null when the
   * counters could not be read. null must never render as "no nodes" — a failed
   * read is not evidence, so the step reports itself unknown instead.
   */
  confirmedLinkedNodes: number | null
}

/**
 * The five chain steps between a fresh wallet and a plan subscribers can use.
 * Exactly one step is `next` (the first one still to do); `unknown` marks a step
 * whose completion could not be verified and is skipped when choosing `next`.
 */
export function providerSetupSteps(input: SetupInput): SetupStep[] {
  const linkState: SetupStepState | 'pending' = !input.registered || input.planCount === 0
    ? 'pending'
    : input.confirmedLinkedNodes !== null && input.confirmedLinkedNodes > 0
      ? 'done'
      : input.leaseCount === 0
        ? 'pending' // nothing leased, so nothing can be linked: genuinely still to do
        : input.confirmedLinkedNodes === 0
          ? 'pending' // leased but confirmed unlinked
          : 'unknown' // leased, and the linked count could not be read

  const doneByKey: Record<SetupStep['key'], boolean | 'unknown'> = {
    register: input.registered,
    activate: input.registered && input.active,
    plan: input.planCount > 0,
    link: linkState === 'done' ? true : linkState === 'unknown' ? 'unknown' : false,
    publish: input.activePlanCount > 0,
  }

  const linkDetail =
    input.leaseCount === 0
      ? 'Pay a node operator by the hour to carry the plan traffic, then link the node to the plan.'
      : linkState === 'unknown'
        ? 'You lease nodes already, but the linked count could not be read just now.'
        : 'You already pay for a node. Link it to a plan so subscribers can use it.'

  const bare: Omit<SetupStep, 'state'>[] = [
    { key: 'register', label: 'Register', detail: 'Publish your provider record on chain.' },
    {
      key: 'activate',
      label: 'Activate',
      detail: 'A second transaction switches you active. The chain refuses plans and leases until then.',
    },
    {
      key: 'plan',
      label: 'Create a plan',
      detail: 'What subscribers buy: gigabytes over a period, at your price.',
    },
    { key: 'link', label: 'Lease and link a node', detail: linkDetail },
    {
      key: 'publish',
      label: 'Activate the plan',
      detail: 'Plans are created inactive. Activating lists it for subscribers.',
    },
  ]

  let nextAssigned = false
  return bare.map((step) => {
    const done = doneByKey[step.key]
    if (done === true) return { ...step, state: 'done' }
    if (done === 'unknown') return { ...step, state: 'unknown' }
    if (!nextAssigned) {
      nextAssigned = true
      return { ...step, state: 'next' }
    }
    return { ...step, state: 'later' }
  })
}

/** True when every step is confirmed done — the console hides the path then. */
export function setupComplete(steps: SetupStep[]): boolean {
  return steps.every((s) => s.state === 'done')
}
