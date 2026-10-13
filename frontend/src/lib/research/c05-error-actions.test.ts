/**
 * Issue #601 PR5：C-05 错误动作分类测试（T19/T29/T20）。
 * 核心断言：字符串 detail 保守未识别；对象 detail 按 recovery_action；
 * 两类 409 的键处置锚点相反。
 */
import { describe, expect, it } from 'vitest'
import { classifyC05Error } from './c05-error-actions'

function axiosError(status: number, data: unknown): unknown {
  return { response: { status, data } }
}

describe('classifyC05Error（对象 detail）', () => {
  it('acceptance_outcome_unknown → unknown + reconcile_then_retry + retryable', () => {
    const d = classifyC05Error(axiosError(409, { detail: {
      code: 'acceptance_outcome_unknown',
      message: 'the acceptance outcome could not be verified',
      generation_id: 'gen_1',
      retry_with_original_idempotency_key: true,
      recovery_action: 'reconcile_then_retry',
      acceptance: 'unknown',
    } }))
    expect(d.acceptance).toBe('unknown')
    expect(d.action).toBe('reconcile_then_retry')
    expect(d.recognised).toBe(true)
    expect(d.generation_id).toBe('gen_1')
  })

  it('outcome_unknown（模型可能已发送）→ accepted + stop_and_confirm（不授权重发）', () => {
    const d = classifyC05Error(axiosError(409, { detail: {
      code: 'outcome_unknown', message: 'x', generation_id: 'gen_1', state: 'outcome_unknown',
      recovery_action: 'stop_and_confirm', acceptance: 'accepted',
    } }))
    expect(d.action).toBe('stop_and_confirm')
    expect(d.acceptance).toBe('accepted')
  })

  it('c05_entry_not_ready → show_unavailable', () => {
    const d = classifyC05Error(axiosError(503, { detail: {
      code: 'c05_entry_not_ready', entry: 'chat', message: 'x',
      recovery_action: 'show_unavailable', acceptance: 'not_accepted',
    } }))
    expect(d.action).toBe('show_unavailable')
    expect(d.acceptance).toBe('not_accepted')
  })

  it('scope_selected_empty → reselect_sources', () => {
    const d = classifyC05Error(axiosError(422, { detail: {
      code: 'scope_selected_empty', message: 'x',
      recovery_action: 'reselect_sources', acceptance: 'not_accepted',
    } }))
    expect(d.action).toBe('reselect_sources')
  })

  it('未登记的对象码 → unknown + stop_and_confirm + recognised=false', () => {
    const d = classifyC05Error(axiosError(503, { detail: {
      code: 'quota_unavailable', message: 'x', retryable: false,
      recovery_action: 'stop_and_confirm', acceptance: 'unknown',
    } }))
    expect(d.recognised).toBe(false)
    expect(d.acceptance).toBe('unknown')
    expect(d.action).toBe('stop_and_confirm')
  })

  it('对象 detail 缺 code → unknown 保守', () => {
    const d = classifyC05Error(axiosError(500, { detail: { message: 'boom' } }))
    expect(d.code).toBeNull()
    expect(d.acceptance).toBe('unknown')
  })

  it('generation_in_progress → read_original_result（键是读取凭据）', () => {
    const d = classifyC05Error(axiosError(409, { detail: {
      code: 'generation_in_progress', generation_id: 'gen_1', state: 'running',
      recovery_action: 'read_original_result', acceptance: 'accepted',
    } }))
    expect(d.action).toBe('read_original_result')
    expect(d.acceptance).toBe('accepted')
  })
})

describe('classifyC05Error（T19 字符串/数组 detail 保守）', () => {
  it('409 "idempotency conflict" 纯字符串 → unknown + stop_and_confirm + recognised=false（D-03）', () => {
    const d = classifyC05Error(axiosError(409, { detail: 'idempotency conflict' }))
    expect(d.shape).toBe('string')
    expect(d.code).toBeNull()
    expect(d.acceptance).toBe('unknown')
    expect(d.action).toBe('stop_and_confirm')
    expect(d.recognised).toBe(false)
  })

  it('409 会话冲突纯字符串 → 同样未识别（T29 对照面）', () => {
    const d = classifyC05Error(axiosError(409, 'begin_turn conflict'))
    expect(d.recognised).toBe(false)
    expect(d.action).toBe('stop_and_confirm')
  })

  it('426 纯字符串 → show_unavailable（D-02 契约一致性保守识别）', () => {
    const d = classifyC05Error(axiosError(426, 'C-05 scope contract is not enabled'))
    expect(d.acceptance).toBe('not_accepted')
    expect(d.action).toBe('show_unavailable')
    expect(d.recognised).toBe(true)
  })

  it('框架数组 detail（extra=forbid 422）→ 未识别', () => {
    const d = classifyC05Error(axiosError(422, { detail: [
      { type: 'extra_forbidden', loc: ['body', 'source_scope'], msg: 'Extra inputs are not permitted' },
    ] }))
    expect(d.shape).toBe('array')
    expect(d.recognised).toBe(false)
    expect(d.action).toBe('stop_and_confirm')
  })

  it('网络错误（无 response）→ unknown', () => {
    const d = classifyC05Error(new Error('network gone'))
    expect(d.shape).toBe('none')
    expect(d.acceptance).toBe('unknown')
  })
})
