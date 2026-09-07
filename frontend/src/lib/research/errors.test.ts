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
    expect(userErrorMessageKey('coverage_lease_lost')).toBe(RESEARCH_GENERIC_ERROR_KEY)
  })

  it('表中不含内部/job 终态码条目（R4-H1 可达性分类）', () => {
    for (const key of Object.keys(RESEARCH_ERROR_USER_COPY)) {
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
