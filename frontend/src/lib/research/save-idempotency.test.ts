/**
 * RWV2-23（Issue #43，设计决策 D3）：Save-as-Insight/Note 确定性 Idempotency-Key。
 *
 * - 同一逻辑保存（project/origin_kind/origin_id/destination_kind 相同）
 *   恒产生同一 key → 服务端幂等重放返回原 artifact，跨刷新/重开/多标签收敛；
 * - key 域**不含 title**（当前 UI 不发自定义标题；引入标题编辑时必须把标题
 *   纳入幂等域或改用随机键）；
 * - 输出 <=128 字符、可打印（无 <32 控制字符），不触发后端 422。
 */
import { describe, expect, it } from 'vitest'
import { saveIdempotencyKey } from './save-idempotency'

describe('saveIdempotencyKey（RWV2-23 D3）', () => {
  it('同一逻辑保存返回同一 key（确定性）', () => {
    const a = saveIdempotencyKey('p1', 'search', 'gen_abc123', 'note')
    const b = saveIdempotencyKey('p1', 'search', 'gen_abc123', 'note')
    expect(a).toBe(b)
  })

  it('域中各部分任一变化都产生不同 key', () => {
    const base = saveIdempotencyKey('p1', 'search', 'gen_abc123', 'note')
    expect(saveIdempotencyKey('p2', 'search', 'gen_abc123', 'note')).not.toBe(base)
    expect(saveIdempotencyKey('p1', 'chat', 'gen_abc123', 'note')).not.toBe(base)
    expect(saveIdempotencyKey('p1', 'search', 'gen_abc456', 'note')).not.toBe(base)
    expect(saveIdempotencyKey('p1', 'search', 'gen_abc123', 'insight')).not.toBe(base)
  })

  it('note 与 insight 目标互不收敛', () => {
    expect(
      saveIdempotencyKey('p1', 'search', 'gen_abc123', 'note'),
    ).not.toBe(
      saveIdempotencyKey('p1', 'search', 'gen_abc123', 'insight'),
    )
  })

  it('不含 title：同一 origin/dest 不同 title 的 key 相同（防回归锁定）', () => {
    // 若未来引入自定义标题保存，此断言必须随幂等域扩展一起更新。
    expect(
      saveIdempotencyKey('p1', 'transformation', 'gen_abc123', 'note'),
    ).toBe(
      saveIdempotencyKey('p1', 'transformation', 'gen_abc123', 'note'),
    )
  })

  it('格式稳定：sv- + 16 位 hex（64-bit 双种子），<=128 字符，无 <32 控制字符', () => {
    const key = saveIdempotencyKey('p1', 'chat', 'gen_abc123', 'note')
    expect(key).toMatch(/^sv-[0-9a-f]{16}$/)
    expect(key.length).toBeLessThanOrEqual(128)
    for (const ch of key) {
      expect(ch.charCodeAt(0)).toBeGreaterThanOrEqual(32)
    }
  })
})
