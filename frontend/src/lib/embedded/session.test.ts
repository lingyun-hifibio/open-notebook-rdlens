import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createEmbeddedSession,
  type EmbeddedSession,
  type SessionState,
} from './session'
import { clearResearchToken, getResearchToken, getResearchTokenExpiry } from './token-store'

// UI-01 Red：安全会话状态机（REQ-AUTH-02/REQ-EMB-02，契约 v0 §12）——
// ready 精确 targetOrigin、token 只存内存、refresh/logout/destroy 正确、
// 伪造消息静默不响应、销毁后不再接受消息。

const PARENT_ORIGIN = 'https://rdlens.example.com'

interface Harness {
  session: EmbeddedSession
  posted: Array<{ data: Record<string, unknown>; targetOrigin: string }>
  states: SessionState[]
  dispatch: (payload: { data?: unknown; origin?: string; source?: unknown }) => void
  listeners: Array<(event: MessageEvent) => void>
}

function makeHarness(): Harness {
  const posted: Harness['posted'] = []
  const listeners: Harness['listeners'] = []
  const states: SessionState[] = []
  const session = createEmbeddedSession({
    allowedOrigins: [PARENT_ORIGIN],
    parentOrigin: PARENT_ORIGIN,
    post: (data, targetOrigin) => {
      posted.push({ data: data as Record<string, unknown>, targetOrigin })
    },
    addListener: (fn) => {
      listeners.push(fn)
    },
    removeListener: (fn) => {
      const idx = listeners.indexOf(fn)
      if (idx >= 0) listeners.splice(idx, 1)
    },
    expectedSource: 'window-parent-ref' as unknown as Window,
  })
  session.subscribe((state) => states.push(state))
  return {
    session,
    posted,
    states,
    dispatch: (payload) => {
      for (const fn of [...listeners]) {
        fn({
          data: payload.data,
          origin: payload.origin ?? PARENT_ORIGIN,
          // 合法消息默认携带期望的父窗口引用（expectedSource）
          source: payload.source ?? 'window-parent-ref',
        } as MessageEvent)
      }
    },
    listeners,
  }
}

/** 基于当前 harness 的 ready 握手（nonce/channel 回显）构造入站消息。 */
function inboundMessage(
  ready: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
) {
  return {
    schema: 'research-v0',
    channel: String(ready.channel),
    type: 'token',
    nonce: String(ready.nonce),
    token: 'research.jwt.payload',
    expires_at: 1754460300,
    ...overrides,
  }
}

describe('createEmbeddedSession（REQ-EMB-01/02，契约 v0 §12）', () => {
  beforeEach(() => {
    clearResearchToken()
  })

  afterEach(() => {
    clearResearchToken()
    vi.restoreAllMocks()
  })

  it('构建后立即向精确 targetOrigin 发送 ready（携带 schema/channel/nonce）', () => {
    const h = makeHarness()
    expect(h.posted).toHaveLength(1)
    expect(h.posted[0].targetOrigin).toBe(PARENT_ORIGIN)
    expect(h.posted[0].data.schema).toBe('research-v0')
    expect(h.posted[0].data.type).toBe('ready')
    expect(String(h.posted[0].data.nonce)).toMatch(/^n_/)
    expect(String(h.posted[0].data.channel)).toMatch(/^ch_/)
    expect(h.posted[0].data.nonce).not.toBe(h.posted[0].data.channel)
  })

  it('合法 token 消息进入 authenticated，Token 只驻留内存', () => {
    const h = makeHarness()
    h.dispatch({ data: inboundMessage(h.posted[0].data) })
    expect(h.session.getState().status).toBe('authenticated')
    expect(getResearchToken()).toBe('research.jwt.payload')
    expect(getResearchTokenExpiry()).toBe(1754460300)
    // Token 不进入任何 Web Storage（REQ-EMB-02）
    expect(window.localStorage.getItem('auth-storage')).toBeNull()
    expect(window.sessionStorage.length).toBe(0)
  })

  it('refresh 替换 Token 与过期时间，状态保持 authenticated', () => {
    const h = makeHarness()
    const ready = h.posted[0].data
    h.dispatch({ data: inboundMessage(ready) })
    h.dispatch({ data: inboundMessage(ready, { type: 'refresh', token: 'jwt.2', expires_at: 1754460900 }) })
    expect(h.session.getState().status).toBe('authenticated')
    expect(getResearchToken()).toBe('jwt.2')
    expect(getResearchTokenExpiry()).toBe(1754460900)
  })

  it('error 消息进入 error 状态并携带 code/message', () => {
    const h = makeHarness()
    h.dispatch({ data: inboundMessage(h.posted[0].data, { type: 'error', code: 'bootstrap_failed', message: 'mapping unavailable' }) })
    expect(h.session.getState().status).toBe('error')
    expect(h.session.getState().errorCode).toBe('bootstrap_failed')
    expect(h.session.getState().errorMessage).toBe('mapping unavailable')
  })

  it('logout 立即清除 Token 并回到 ready（等待新 Token）', () => {
    const h = makeHarness()
    const ready = h.posted[0].data
    h.dispatch({ data: inboundMessage(ready) })
    expect(getResearchToken()).not.toBeNull()
    h.dispatch({ data: inboundMessage(ready, { type: 'logout' }) })
    expect(h.session.getState().status).toBe('ready')
    expect(getResearchToken()).toBeNull()
    expect(window.localStorage.getItem('auth-storage')).toBeNull()
  })

  it('destroy 清除 Token、移除监听并进入终态，之后不再处理任何消息', () => {
    const h = makeHarness()
    const ready = h.posted[0].data
    h.dispatch({ data: inboundMessage(ready) })
    h.dispatch({ data: inboundMessage(ready, { type: 'destroy' }) })
    expect(h.session.getState().status).toBe('destroyed')
    expect(getResearchToken()).toBeNull()
    expect(h.listeners).toHaveLength(0)
    // 销毁后再来的合法 token 也静默忽略（不产生新的状态转换）
    h.dispatch({ data: inboundMessage(ready, { token: 'jwt.after.destroy' }) })
    expect(h.session.getState().status).toBe('destroyed')
    expect(getResearchToken()).toBeNull()
    expect(h.states.map((s) => s.status)).toEqual(['ready', 'authenticated', 'destroyed'])
  })

  it('外部 destroy()（组件卸载）与 destroy 消息语义一致', () => {
    const h = makeHarness()
    const ready = h.posted[0].data
    h.dispatch({ data: inboundMessage(ready) })
    h.session.destroy()
    expect(h.session.getState().status).toBe('destroyed')
    expect(getResearchToken()).toBeNull()
    expect(h.listeners).toHaveLength(0)
  })

  it('伪造 origin/source/nonce/channel/schema 的消息一律静默：状态与 Token 不变', () => {
    const h = makeHarness()
    const ready = h.posted[0].data
    const forged = [
      inboundMessage(ready, { nonce: 'n_forged' }),
      inboundMessage(ready, { channel: 'ch_forged' }),
      inboundMessage(ready, { schema: 'research-v9' }),
      inboundMessage(ready, { type: 'hack' }),
    ]
    for (const data of forged) {
      h.dispatch({ data })
    }
    h.dispatch({ data: inboundMessage(ready), origin: 'https://evil.example.com' })
    h.dispatch({ data: inboundMessage(ready), source: 'not-the-parent' })
    expect(h.session.getState().status).toBe('ready')
    expect(getResearchToken()).toBeNull()
    expect(h.states.length).toBe(1) // 仅初始 ready 状态，无任何转换
    expect(h.posted).toHaveLength(1) // 未发送任何响应
    expect(ready.nonce).toBeTruthy()
  })

  it('Token 交付/刷新期间不写入 console 日志（REQ-EMB-02 日志无 Token）', () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const h = makeHarness()
    const ready = h.posted[0].data
    h.dispatch({ data: inboundMessage(ready) })
    h.dispatch({ data: inboundMessage(ready, { type: 'refresh', token: 'jwt.secret.2' }) })
    h.dispatch({ data: inboundMessage(ready, { type: 'logout' }) })
    const all = [...consoleSpy.mock.calls, ...warnSpy.mock.calls].map((c) => c.join(' ')).join('\n')
    expect(all).not.toContain('research.jwt.payload')
    expect(all).not.toContain('jwt.secret.2')
  })

  it('消息校验失败不落日志正文（伪造消息静默拒绝）', () => {
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const h = makeHarness()
    h.dispatch({ data: inboundMessage(h.posted[0].data), origin: 'https://evil.example.com' })
    expect(consoleSpy).not.toHaveBeenCalled()
  })
})
