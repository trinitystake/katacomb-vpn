/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/renderer/**/*.{html,tsx,ts}'],
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
