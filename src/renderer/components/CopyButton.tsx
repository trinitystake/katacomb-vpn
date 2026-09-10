import { useEffect, useState, type MouseEvent } from 'react'
import { CopyIcon, CheckIcon } from './Icons'

interface Props {
  value: string
  /** Tooltip and accessible name: "Copy address", "Copy endpoint". */
  label?: string
  className?: string
}

/**
 * Icon button that puts `value` on the clipboard and turns into a green check for a
 * moment. The confirmation is the icon alone, on purpose: a "Copied" label next to it
 * widened the button, and in the modal that reflowed the address it sits beside (the
 * last character dropped to a new line for the 1.5 s). The reset runs in an effect
 * with cleanup rather than a bare setTimeout, because the first caller lives inside a
 * virtualized row that can unmount while the timer is pending. Click propagation is
 * stopped for the same reason: the row around it opens a modal.
 */
export default function CopyButton({ value, label = 'Copy', className = '' }: Props) {
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(timer)
  }, [copied])

  function handleClick(e: MouseEvent<HTMLButtonElement>) {
    e.stopPropagation()
    navigator.clipboard.writeText(value).then(() => setCopied(true)).catch(() => {})
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      title={copied ? 'Copied' : label}
      aria-label={label}
      className={`inline-flex items-center shrink-0 transition-colors ${
        copied ? 'text-success' : 'text-text-tertiary hover:text-accent'
      } ${className}`}
    >
      {copied ? <CheckIcon className="w-3.5 h-3.5" /> : <CopyIcon className="w-3.5 h-3.5" />}
    </button>
  )
}
