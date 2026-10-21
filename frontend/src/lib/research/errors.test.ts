import { describe, expect, it } from 'vitest'
import {
  RESEARCH_ERROR_USER_COPY,
  RESEARCH_GENERIC_ERROR_KEY,
  extractResearchErrorCode,
  userErrorMessageKey,
} from './errors'

describe('userErrorMessageKey（RWV2-42 U4）', () => {
  it('收录的稳定码映射到对应 key（daily_limit/superseded 复用既有 key，M14）', () => {
    expect(userErrorMessageKey('daily_limit_exceeded')).toBe(
      'research.chatErrorDailyLimitExceeded',
    )
    expect(userErrorMessageKey('superseded')).toBe('research.chatErrorSuperseded')
    expect(userErrorMessageKey('consent_required')).toBe(
      'research.errors.consentRequired',
    )
    expect(userErrorMessageKey('quota_exceeded')).toBe('research.errors.quotaExceeded')
    expect(userErrorMessageKey('model_unavailable')).toBe('research.errors.modelUnavailable')
  })

  it('null/空/未知码 → generic 兜底（raw 不作主消息）', () => {
    expect(userErrorMessageKey(null)).toBe(RESEARCH_GENERIC_ERROR_KEY)
    expect(userErrorMessageKey(undefined)).toBe(RESEARCH_GENERIC_ERROR_KEY)
    expect(userErrorMessageKey('mystery_internal_code')).toBe(RESEARCH_GENERIC_ERROR_KEY)
    // job 终态码仍回落 generic（#358 只豁免提交端点可达的 coverage_not_enabled）
    expect(userErrorMessageKey('coverage_lease_lost')).toBe(RESEARCH_GENERIC_ERROR_KEY)
  })

  it('#358：coverage_not_enabled（提交端点可达码）映射明确文案，非 generic', () => {
    expect(userErrorMessageKey('coverage_not_enabled')).toBe(
      'research.chatErrorCoverageNotEnabled',
    )
  })

  it('表中不含内部/job 终态码条目（R4-H1 可达性分类；#358 唯一豁免 coverage_not_enabled）', () => {
    for (const key of Object.keys(RESEARCH_ERROR_USER_COPY)) {
      if (key === 'coverage_not_enabled') continue // #358：提交端点 detail.code，非 Job 终态
      expect(key).not.toMatch(/^coverage_/)
      expect(key).not.toMatch(/^artifact_/)
      expect(key).not.toMatch(/^lease_|^quota_state$|^quota_reserved_tokens$/)
    }
  })
})

describe('extractResearchErrorCode（shape 守卫，R6-4）', () => {
  const withDetail = (detail: unknown) => ({ response: { data: { detail } } })

  it('业务对象 detail {code,message} → 提取 code', () => {
    expect(
      extractResearchErrorCode(withDetail({ code: 'quota_exceeded', message: 'x' })),
    ).toBe('quota_exceeded')
  })

  it('FastAPI 校验 detail 为数组 → null（不误读）', () => {
    expect(
      extractResearchErrorCode(
        withDetail([{ loc: ['body'], msg: 'field required', type: 'value_error' }]),
      ),
    ).toBeNull()
  })

  it('detail 为字符串 / 缺 code / code 非 string → null', () => {
    expect(extractResearchErrorCode(withDetail('upstream oops'))).toBeNull()
    expect(extractResearchErrorCode(withDetail({ message: 'no code' }))).toBeNull()
    expect(extractResearchErrorCode(withDetail({ code: 42 }))).toBeNull()
  })

  it('网络错误（无 response）/ 非对象 → null', () => {
    expect(extractResearchErrorCode(new Error('Network Error'))).toBeNull()
    expect(extractResearchErrorCode(undefined)).toBeNull()
    expect(extractResearchErrorCode('string')).toBeNull()
    expect(extractResearchErrorCode({})).toBeNull()
  })
})

/**
 * PR5（D-24/AC8）：传输层新增的客户端码必须有**主文案**——否则用户只拿到
 * generic 兜底，看到「出错了」却不知道下一步做什么（与 D-09 同类缺陷）。
 */
describe('PR5（D-24）：传输层客户端码有稳定文案', () => {
  it('stream_idle_timeout / stream_protocol_error 均映射到专用文案（不是 generic）', () => {
    expect(userErrorMessageKey('stream_idle_timeout')).toBe('research.errors.streamIdleTimeout')
    expect(userErrorMessageKey('stream_protocol_error')).toBe('research.errors.streamProtocolError')
    expect(userErrorMessageKey('stream_lost')).toBe('research.errors.streamLost')
    // 对照：真正未知的码仍兜底 generic
    expect(userErrorMessageKey('definitely_not_a_code')).toBe('research.errors.generic')
  })
})
