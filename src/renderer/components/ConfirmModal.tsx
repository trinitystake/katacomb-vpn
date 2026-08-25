import { useCallback, useState } from 'react'

export interface ConfirmOptions {
  /** The question, e.g. "End session #42?". */
  title: string
  /** Body paragraphs, rendered in order. */
  body: string[]
  /** Label for the confirming button, e.g. "End session". */
  confirmLabel: string
  /** Style the confirming button as destructive. */
  danger?: boolean
}

interface PendingConfirm extends ConfirmOptions {
  resolve: (confirmed: boolean) => void
}

/**
 * In-app replacement for window.confirm(). The native dialog is a bare OS window
 * that ignores the app's styling and freezes the renderer while open; this asks
 * the same question in a themed modal and resolves a promise instead, so call
 * sites keep their `if (!(await requestConfirm(...))) return` shape.
 *
 * Render `confirmDialog` inside the calling component; the fixed overlay blocks
 * the rest of the UI while the question is open, like the native dialog did.
 */
export function useConfirm() {
  const [pending, setPending] = useState<PendingConfirm | null>(null)

  const requestConfirm = useCallback(
    (options: ConfirmOptions) =>
      new Promise<boolean>((resolve) => setPending({ ...options, resolve })),
    [],
  )

  const settle = (confirmed: boolean) => {
    pending?.resolve(confirmed)
    setPending(null)
  }

  // Clicks must not escape the overlay: some callers render inside clickable
  // rows (PlanRow's onSelect) or inside another modal whose own overlay closes
  // on click, and a bubbled click would trigger those underneath the question.
  const confirmDialog = pending ? (
    <div
      className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 px-6"
      onClick={(e) => { e.stopPropagation(); settle(false) }}
    >
      <div
        className="bg-bg-secondary border border-border rounded-lg w-full max-w-md p-5 space-y-3 shadow-overlay"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-text-primary text-sm font-semibold">{pending.title}</h3>
        {pending.body.map((paragraph, i) => (
          <p key={i} className="text-text-secondary text-sm">{paragraph}</p>
        ))}
        <div className="flex gap-2 pt-1">
          <button type="button" onClick={() => settle(false)} className="btn btn-secondary text-xs py-2 flex-1">
            Cancel
          </button>
          <button
            type="button"
            onClick={() => settle(true)}
            className={`btn text-xs py-2 flex-1 ${pending.danger ? 'btn-danger' : 'btn-primary'}`}
          >
            {pending.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  ) : null

  return { requestConfirm, confirmDialog }
}
