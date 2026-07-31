/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/renderer/**/*.{html,tsx,ts}'],
  // The app is dark-only and nothing ever sets a `.dark` class, so this makes the
  // `dark:` variant permanently unreachable. Keep it — deleting the line falls back
  // to Tailwind's `media` default, which would let a stray `dark:` utility follow the
  // OS preference and reintroduce a light/dark split.
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        'bg-primary':   'var(--color-bg-primary)',
        'bg-secondary': 'var(--color-bg-secondary)',
        'bg-tertiary':  'var(--color-bg-tertiary)',
        'bg-hover':     'var(--color-bg-hover)',
        'text-primary':   'var(--color-text-primary)',
        'text-secondary': 'var(--color-text-secondary)',
        'text-tertiary':  'var(--color-text-tertiary)',
        // For labels sitting ON a filled accent/status swatch. The palette's
        // accent and status colours are all light, so `text-white` on them is
        // unreadable — use this instead.
        'text-on-accent': 'var(--color-text-on-accent)',
        'border':       'var(--color-border)',
        'border-focus': 'var(--color-border-focus)',
        accent: {
          DEFAULT: 'var(--color-accent)',
          hover:   'var(--color-accent-hover)',
          subtle:  'var(--color-accent-subtle)',
        },
        success: {
          DEFAULT: 'var(--color-success)',
          subtle:  'var(--color-success-subtle)',
        },
        danger: {
          DEFAULT: 'var(--color-danger)',
          subtle:  'var(--color-danger-subtle)',
        },
        warning: {
          DEFAULT: 'var(--color-warning)',
          subtle:  'var(--color-warning-subtle)',
        },
        info: {
          DEFAULT: 'var(--color-info)',
          subtle:  'var(--color-info-subtle)',
        },
      },
      fontFamily: {
        sans: ['var(--font-sans)'],
        mono: ['var(--font-mono)'],
      },
      borderRadius: {
        sm:  'var(--radius-sm)',
        md:  'var(--radius-md)',
        lg:  'var(--radius-lg)',
        full: 'var(--radius-full)',
      },
      boxShadow: {
        sm:      'var(--shadow-sm)',
        md:      'var(--shadow-md)',
        lg:      'var(--shadow-lg)',
        overlay: 'var(--shadow-overlay)',
      },
    },
  },
  plugins: [],
}
