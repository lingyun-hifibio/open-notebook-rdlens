import { describe, expect, it } from 'vitest'
import { classifyAiInsightFailure, normalizeAiInsightError } from './ai-insight-disposition'

// Issue #54 S3（FR-05）：disposition 七级优先级。归一化输入覆盖
// HTTP status/detail.code/detail.state/无响应/纯字符串 detail，分类顺序即
// 优先级——前置级命中即返回，测试逐级锁定。

const httpError = (
  status: number,
  detail: unknown,
  headers: Record<string, string> = {},
) => ({
  isAxiosError: true,
  message: `Request failed with status code ${status}`,
  response: { status, data: detail === undefined ? undefined : { detail }, headers },
})

const apiError = (body: unknown, status = 409) => ({
  isAxiosError: true,
  message: `Request failed with status code ${status}`,
  response: { status, data: body, headers: {} },
})

describe('normalizeAiInsightError', () => {
  it('结构化 detail.code/message + HTTP status + hasResponse', () => {
    expect(normalizeAiInsightError(httpError(409, { code: 'generation_in_progress', message: 'busy' })))
      .toEqual({
        status: 409,
        code: 'generation_in_progress',
        state: null,
        message: 'busy',
        hasResponse: true,
      })
  })

  it('detail.state 参与归一化（无 code 时仍可判终态）', () => {
    expect(normalizeAiInsightError(httpError(409, { state: 'outcome_unknown', message: 'x' })))
      .toEqual({
        status: 409,
        code: null,
        state: 'outcome_unknown',
        message: 'x',
        hasResponse: true,
      })
  })

  it('纯字符串 detail → message 保留（供 idempotency conflict 判别）', () => {
    expect(normalizeAiInsightError(httpError(409, 'idempotency conflict'))).toEqual({
      status: 409,
      code: null,
      state: null,
      message: 'idempotency conflict',
      hasResponse: true,
    })
  })

  it('FastAPI 校验数组 detail → 不误读（全 null，status 保留）', () => {
    expect(normalizeAiInsightError(httpError(422, [{ loc: ['body'] }]))).toEqual({
      status: 422,
      code: null,
      state: null,
      message: null,
      hasResponse: true,
    })
  })

  it('无响应（网络失败）→ status null / hasResponse false', () => {
    expect(normalizeAiInsightError({ isAxiosError: true, message: 'Network Error' })).toEqual({
      status: null,
      code: null,
      state: null,
      message: null,
      hasResponse: false,
    })
  })

  it('非对象输入不抛错，按无响应处理', () => {
    expect(normalizeAiInsightError('boom')).toEqual({
      status: null,
      code: null,
      state: null,
      message: null,
      hasResponse: false,
    })
  })
})

describe('classifyAiInsightFailure（优先级 1→7）', () => {
  it('1. state=outcome_unknown 或 code=outcome_unknown → outcome_unknown（优先于 409 重试语义）', () => {
    expect(classifyAiInsightFailure(httpError(409, { state: 'outcome_unknown' }))).toBe('outcome_unknown')
    expect(classifyAiInsightFailure(httpError(409, { code: 'outcome_unknown' }))).toBe('outcome_unknown')
  })

  it('2. state=accepted/running 或 code=generation_in_progress → retry_same_key', () => {
    expect(classifyAiInsightFailure(httpError(409, { state: 'accepted' }))).toBe('retry_same_key')
    expect(classifyAiInsightFailure(httpError(409, { state: 'running' }))).toBe('retry_same_key')
    expect(classifyAiInsightFailure(httpError(409, { code: 'generation_in_progress' }))).toBe('retry_same_key')
  })

  it('3. state=failed → terminal', () => {
    expect(classifyAiInsightFailure(httpError(409, { state: 'failed' }))).toBe('terminal')
  })

  it('4. consent 三码 → consent_invalid（不再重试同键）', () => {
    expect(classifyAiInsightFailure(httpError(403, { code: 'consent_required' }))).toBe('consent_invalid')
    expect(classifyAiInsightFailure(httpError(403, { code: 'consent_revoked' }))).toBe('consent_invalid')
    expect(classifyAiInsightFailure(httpError(403, { code: 'consent_scope_changed' }))).toBe('consent_invalid')
  })

  it('5. 纯字符串 idempotency conflict（409）→ protocol_conflict', () => {
    expect(classifyAiInsightFailure(httpError(409, 'idempotency conflict'))).toBe('protocol_conflict')
  })

  it('5. 结构化 code=idempotency_conflict（409）→ protocol_conflict', () => {
    expect(classifyAiInsightFailure(httpError(409, { code: 'idempotency_conflict' }))).toBe('protocol_conflict')
  })

  it('5. 无解释的 409 → protocol_conflict（禁止自动重发）', () => {
    expect(classifyAiInsightFailure(httpError(409, {}))).toBe('protocol_conflict')
    expect(classifyAiInsightFailure(httpError(409, { code: 'unknown_thing' }))).toBe('protocol_conflict')
  })

  it('6. 无 HTTP 响应 → retry_same_key', () => {
    expect(classifyAiInsightFailure({ isAxiosError: true, message: 'Network Error' })).toBe('retry_same_key')
  })

  it('6. 无权威终态的 5xx → retry_same_key', () => {
    expect(classifyAiInsightFailure(httpError(500, { code: 'internal' }))).toBe('retry_same_key')
    expect(classifyAiInsightFailure(httpError(503, 'upstream down'))).toBe('retry_same_key')
  })

  it('6. 5xx 但带权威终态（state=failed）→ 不被兜底吞掉，判 terminal', () => {
    expect(classifyAiInsightFailure(httpError(500, { state: 'failed' }))).toBe('terminal')
  })

  it('6. 5xx 但 state=outcome_unknown → outcome_unknown（优先级 1 高于 6）', () => {
    expect(classifyAiInsightFailure(httpError(503, { state: 'outcome_unknown' }))).toBe('outcome_unknown')
  })

  it('7. 其余确定性 4xx/422/429 → terminal', () => {
    expect(classifyAiInsightFailure(httpError(422, { code: 'context_limit_exceeded' }))).toBe('terminal')
    expect(classifyAiInsightFailure(httpError(429, { code: 'rate_limited' }))).toBe('terminal')
    expect(classifyAiInsightFailure(httpError(400, { code: 'bad_request' }))).toBe('terminal')
    expect(classifyAiInsightFailure(httpError(404, { code: 'not_found' }))).toBe('terminal')
  })

  it('结构化 detail 但无 code/state 的 4xx → terminal（不因缺码而重试）', () => {
    expect(classifyAiInsightFailure(apiError({ message: 'nope' }, 403))).toBe('terminal')
  })

  it('非 axios 运行时异常（如解析错误）→ retry_same_key（结果未知，不得判终态）', () => {
    expect(classifyAiInsightFailure(new SyntaxError('unexpected token'))).toBe('retry_same_key')
  })
})
