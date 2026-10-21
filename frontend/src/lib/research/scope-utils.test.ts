/**
 * RWV2-12：共享 Scope 工具测试。
 *
 * PR5（Issue #601，C2/T3）：`resolveScopeSelection` 与 `EmptyEffectiveScopeError`
 * 已删除——`all` 由服务端 C-05 解析（`source_scope.mode='all'`），前端不再
 * 分页枚举展开（D-11；静态零残留守卫见 c05-static-guards.test.ts）。
 * 本文件保留 `detectResponseLanguage`（RWV2-12 原有行为不变）。
 */
import { describe, expect, it } from 'vitest'
import { detectResponseLanguage } from './scope-utils'

describe('detectResponseLanguage（RFC §4.2 检测规则）', () => {
  it('CJK 多于 ASCII 字母 → zh', () => {
    expect(detectResponseLanguage('请总结这份研究并给出结论')).toBe('zh')
  })

  it('ASCII 字母多于 CJK / 纯英文 → en', () => {
    expect(detectResponseLanguage('Summarize the key findings')).toBe('en')
  })

  it('平局 → en（RFC §4.2：平局默认 en）', () => {
    // 1 CJK（研）+ 1 ASCII 字母（a）→ 平局 → en
    expect(detectResponseLanguage('研a')).toBe('en')
  })

  it('纯数字 / 空输入 / 纯缩写 → en', () => {
    expect(detectResponseLanguage('2026')).toBe('en')
    expect(detectResponseLanguage('   ')).toBe('en')
    expect(detectResponseLanguage('')).toBe('en')
    expect(detectResponseLanguage('DNA')).toBe('en')
  })
})
