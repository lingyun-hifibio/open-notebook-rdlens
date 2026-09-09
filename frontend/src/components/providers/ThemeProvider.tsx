'use client'

import { useEffect } from 'react'
import { useThemeStore } from '@/lib/stores/theme-store'

interface ThemeProviderProps {
  children: React.ReactNode
}

export function ThemeProvider({ children }: ThemeProviderProps) {
  const theme = useThemeStore((state) => state.theme)
  // RWV2-50（RDLens #363）：订阅嵌入式 override，变化时重应用 DOM；
  // 独立（standalone）路径 embeddedTheme 恒为 null，行为不变。
  const embeddedTheme = useThemeStore((state) => state.embeddedTheme)
  const getEffectiveTheme = useThemeStore((state) => state.getEffectiveTheme)

  useEffect(() => {
    // Apply the effective theme (embedded override takes priority over the
    // standalone preference, including the system fallback).
    const root = window.document.documentElement
    const effectiveTheme = getEffectiveTheme()

    // Remove all possible theme classes first
    root.classList.remove('light', 'dark')

    // Add the effective theme class
    root.classList.add(effectiveTheme)

    // Set the data attribute as well for better component compatibility
    root.setAttribute('data-theme', effectiveTheme)

    // Listen for system theme changes when using system preference
    if (theme === 'system') {
      const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)')

      const handleChange = () => {
        // 以 getEffectiveTheme 为准：嵌入 override 存续时不被 OS 换肤覆盖
        const newSystemTheme = getEffectiveTheme()
        root.classList.remove('light', 'dark')
        root.classList.add(newSystemTheme)
        root.setAttribute('data-theme', newSystemTheme)
      }

      mediaQuery.addEventListener('change', handleChange)
      return () => mediaQuery.removeEventListener('change', handleChange)
    }
  }, [theme, embeddedTheme, getEffectiveTheme])

  return <>{children}</>
}
