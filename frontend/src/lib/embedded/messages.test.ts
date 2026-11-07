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

  // ── RWV2-50：additive theme 消息（宿主→iframe，payload 有界 light/dark）──

  it('接受 theme 消息并限定 light/dark（RWV2-50）', () => {
    expect(validateIncomingMessage(message({ type: 'theme', theme: 'dark' }), ctx()))
      .toEqual({ type: 'theme', theme: 'dark' })
    expect(validateIncomingMessage(message({ type: 'theme', theme: 'light' }), ctx()))
      .toEqual({ type: 'theme', theme: 'light' })
  })

  it('theme 载荷越界（非 light/dark）一律静默拒绝', () => {
    expectRejected(message({ type: 'theme', theme: 'system' }), ctx())
    expectRejected(message({ type: 'theme', theme: 'DARK' }), ctx())
    expectRejected(message({ type: 'theme', theme: 1 }), ctx())
    expectRejected(omit(message({ type: 'theme', theme: 'dark' }), 'theme'), ctx())
  })

  it('theme 消息同样必须满足五要素绑定', () => {
    expectRejected(message({ type: 'theme', theme: 'dark' }), ctx({ nonce: 'n_forged', channel: 'ch_forged' }))
    expectRejected(
      message({ type: 'theme', theme: 'dark' }),
      ctx({ origin: 'https://evil.example.com', sourceMatches: false }),
    )
  })
})

// ── W1 宿主契约 v1（#1104）：language 消息与 token/refresh 可选 project ──

describe('W1 契约 v1：language 消息（D-UI-02）', () => {
  it('接受 zh-CN / en-US 两种语言', () => {
    expect(validateIncomingMessage(message({ type: 'language', language: 'zh-CN' }), ctx()))
      .toEqual({ type: 'language', language: 'zh-CN' })
    expect(validateIncomingMessage(message({ type: 'language', language: 'en-US' }), ctx()))
      .toEqual({ type: 'language', language: 'en-US' })
  })

  it('越界/缺失/非字符串语言一律静默拒绝（只有两值合法）', () => {
    for (const language of ['zh', 'zh-TW', 'fr-FR', 'EN-US', '', 1, null]) {
      expectRejected(message({ type: 'language', language }), ctx())
    }
    expectRejected(omit(message({ type: 'language' }), 'language'), ctx())
  })

  it('language 消息同样必须满足五要素绑定', () => {
    expectRejected(
      message({ type: 'language', language: 'zh-CN' }),
      ctx({ nonce: 'n_forged', channel: 'ch_forged' }),
    )
    expectRejected(
      message({ type: 'language', language: 'zh-CN' }),
      ctx({ origin: 'https://evil.example.com', sourceMatches: false }),
    )
  })
})

describe('W1 契约 v1：token/refresh 可选 project 字段（D-UI-01）', () => {
  it('接受携带合法 project.name 的 token/refresh 消息', () => {
    expect(
      validateIncomingMessage(message({ project: { name: 'CAR-T 研究' } }), ctx()),
    ).toEqual({
      type: 'token',
      token: 'research.jwt.payload',
      expiresAt: 1754460300,
      project: { name: 'CAR-T 研究' },
    })
    expect(
      validateIncomingMessage(
        message({ type: 'refresh', project: { name: 'Project A' } }),
        ctx(),
      ),
    ).toEqual({
      type: 'refresh',
      token: 'research.jwt.payload',
      expiresAt: 1754460300,
      project: { name: 'Project A' },
    })
  })

  it('缺失 project 字段合法（refresh 由会话层保留已有项目名）', () => {
    const result = validateIncomingMessage(message(), ctx())
    expect(result).not.toBeNull()
    expect(result !== null && 'project' in result).toBe(false)
  })

  it('project 边界：1..200 字符合法，超界/空白/非对象一律整条拒绝', () => {
    expect(
      validateIncomingMessage(message({ project: { name: 'A'.repeat(200) } }), ctx()),
    ).not.toBeNull()
    expectRejected(message({ project: { name: '' } }), ctx())
    expectRejected(message({ project: { name: '   ' } }), ctx())
    expectRejected(message({ project: { name: 'A'.repeat(201) } }), ctx())
    expectRejected(message({ project: { name: 42 } }), ctx())
    expectRejected(message({ project: { name: null } }), ctx())
    expectRejected(message({ project: 'Project A' }), ctx())
    expectRejected(message({ project: ['Project A'] }), ctx())
  })

  it('project 字段非法时整条 token 消息被丢弃（不降级成通用项目名）', () => {
    expectRejected(message({ project: { name: '' } }), ctx())
  })

  it('project 名按先 trim 后 1..200 校验，并存储 trim 后值（B F11）', () => {
    // 前后空格：校验与存储都使用 trim 后的值
    expect(
      validateIncomingMessage(message({ project: { name: '  Project A  ' } }), ctx()),
    ).toEqual({
      type: 'token',
      token: 'research.jwt.payload',
      expiresAt: 1754460300,
      project: { name: 'Project A' },
    })
    // 原始 201、trim 后 199 → 合法（不能因未 trim 长度被误丢）
    const padded199 = `  ${'A'.repeat(199)}  `
    expect(padded199.length).toBe(203)
    expect(
      validateIncomingMessage(message({ project: { name: padded199 } }), ctx()),
    ).not.toBeNull()
    // trim 后仍超 200 → 非法
    expectRejected(message({ project: { name: `  ${'A'.repeat(201)}  ` } }), ctx())
    // 纯空白 trim 后为空 → 非法
    expectRejected(message({ project: { name: '   ' } }), ctx())
  })
})
