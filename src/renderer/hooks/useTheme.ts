import { useState, useEffect, useCallback } from 'react'

export type Theme = 'light' | 'dark' | 'system'
export type ResolvedTheme = 'light' | 'dark'

function getSystemTheme(): ResolvedTheme {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

function applyTheme(resolved: ResolvedTheme) {
  const el = document.documentElement
  el.classList.add('transitioning')
  el.classList.toggle('dark', resolved === 'dark')
  // Remove transitioning class after animation completes
  setTimeout(() => el.classList.remove('transitioning'), 220)
}

export function useTheme() {
  const [theme, setThemeState] = useState<Theme>(() => {
    return (localStorage.getItem('theme') as Theme) || 'system'
  })

  const resolved: ResolvedTheme = theme === 'system' ? getSystemTheme() : theme

  const setTheme = useCallback((next: Theme) => {
    localStorage.setItem('theme', next)
    setThemeState(next)
  }, [])

  useEffect(() => {
    applyTheme(resolved)
  }, [resolved])

  // Listen for system theme changes when in 'system' mode
  useEffect(() => {
    if (theme !== 'system') return
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const handler = () => applyTheme(getSystemTheme())
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [theme])

  return { theme, resolved, setTheme }
}
