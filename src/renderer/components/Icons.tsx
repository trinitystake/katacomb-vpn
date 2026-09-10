// The renderer's icon set: hand-drawn 16x16 strokes, one function per glyph, in the
// same idiom the older inline SVGs use (DisconnectButton, IpDisplay). They exist
// because Unicode glyphs are not portable across the app's targets: the obvious
// "duplicate" glyph (U+29C9) is absent from DejaVu Sans, so it rendered as a box on a
// minimal Debian install. An SVG path looks the same everywhere. Ship only icons with
// a caller; a dead export drifts and gets imported by mistake.

import type { ReactNode } from 'react'

interface IconProps {
  className?: string
}

function Svg({ className = 'w-4 h-4', children }: IconProps & { children: ReactNode }) {
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
      {children}
    </svg>
  )
}

export function SearchIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <circle cx="7" cy="7" r="4.5" />
      <path d="M10.5 10.5L14 14" />
    </Svg>
  )
}

export function RefreshIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M1.5 2v4.5H6" />
      <path d="M3.5 10.5a5.5 5.5 0 1 0 .6-6.6L1.5 6.5" />
    </Svg>
  )
}

export function StarIcon({ filled = false, ...p }: IconProps & { filled?: boolean }) {
  return (
    <Svg {...p}>
      <path
        d="M8 1.8l1.9 3.9 4.3.6-3.1 3 .7 4.3L8 11.6l-3.8 2 .7-4.3-3.1-3 4.3-.6z"
        fill={filled ? 'currentColor' : 'none'}
      />
    </Svg>
  )
}

export function CopyIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <rect x="5.5" y="5.5" width="8.5" height="8.5" rx="1.5" />
      <path d="M10.5 5.5V3.5A1.5 1.5 0 0 0 9 2H3.5A1.5 1.5 0 0 0 2 3.5V9a1.5 1.5 0 0 0 1.5 1.5h2" />
    </Svg>
  )
}

export function CheckIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M3 8.5l3.2 3.2L13 4.5" />
    </Svg>
  )
}

export function ActivityIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M1.5 8h3l2-5 3 10 2-5h3" />
    </Svg>
  )
}

export function PowerIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M8 1.8v6" />
      <path d="M4.7 4.2a4.5 4.5 0 1 0 6.6 0" />
    </Svg>
  )
}

export function HeartIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M8 13.6S2 9.9 2 5.9a3 3 0 0 1 6-1.2 3 3 0 0 1 6 1.2c0 4-6 7.7-6 7.7z" />
    </Svg>
  )
}

export function HomeIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M2.5 7.5L8 2.5l5.5 5v6H10v-4H6v4H2.5z" />
    </Svg>
  )
}

export function ShieldIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M3 3.2L8 1.8l5 1.4v4.3c0 3.3-2.2 5.6-5 6.7-2.8-1.1-5-3.4-5-6.7z" />
      <path d="M6 8l1.5 1.5L10.5 6.5" />
    </Svg>
  )
}

export function LayersIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M8 2.5l6 3-6 3-6-3z" />
      <path d="M2 9l6 3 6-3" />
    </Svg>
  )
}

export function CloseIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M4 4l8 8M12 4l-8 8" />
    </Svg>
  )
}

export function ChevronIcon({ direction, ...p }: IconProps & { direction: 'up' | 'down' }) {
  return (
    <Svg {...p}>
      <path d={direction === 'up' ? 'M4 10l4-4 4 4' : 'M4 6l4 4 4-4'} />
    </Svg>
  )
}
