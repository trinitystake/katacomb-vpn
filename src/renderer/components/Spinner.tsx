interface Props {
  size?: 'sm' | 'md'
  className?: string
}

export default function Spinner({ size = 'sm', className = '' }: Props) {
  const dim = size === 'sm' ? 'w-3 h-3' : 'w-4 h-4'
  return (
    <svg
      className={`animate-spin ${dim} ${className}`}
      viewBox="0 0 16 16"
      fill="none"
    >
      <circle
        cx="8" cy="8" r="6.5"
        stroke="currentColor"
        strokeOpacity="0.25"
        strokeWidth="2.5"
      />
      <path
        d="M14.5 8a6.5 6.5 0 0 0-6.5-6.5"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
      />
    </svg>
  )
}
