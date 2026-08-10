import { describe, expect, it } from 'vitest'
import {
  checkCompareSelection,
  COMPARE_DEFAULT_MAX,
  COMPARE_HARD_MAX,
} from './compare'

// UI-03 Red：Compare 选择边界（REQ-QUOTA-01，设计 §7.4/§13）——
// 默认 ≤30、硬上限 50、51 篇 → 422 前置拒绝、空选拒绝。

describe('compare selection bounds', () => {
  it('默认上限 30、硬上限 50', () => {
    expect(COMPARE_DEFAULT_MAX).toBe(30)
    expect(COMPARE_HARD_MAX).toBe(50)
  })

  it('30 篇以内直接允许（overDefault=false）', () => {
    const ids = Array.from({ length: 30 }, (_, i) => `doc_${i}`)
    const r = checkCompareSelection(ids)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.count).toBe(30)
      expect(r.overDefault).toBe(false)
    }
  })

  it('31–50 篇允许但提示超出默认（overDefault=true）', () => {
    const ids = Array.from({ length: 50 }, (_, i) => `doc_${i}`)
    const r = checkCompareSelection(ids)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.count).toBe(50)
      expect(r.overDefault).toBe(true)
    }
  })

  it('51 篇拒绝（硬上限 50；服务端 422 的前置客户端校验）', () => {
    const ids = Array.from({ length: 51 }, (_, i) => `doc_${i}`)
    const r = checkCompareSelection(ids)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.reason).toBe('over_hard')
      expect(r.count).toBe(51)
    }
  })

  it('空选择拒绝（reason=empty）', () => {
    const r = checkCompareSelection([])
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.reason).toBe('empty')
    }
  })
})
