import { describe, expect, it } from 'vitest'
import { formatResearchTimestamp, researchLanguageLabelKey } from './format'

// RWV2-43（fork #47）Red：research 域展示格式化纯函数。
// - 时间：ISO-8601 → 可读绝对时间；合法输入 + 钉定 timeZone:'UTC' 时输出
//   确定（F2：不做机器时区依赖断言）；非法/缺失回退原串或 null（不伪造）。
// - 语言：response_language 的 en/zh → 英文标签 key；未知非 null → 原码
//   （C-M1：与 jobTypeLabelKey 未知回退 raw 的先例一致，不丢失信息）。

describe('formatResearchTimestamp', () => {
  it('null / 空串 → null（调用方决定占位「—」或省略整段）', () => {
    expect(formatResearchTimestamp(null)).toBeNull()
    expect(formatResearchTimestamp('')).toBeNull()
  })

  it('非法日期 → 返回原串（宁可原样展示，不伪造）', () => {
    expect(formatResearchTimestamp('not-a-date')).toBe('not-a-date')
    expect(formatResearchTimestamp('2026-99-99')).toBe('2026-99-99')
  })

  it('合法 ISO（默认 en-US，钉定 UTC）→ 可读绝对时间', () => {
    expect(formatResearchTimestamp('2026-09-07T00:00:00Z', { timeZone: 'UTC' })).toBe(
      'Sep 7, 2026, 12:00 AM',
    )
  })

  it('指定 lang → 按该 locale 格式化', () => {
    const formatted = formatResearchTimestamp('2026-09-07T00:00:00Z', {
      lang: 'de-DE',
      timeZone: 'UTC',
    })
    expect(formatted).toContain('00:00')
    expect(formatted).not.toBe('Sep 7, 2026, 12:00 AM')
  })

  it('非法 timeZone → Intl 构造抛错兜底回原串（R3-4）', () => {
    expect(formatResearchTimestamp('2026-09-07T00:00:00Z', { timeZone: 'Bad/Zone' })).toBe(
      '2026-09-07T00:00:00Z',
    )
  })
})

describe('researchLanguageLabelKey', () => {
  it('null / 空串 → null（展示「—」占位）', () => {
    expect(researchLanguageLabelKey(null)).toBeNull()
    expect(researchLanguageLabelKey('')).toBeNull()
  })

  it("'en' / 'zh' → 英文标签 i18n key（RWV2-43 可读性，F4）", () => {
    expect(researchLanguageLabelKey('en')).toBe('research.transformations.variantEn')
    expect(researchLanguageLabelKey('zh')).toBe('research.transformations.variantZh')
  })

  it('未知非 null 语言 → 返回原码（C-M1：不丢失信息，与 jobTypeLabelKey 先例一致）', () => {
    expect(researchLanguageLabelKey('ja')).toBe('ja')
    expect(researchLanguageLabelKey('fr')).toBe('fr')
  })
})
