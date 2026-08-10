import { describe, expect, it } from 'vitest'
import {
  validateIncomingMessage,
  type MessageValidationContext,
  type ValidatedInboundMessage,
  PM_SCHEMA,
} from './messages'

// UI-01 Red：postMessage v0 契约（契约 v0 §12，REQ-EMB-01）——
// 伪造 origin / window source / schema / nonce / channel 的消息一律静默拒绝。

const NONCE = 'n_session'
const CHANNEL = 'ch_session'

function ctx(overrides: Partial<MessageValidationContext> = {}): MessageValidationContext {
  return {
    origin: 'https://rdlens.example.com',
    sourceMatches: true,
    allowedOrigins: ['https://rdlens.example.com'],
    nonce: NONCE,
    channel: CHANNEL,
    ...overrides,
  }
}

function message(overrides: Record<string, unknown> = {}) {
  return {
    schema: PM_SCHEMA,
    channel: CHANNEL,
    type: 'token',
    nonce: NONCE,
    token: 'research.jwt.payload',
    expires_at: 1754460300,
    ...overrides,
  }
}

function omit(data: Record<string, unknown>, key: string): Record<string, unknown> {
  const copy = { ...data }
  delete copy[key]
  return copy
}

function expectRejected(data: unknown, context: MessageValidationContext) {
  expect(validateIncomingMessage(data, context)).toBeNull()
}

describe('validateIncomingMessage（REQ-EMB-01 伪造消息全拒绝）', () => {
  it('接受合法的 token 消息', () => {
    const result = validateIncomingMessage(message(), ctx())
    expect(result).toEqual({
      type: 'token',
      token: 'research.jwt.payload',
      expiresAt: 1754460300,
    } satisfies ValidatedInboundMessage)
  })

  it('拒绝错误 schema 的消息', () => {
    expectRejected(message({ schema: 'research-v9' }), ctx())
  })

  it('拒绝缺失 schema 的消息', () => {
    expectRejected(omit(message(), 'schema'), ctx())
  })

  it('拒绝不匹配 channel 的消息', () => {
    expectRejected(message({ channel: 'ch_other' }), ctx())
  })

  it('拒绝不匹配 nonce 的消息', () => {
    expectRejected(message({ nonce: 'n_forged' }), ctx())
  })

  it('拒绝 origin 不在白名单的消息', () => {
    expectRejected(message(), ctx({ origin: 'https://evil.example.com' }))
  })

  it('拒绝 event.source 不是父窗口引用的消息', () => {
    expectRejected(message(), ctx({ sourceMatches: false }))
  })

  it('拒绝未知消息类型', () => {
    expectRejected(message({ type: 'hack' }), ctx())
  })

  it('拒绝非对象载荷（null/字符串/数组）', () => {
    expectRejected(null, ctx())
    expectRejected('ready', ctx())
    expectRejected([message()], ctx())
  })

  it('拒绝 token 为空串或缺失 expires_at 的 token 消息', () => {
    expectRejected(message({ token: '' }), ctx())
    expectRejected(omit(message(), 'expires_at'), ctx())
    expectRejected(message({ expires_at: 'soon' }), ctx())
  })

  it('接受 refresh 消息并携带新 token/expiresAt', () => {
    const result = validateIncomingMessage(
      message({ type: 'refresh', token: 'jwt.2', expires_at: 1754460900 }),
      ctx(),
    )
    expect(result).toEqual({ type: 'refresh', token: 'jwt.2', expiresAt: 1754460900 })
  })

  it('接受 error 消息但拒绝未知 code', () => {
    const result = validateIncomingMessage(
      message({ type: 'error', code: 'bootstrap_failed', message: 'boom' }),
      ctx(),
    )
    expect(result).toEqual({ type: 'error', code: 'bootstrap_failed', message: 'boom' })
    expectRejected(message({ type: 'error', code: 'unknown_code', message: 'boom' }), ctx())
    expectRejected(message({ type: 'error', code: 'bootstrap_failed', message: 42 }), ctx())
  })

  it('接受 logout 与 destroy 消息', () => {
    expect(validateIncomingMessage(message({ type: 'logout' }), ctx())).toEqual({ type: 'logout' })
    expect(validateIncomingMessage(message({ type: 'destroy' }), ctx())).toEqual({ type: 'destroy' })
  })

  it('token/refresh/error 载荷必须同时满足五要素绑定', () => {
    const valid = validateIncomingMessage(message(), ctx())
    expect(valid).not.toBeNull()
    expectRejected(message(), ctx({ origin: 'https://evil.example.com', sourceMatches: false }))
    expectRejected(message(), ctx({ nonce: 'n_forged', channel: 'ch_forged' }))
  })
})
