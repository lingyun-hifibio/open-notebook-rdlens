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
    token: validToken(),
    expires_at: 1754460300,
    ...overrides,
  }
}

// UI-02：携带合法 claims 的 Research Token（契约 v0 §4.1）。authenticated
// 状态从此携带 projectId/role（工作台 Gateway 路径与 Owner 写/Admin 只读
// 矩阵的数据源），Token 仍只驻留内存（REQ-EMB-02）。
function validToken(claims: Record<string, unknown> = {}): string {
  const payload = {
    sub: 'user_1',
    project_id: 'proj_abc',
    role: 'owner',
    scopes: ['workspace:read', 'notes:write', 'research:run'],
    aud: 'research-workspace',
    iat: 1754460000,
    nbf: 1754460000,
    exp: 1754460300,
    jti: 'j_1',
    ...claims,
  }
  const b64 = Buffer.from(JSON.stringify(payload), 'utf-8').toString('base64url')
  return `header.${b64}.signature`
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
    expect(getResearchToken()).toBe(validToken())
    expect(getResearchTokenExpiry()).toBe(1754460300)
    // Token 不进入任何 Web Storage（REQ-EMB-02）
    expect(window.localStorage.getItem('auth-storage')).toBeNull()
    expect(window.sessionStorage.length).toBe(0)
  })

  it('refresh 替换 Token 与过期时间，状态保持 authenticated', () => {
    const h = makeHarness()
    const ready = h.posted[0].data
    h.dispatch({ data: inboundMessage(ready) })
    h.dispatch({
      data: inboundMessage(ready, {
        type: 'refresh',
        token: validToken({ project_id: 'proj_refreshed' }),
        expires_at: 1754460900,
      }),
    })
    expect(h.session.getState().status).toBe('authenticated')
    expect(getResearchToken()).toBe(validToken({ project_id: 'proj_refreshed' }))
    expect(getResearchTokenExpiry()).toBe(1754460900)
  })

  // ── UI-02：authenticated 携带 projectId/role（工作台路径与权限矩阵）──

  it('合法 token 进入 authenticated 并携带 projectId 与 role（owner）', () => {
    const h = makeHarness()
    h.dispatch({ data: inboundMessage(h.posted[0].data) })
    const state = h.session.getState()
    expect(state.status).toBe('authenticated')
    expect(state.projectId).toBe('proj_abc')
    expect(state.role).toBe('owner')
  })

  it('admin_readonly token 的角色正确透出（Admin 只读矩阵数据源）', () => {
    const h = makeHarness()
    h.dispatch({
      data: inboundMessage(h.posted[0].data, {
        token: validToken({ role: 'admin_readonly', scopes: ['workspace:read'] }),
      }),
    })
    const state = h.session.getState()
    expect(state.status).toBe('authenticated')
    expect(state.projectId).toBe('proj_abc')
    expect(state.role).toBe('admin_readonly')
  })

  it('claims 非法（非 JWT）的 token 拒绝进入 authenticated：error session_invalid', () => {
    const h = makeHarness()
    h.dispatch({ data: inboundMessage(h.posted[0].data, { token: 'garbage-token' }) })
    const state = h.session.getState()
    expect(state.status).toBe('error')
    expect(state.errorCode).toBe('session_invalid')
    expect(getResearchToken()).toBeNull()
  })

  it('claims 缺 project_id 的 token 拒绝进入 authenticated（fail-closed，不猜测路径）', () => {
    const h = makeHarness()
    const bad = validToken({ project_id: undefined, role: 'owner' })
    h.dispatch({ data: inboundMessage(h.posted[0].data, { token: bad }) })
    expect(h.session.getState().status).toBe('error')
    expect(h.session.getState().errorCode).toBe('session_invalid')
  })

  it('refresh 携带非法 claims 时进入 error，不保留旧 claims 状态', () => {
    const h = makeHarness()
    const ready = h.posted[0].data
    h.dispatch({ data: inboundMessage(ready) })
    expect(h.session.getState().projectId).toBe('proj_abc')
    h.dispatch({ data: inboundMessage(ready, { type: 'refresh', token: 'bad.jwt' }) })
    expect(h.session.getState().status).toBe('error')
    expect(h.session.getState().errorCode).toBe('session_invalid')
  })

  it('logout 清除 Token 与 projectId/role（回到 ready 等待新 Token）', () => {
    const h = makeHarness()
    const ready = h.posted[0].data
    h.dispatch({ data: inboundMessage(ready) })
    expect(h.session.getState().projectId).toBe('proj_abc')
    h.dispatch({ data: inboundMessage(ready, { type: 'logout' }) })
    const state = h.session.getState()
    expect(state.status).toBe('ready')
    expect(state.projectId).toBeUndefined()
    expect(state.role).toBeUndefined()
    expect(getResearchToken()).toBeNull()
  })

  it('destroy 后 projectId/role 清空，不留工作台上下文残留', () => {
    const h = makeHarness()
    const ready = h.posted[0].data
    h.dispatch({ data: inboundMessage(ready) })
    h.dispatch({ data: inboundMessage(ready, { type: 'destroy' }) })
    expect(h.session.getState().status).toBe('destroyed')
    expect(h.session.getState().projectId).toBeUndefined()
    expect(h.session.getState().role).toBeUndefined()
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
