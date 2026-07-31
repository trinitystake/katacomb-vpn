import { memo, useId } from 'react'

/**
 * The app mark. Painted from fixed brand colors rather than theme tokens, so it
 * renders identically on any surface — a logo that recolors itself is a
 * different logo, and this one has to match the OS icons in build/icons.
 *
 * The light badge is what makes one fixed mark work on both surfaces: the "K" is
 * gunmetal, near enough to the app's own background that a bare mark would read
 * as a hollow outline. Keep this in step with build/icons/1024x1024.svg — same
 * badge, same paths, same gradient stops. Those stops are also where
 * styles/tokens.css sources its palette, so a change here is a change to the
 * whole app's colors.
 */
function AppLogo({ size = 30, className = '' }: { size?: number; className?: string }) {
  // The gradients are referenced by id, and the mark can appear more than once
  // per document (header + about dialog) — scope the ids per instance.
  const uid = useId()
  const kFill = `katacomb-k-${uid}`
  const aFill = `katacomb-a-${uid}`

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 1024 1024"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      role="img"
      aria-label="Katacomb VPN"
    >
      <defs>
        <linearGradient id={kFill} x1="124.66" y1="569.51" x2="916.18" y2="448.48" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#1e2127" />
          <stop offset=".25" stopColor="#1e2127" />
          <stop offset="1" stopColor="#202328" />
        </linearGradient>
        <linearGradient id={aFill} x1="236.89" y1="798.99" x2="646.46" y2="678.65" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#805436" />
          <stop offset=".3" stopColor="#c39874" />
          <stop offset=".38" stopColor="#e1bc99" />
          <stop offset=".48" stopColor="#ebcaa6" />
          <stop offset=".56" stopColor="#f2d5b2" />
          <stop offset=".67" stopColor="#d1b391" />
          <stop offset=".8" stopColor="#a57d5c" />
          <stop offset=".96" stopColor="#705441" />
        </linearGradient>
      </defs>
      <rect width="1024" height="1024" rx="113.25" ry="113.25" fill="#fff" />
      <path
        fill={`url(#${kFill})`}
        d="M544.86,911.94l348.09-2.88c11.7-.09,18.61-13.23,12.11-23l-250.91-389.97c-16.28-24.46-15.35-56.6,2.33-80.07l206.82-274.55c10.1-13.41.59-32.65-16.15-32.65h-215.79c-18.4,0-35.85,8.18-47.69,22.34l-172.62,206.56c-5.27,6.3-15.49,2.56-15.49-5.67v-183.56c0-21.9-17.67-39.66-39.46-39.66h-205.84c-18.66,0-33.79,15.21-33.79,33.97v742.06c0,16.86,13.67,30.48,30.44,30.35l238.55-1.96h-.04l159.46-1.29Z"
      />
      <path
        fill={`url(#${aFill})`}
        d="M385.21,907.77l39.37-163.04s-38.4-22.72-21.21-73.54c0,0,10.93-26.72,42.83-30.89l7.05-.5c40.6-1.49,54.05,31.39,54.05,31.39,17.19,50.81-21.21,73.54-21.21,73.54l57.41,167.24,133.6-1.11-141.96-364.87c-34.92-68.03-133.56-63.72-162.42,7.09l-122.76,361.23,133.53-1.07,1.72-5.47Z"
      />
    </svg>
  )
}

export default memo(AppLogo)
