import { useState, type ReactNode } from 'react'

interface Props {
  /** What the label describes, for screen readers: "why", "more about DNS", … */
  label: string
  children: ReactNode
}

/**
 * A "?" that reveals one paragraph of explanation on hover or keyboard focus.
 *
 * Exists so the multi-hop flow can keep every consequence on screen as one short line
 * while the reasoning behind it stays one hover away. Native `title=` (what the rest of
 * the app uses for per-row detail) is wrong for that job here: it waits ~1s, is drawn by
 * the OS in its own palette, and never appears for a keyboard user.
 *
 * The panel is fixed at `right-0 top-full`, so it always opens leftward and downward.
 * That is not a style choice, it is what lets this component carry no positioning logic
 * at all: place every InfoTip at the RIGHT END of its row and inside a 672px modal the
 * panel cannot reach either edge. A tip placed mid-row would need measurement.
 */
export default function InfoTip({ label, children }: Props) {
  const [open, setOpen] = useState(false)

  return (
    // Hover lives on the WRAPPER, not the button, so moving the pointer down onto a
    // panel of text does not dismiss it. The panel is a DOM descendant, so it counts
    // as "still inside" for mouseleave; the `pt-1.5` below is what bridges the visual
    // gap, which would otherwise be a dead zone that closes the panel mid-reach.
    <span
      className="relative inline-flex shrink-0 align-middle"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        type="button"
        aria-label={label}
        aria-expanded={open}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={(e) => { if (e.key === 'Escape') setOpen(false) }}
        // Click is a no-op on purpose: hover and focus already cover both input
        // methods, and a toggle would leave panels open behind the user.
        onClick={(e) => e.preventDefault()}
        className={`w-3.5 h-3.5 rounded-full border text-[9px] leading-none flex items-center justify-center transition-colors focus:outline-none focus:border-border-focus focus:text-accent ${
          open ? 'border-accent text-accent' : 'border-current text-text-tertiary'
        }`}
      >
        ?
      </button>
      {open && (
        <span className="absolute right-0 top-full pt-1.5 w-64 z-10">
          <span
            role="tooltip"
            className="block bg-bg-tertiary border border-border rounded-md shadow-lg p-2.5 text-xs font-normal text-text-secondary text-left normal-case tracking-normal"
          >
            {children}
          </span>
        </span>
      )}
    </span>
  )
}
