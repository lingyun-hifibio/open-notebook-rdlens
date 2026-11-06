import { describe, expect, it } from 'vitest'
import { resolveInitialLanguage } from './language'

describe('resolveInitialLanguage（RWV2-42 U1）', () => {
  it('embedded=true → 固定 en-US（宿主 UI English-only，不跟随浏览器语言）', () => {
    expect(resolveInitialLanguage(true)).toBe('en-US')
  })

  it('embedded=false → undefined（standalone 保留原 LanguageDetector 多语言行为）', () => {
    expect(resolveInitialLanguage(false)).toBeUndefined()
  })
})
