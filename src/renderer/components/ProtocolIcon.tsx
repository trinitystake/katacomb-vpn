import type { ReactElement } from 'react'
import { protocolMeta } from '../utils/protocols'

/**
 * A 16px mark per node protocol, drawn here rather than vendored. The obvious source,
 * each project's own logo, is not ours to ship: WireGuard's trademark policy forbids
 * its logo in third-party application graphics without written permission, OpenVPN
 * Inc. has a similar policy, and the other projects' code licences say nothing about
 * their artwork. So every glyph below is an original stroke drawing that EVOKES the
 * protocol (a tunnel, a V, a padlock, an X, a masked tunnel, a bolt) in the same idiom
 * as Icons.tsx, and never a copy. If official marks are ever cleared, this is the one
 * place to swap them.
 */
const MARKS: Record<number, ReactElement> = {
  // WireGuard: a tunnel mouth, two arches.
  1: (
    <>
      <path d="M2 13.5V8a6 6 0 0 1 12 0v5.5" />
      <path d="M5.5 13.5V8a2.5 2.5 0 0 1 5 0v5.5" />
    </>
  ),
  // V2Ray: a V.
  2: <path d="M2.5 3L8 13.5 13.5 3" />,
  // OpenVPN: a padlock.
  3: (
    <>
      <rect x="3" y="7" width="10" height="7" rx="1.5" />
      <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" />
    </>
  ),
  // XRAY: an X in a ring.
  4: (
    <>
      <circle cx="8" cy="8" r="6.3" />
      <path d="M5.5 5.5l5 5M10.5 5.5l-5 5" />
    </>
  ),
  // AmneziaWG: the WireGuard tunnel with a bar across its mouth (obfuscation).
  5: (
    <>
      <path d="M2 13.5V8a6 6 0 0 1 12 0v5.5" />
      <path d="M2 10.5h12" />
    </>
  ),
  // Hysteria2: a bolt (QUIC).
  6: <path d="M9 1.5L3.5 8.5h4l-1 6L12.5 7.5h-4z" />,
}

// Unknown / unlisted: a ring with a question mark.
const UNKNOWN_MARK = (
  <>
    <circle cx="8" cy="8" r="6.3" />
    <path d="M6.3 6.4a1.7 1.7 0 1 1 2.4 1.5c-.5.3-.7.6-.7 1.1" />
    <path d="M8 11.3v.1" />
  </>
)

export default function ProtocolIcon({ type, className = 'w-4 h-4' }: { type: number; className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      <title>{protocolMeta(type).label}</title>
      {MARKS[type] ?? UNKNOWN_MARK}
    </svg>
  )
}
