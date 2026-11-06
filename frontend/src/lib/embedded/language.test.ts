import { describe, expect, it } from 'vitest'
import { resolveAppliedLanguage, resolveInitialLanguage } from './language'

describe('resolveInitialLanguage（RWV2-42 U1）', () => {
  it('embedded=true → 固定 en-US（宿主 UI English-only，不跟随浏览器语言）', () => {
    expect(resolveInitialLanguage(true)).toBe('en-US')
  })

  it('embedded=false → undefined（standalone 保留原 LanguageDetector 多语言行为）', () => {
    expect(resolveInitialLanguage(false)).toBeUndefined()
  })
})

describe('resolveAppliedLanguage（W1 契约 v1，D-UI-02）', () => {
  it('宿主语言消息优先（zh-CN / en-US）', () => {
    expect(resolveAppliedLanguage(true, 'zh-CN')).toBe('zh-CN')
    expect(resolveAppliedLanguage(true, 'en-US')).toBe('en-US')
    expect(resolveAppliedLanguage(false, 'zh-CN')).toBe('zh-CN')
  })

  it('未收到消息：嵌入式仍为 en-US，standalone 返回 null（不覆盖检测器）', () => {
    expect(resolveAppliedLanguage(true, null)).toBe('en-US')
    expect(resolveAppliedLanguage(true, undefined)).toBe('en-US')
    expect(resolveAppliedLanguage(false, null)).toBeNull()
  })
})
