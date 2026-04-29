import { useTheme, type Theme } from '../hooks/useTheme'

const options: { value: Theme; label: string; icon: JSX.Element }[] = [
  {
    value: 'light',
    label: 'Light',
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="5" />
        <line x1="12" y1="1" x2="12" y2="3" />
        <line x1="12" y1="21" x2="12" y2="23" />
        <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
        <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
        <line x1="1" y1="12" x2="3" y2="12" />
        <line x1="21" y1="12" x2="23" y2="12" />
        <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
        <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
      </svg>
    ),
  },
  {
    value: 'system',
    label: 'System',
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
        <line x1="8" y1="21" x2="16" y2="21" />
        <line x1="12" y1="17" x2="12" y2="21" />
      </svg>
    ),
  },
  {
    value: 'dark',
    label: 'Dark',
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
      </svg>
    ),
  },
]

export default function ThemeToggle() {
  const { theme, setTheme } = useTheme()

  return (
    <div className="flex items-center bg-bg-tertiary rounded-full p-0.5" role="radiogroup" aria-label="Theme">
      {options.map((opt) => (
        <button
          key={opt.value}
          role="radio"
          aria-checked={theme === opt.value}
          aria-label={opt.label}
          title={opt.label}
          onClick={() => setTheme(opt.value)}
          className={`p-1.5 rounded-full transition-colors ${
            theme === opt.value
              ? 'bg-bg-secondary text-accent shadow-sm'
              : 'text-text-tertiary hover:text-text-secondary'
          }`}
        >
          {opt.icon}
        </button>
      ))}
    </div>
  )
}
