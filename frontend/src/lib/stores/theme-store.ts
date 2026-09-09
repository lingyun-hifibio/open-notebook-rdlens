import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export type Theme = 'light' | 'dark' | 'system'
export type EmbeddedTheme = 'light' | 'dark'

interface ThemeState {
  theme: Theme
  /**
   * RWV2-50（RDLens #363）：嵌入式父页主题 override。
   * - 仅由嵌入会话在 authenticated 后驱动；非持久化（partialize 不含此字段），
   *   独立（standalone）使用不被父页主题污染。
   * - 存续期间优先于 `theme`（含 system 解析），成为 DOM 与消费组件的唯一真源。
   */
  embeddedTheme: EmbeddedTheme | null
  setTheme: (theme: Theme) => void
  setEmbeddedTheme: (theme: EmbeddedTheme | null) => void
  getSystemTheme: () => 'light' | 'dark'
  getEffectiveTheme: () => 'light' | 'dark'
}

function applyThemeToDocument(effectiveTheme: 'light' | 'dark'): void {
  const root = window.document.documentElement
  root.classList.remove('light', 'dark')
  root.classList.add(effectiveTheme)
  root.setAttribute('data-theme', effectiveTheme)
}

export const useThemeStore = create<ThemeState>()(
  persist(
    (set, get) => ({
      theme: 'system',
      embeddedTheme: null,

      setTheme: (theme: Theme) => {
        set({ theme })

        // Apply theme to document immediately
        if (typeof window !== 'undefined') {
          applyThemeToDocument(get().getEffectiveTheme())
        }
      },

      setEmbeddedTheme: (theme: EmbeddedTheme | null) => {
        // 相同值 early-return：shell 对每条会话消息都会重导出派生值，
        // 避免冗余 store 通知与 effect 重跑。
        if (get().embeddedTheme === theme) return
        set({ embeddedTheme: theme })
        if (typeof window !== 'undefined') {
          applyThemeToDocument(get().getEffectiveTheme())
        }
      },

      getSystemTheme: () => {
        if (typeof window !== 'undefined') {
          return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
        }
        return 'light'
      },

      getEffectiveTheme: () => {
        const { theme, embeddedTheme } = get()
        if (embeddedTheme !== null) return embeddedTheme
        return theme === 'system' ? get().getSystemTheme() : theme
      }
    }),
    {
      name: 'theme-storage',
      partialize: (state) => ({ theme: state.theme })
    }
  )
)

// Hook for components to use theme
export function useTheme() {
  const { theme, setTheme, getEffectiveTheme } = useThemeStore()

  return {
    theme,
    setTheme,
    effectiveTheme: getEffectiveTheme(),
    isDark: getEffectiveTheme() === 'dark'
  }
}
