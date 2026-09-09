import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useThemeStore } from './theme-store'

// RWV2-50（RDLens #363）：嵌入式父页主题 override——非持久化、优先于独立
// 偏好、可还原；独立（standalone）路径行为不变。

function appliedTheme(): string | null {
  return document.documentElement.getAttribute('data-theme')
}

describe('theme-store embedded override（RWV2-50）', () => {
  beforeEach(() => {
    localStorage.clear()
    document.documentElement.className = ''
    document.documentElement.removeAttribute('data-theme')
    useThemeStore.setState({ theme: 'light', embeddedTheme: null })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('embedded override 优先于独立偏好并写入 DOM', () => {
    useThemeStore.getState().setEmbeddedTheme('dark')
    expect(useThemeStore.getState().getEffectiveTheme()).toBe('dark')
    expect(appliedTheme()).toBe('dark')
    expect(document.documentElement.classList.contains('dark')).toBe(true)
  })

  it('setEmbeddedTheme(null) 还原独立语义并重应用 DOM', () => {
    useThemeStore.getState().setEmbeddedTheme('light')
    useThemeStore.getState().setEmbeddedTheme(null)
    expect(useThemeStore.getState().getEffectiveTheme()).toBe('light')
    expect(appliedTheme()).toBe('light')
  })

  it('embeddedTheme 不持久化（theme-storage 只含 theme）', () => {
    useThemeStore.getState().setEmbeddedTheme('dark')
    const raw = localStorage.getItem('theme-storage')
    expect(raw).not.toBeNull()
    const parsed = JSON.parse(raw!) as { state?: { theme?: string; embeddedTheme?: string } }
    expect(parsed.state?.theme).toBe('light')
    expect(parsed.state?.embeddedTheme).toBeUndefined()
  })

  it('相同值重复调用不触发新的通知', () => {
    const listener = vi.fn()
    const unsubscribe = useThemeStore.subscribe(listener)
    useThemeStore.getState().setEmbeddedTheme('dark')
    useThemeStore.getState().setEmbeddedTheme('dark')
    expect(listener).toHaveBeenCalledTimes(1)
    unsubscribe()
  })

  it('getEffectiveTheme 优先级：embedded > user theme（非 system）', () => {
    useThemeStore.setState({ theme: 'light', embeddedTheme: null })
    expect(useThemeStore.getState().getEffectiveTheme()).toBe('light')
    useThemeStore.getState().setEmbeddedTheme('dark')
    expect(useThemeStore.getState().getEffectiveTheme()).toBe('dark')
  })

  it('独立 setTheme 行为回归：写入偏好与 DOM，且不携带 override', () => {
    useThemeStore.getState().setTheme('dark')
    expect(useThemeStore.getState().theme).toBe('dark')
    expect(appliedTheme()).toBe('dark')
    expect(useThemeStore.getState().embeddedTheme).toBeNull()
  })
})
