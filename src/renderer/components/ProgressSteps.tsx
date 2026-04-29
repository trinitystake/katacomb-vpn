interface Props {
  currentStep: string | null
  error: string | null
}

const STEPS = [
  { id: '1/5', label: 'Creating signing client' },
  { id: '2/5', label: 'Broadcasting subscription tx' },
  { id: '3/5', label: 'Extracting session ID' },
  { id: '4/5', label: 'Performing handshake' },
  { id: '5/5', label: 'Establishing tunnel' },
]

export default function ProgressSteps({ currentStep, error }: Props) {
  const currentIndex = STEPS.findIndex((s) => s.id === currentStep)

  return (
    <div className="space-y-2.5">
      {STEPS.map((step, i) => {
        let state: 'pending' | 'active' | 'done' | 'error' = 'pending'
        if (error && i === currentIndex) state = 'error'
        else if (i < currentIndex) state = 'done'
        else if (i === currentIndex) state = 'active'

        return (
          <div key={step.id} className="flex items-center gap-3 text-sm">
            <span
              className={`status-dot ${
                state === 'done' ? 'status-dot-active' :
                state === 'active' ? 'status-dot-pending' :
                state === 'error' ? 'bg-danger' :
                'bg-border'
              }`}
            />
            <span
              className={
                state === 'done' ? 'text-success' :
                state === 'active' ? 'text-warning' :
                state === 'error' ? 'text-danger' :
                'text-text-tertiary'
              }
            >
              Step {i + 1}: {step.label}
            </span>
          </div>
        )
      })}
      {error && (
        <p className="text-danger text-sm mt-2 pl-5">{error}</p>
      )}
    </div>
  )
}
