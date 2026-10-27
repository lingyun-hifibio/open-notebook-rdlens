import { describe, expect, it } from 'vitest'
import { createInstance } from 'i18next'

import { resources } from './index'
import { translateOrFallback } from './translate-or-fallback'

// PR-6（3E）§8.5：i18n 兜底必须“只插值一次”，并保留标题中的字面占位符与
// `$&`/`$1` 等替换语法（评审 P2）。
describe('translateOrFallback', () => {
  it('真实 i18next：模板插值一次；标题内的 {{name}} 字面量保留', async () => {
    const i18n = createInstance()
    await i18n.init({
      resources,
      lng: 'en-US',
      fallbackLng: 'en-US',
      interpolation: { escapeValue: false },
    })
    const title = 'Cost {{name}} analysis'
    const label = translateOrFallback(
      i18n.t.bind(i18n),
      'research.a11y.sessionItem',
      'Open conversation {{name}}',
      { name: title },
    )
    expect(label).toBe(`Open conversation ${title}`)
  })

  it('zh-CN 返回译文并插值', async () => {
    const i18n = createInstance()
    await i18n.init({
      resources,
      lng: 'zh-CN',
      fallbackLng: 'en-US',
      interpolation: { escapeValue: false },
    })
    expect(
      translateOrFallback(i18n.t.bind(i18n), 'research.a11y.sessionItem', 'Open conversation {{name}}', {
        name: '方法学讨论',
      }),
    ).toBe('打开会话 方法学讨论')
  })

  it('未初始化/缺键回退英文常量：$&/$1 按字面保留、占位符替换', () => {
    const t = (key: string): string => key
    expect(
      translateOrFallback(t, 'research.a11y.sessionItem', 'Open conversation {{name}}', {
        name: 'Cost $& $1 analysis',
      }),
    ).toBe('Open conversation Cost $& $1 analysis')
  })
})
