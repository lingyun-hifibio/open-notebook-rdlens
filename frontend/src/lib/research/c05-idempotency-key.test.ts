/**
 * Issue #601 PR5：幂等键生命周期测试（T27/T28/T29）——双向断言。
 */
import { describe, expect, it } from 'vitest'
import {
  acquireKey, canRetryKey, countAttempt, keyExpired, MAX_ATTEMPTS,
  newKeyHold, settleKey, signatureOf, KEY_MAX_AGE_MS,
} from './c05-idempotency-key'
import type { C05ErrorDetail } from './c05-error-actions'
import type { KeyHold } from './c05-idempotency-key'

const SIG_A = signatureOf({
  entry: 'search', query: 'q1',
  scope: { mode: 'all', sourceIds: [], noteIds: [], singleSourceId: null },
  modelId: 'm', contextLevel: 'focused',
})
const SIG_B = signatureOf({
  entry: 'search', query: 'q2',
  scope: { mode: 'all', sourceIds: [], noteIds: [], singleSourceId: null },
  modelId: 'm', contextLevel: 'focused',
})

function detail(partial: Partial<C05ErrorDetail>): C05ErrorDetail {
  return {
    code: null, message: null, acceptance: 'unknown', action: 'stop_and_confirm',
    retryable: null, recognised: false, shape: 'object',
    generation_id: null, state: null, retry_after_seconds: null, ...partial,
  }
}

describe('acquireKey', () => {
  it('首次提交生成新键', () => {
    const hold = newKeyHold()
    const r = acquireKey(hold, 1000, () => 'key-1', SIG_A)
    expect(r.key).toBe('key-1')
    expect(r.reused).toBe(false)
  })
  it('同签名复用（网络重试场景）', () => {
    const hold = newKeyHold()
    const first = acquireKey(hold, 1000, () => 'key-1', SIG_A)
    const second = acquireKey(first.hold, 1100, () => 'key-2', SIG_A)
    expect(second.key).toBe('key-1')
    expect(second.reused).toBe(true)
  })
  it('签名变化（新意图）→ 新键（T27）', () => {
    const hold = newKeyHold()
    const first = acquireKey(hold, 1000, () => 'key-1', SIG_A)
    const second = acquireKey(first.hold, 1100, () => 'key-2', SIG_B)
    expect(second.key).toBe('key-2')
    expect(second.reused).toBe(false)
  })
})

describe('settleKey（T27/T28/T29 双向）', () => {
  it('无 response（网络中断）→ 保留原键（T28 正向）', () => {
    const hold = { ...newKeyHold(), key: 'k1', signature: SIG_A, firstSentAt: 0, attempts: 1 }
    const next = settleKey(hold, { httpDelivered: false, detail: null, success: false })
    expect(next.key).toBe('k1')
  })

  it('acceptance_outcome_unknown → 保留原键（T28）', () => {
    const hold = { ...newKeyHold(), key: 'k1', signature: SIG_A, firstSentAt: 0, attempts: 1 }
    const next = settleKey(hold, {
      httpDelivered: true, success: false,
      detail: detail({ code: 'acceptance_outcome_unknown', acceptance: 'unknown', action: 'reconcile_then_retry', recognised: true }),
    })
    expect(next.key).toBe('k1')
  })

  it('generation_in_progress（read_original_result）→ 保留原键', () => {
    const hold = { ...newKeyHold(), key: 'k1', signature: SIG_A, firstSentAt: 0, attempts: 1 }
    const next = settleKey(hold, {
      httpDelivered: true, success: false,
      detail: detail({ code: 'generation_in_progress', acceptance: 'accepted', action: 'read_original_result', recognised: true }),
    })
    expect(next.key).toBe('k1')
  })

  it('确定性完成 200/202 → 清键（T28 反向：重跑必须新键）', () => {
    const hold = { ...newKeyHold(), key: 'k1', signature: SIG_A, firstSentAt: 0, attempts: 1 }
    const next = settleKey(hold, { httpDelivered: true, detail: null, success: true })
    expect(next.key).toBeNull()
  })

  it('T29：纯字符串 409 会话冲突（string shape）→ 清键（确定性结论，与 unknown 相反）', () => {
    const hold = { ...newKeyHold(), key: 'k1', signature: SIG_A, firstSentAt: 0, attempts: 1 }
    const next = settleKey(hold, {
      httpDelivered: true, success: false,
      detail: detail({ shape: 'string', code: null, acceptance: 'unknown', action: 'stop_and_confirm', recognised: false }),
    })
    // D-13 表第 5 行：字符串 detail = 服务端确定性结论（无接受凭据）→ 清键
    expect(next.key).toBeNull()
  })

  it('T29：字符串 426 门禁（string shape + recognised）→ 清键', () => {
    const hold = { ...newKeyHold(), key: 'k1', signature: SIG_A, firstSentAt: 0, attempts: 1 }
    const next = settleKey(hold, {
      httpDelivered: true, success: false,
      detail: detail({ shape: 'string', code: null, acceptance: 'not_accepted', action: 'show_unavailable', recognised: true }),
    })
    expect(next.key).toBeNull()
  })

  it('T28 正向不变量：数组 detail（extra=forbid 422）→ 清键（确定性框架拒绝）', () => {
    const hold = { ...newKeyHold(), key: 'k1', signature: SIG_A, firstSentAt: 0, attempts: 1 }
    const next = settleKey(hold, {
      httpDelivered: true, success: false,
      detail: detail({ shape: 'array', code: null, acceptance: 'unknown', action: 'stop_and_confirm', recognised: false }),
    })
    expect(next.key).toBeNull()
  })

  it('422 scope 校验拒绝（not_accepted 对象）→ 清键', () => {
    const hold = { ...newKeyHold(), key: 'k1', signature: SIG_A, firstSentAt: 0, attempts: 1 }
    const next = settleKey(hold, {
      httpDelivered: true, success: false,
      detail: detail({ code: 'scope_selected_empty', acceptance: 'not_accepted', action: 'reselect_sources', recognised: true }),
    })
    expect(next.key).toBeNull()
  })
})

describe('attempts / expiry（T27）', () => {
  it('自动+手动合计 ≤3', () => {
    let hold: KeyHold = { ...newKeyHold(), key: 'k1', signature: SIG_A, firstSentAt: 0, attempts: 0 }
    for (let i = 0; i < MAX_ATTEMPTS; i += 1) {
      expect(canRetryKey(hold, 1000)).toBe(true)
      hold = countAttempt(hold)
    }
    expect(canRetryKey(hold, 1000)).toBe(false)
  })

  it('键龄 >24h 停止 POST', () => {
    const hold = { ...newKeyHold(), key: 'k1', signature: SIG_A, firstSentAt: 0, attempts: 1 }
    expect(keyExpired(hold, KEY_MAX_AGE_MS + 1)).toBe(true)
    expect(canRetryKey(hold, KEY_MAX_AGE_MS + 1)).toBe(false)
    expect(canRetryKey(hold, KEY_MAX_AGE_MS - 1)).toBe(true)
  })
})
