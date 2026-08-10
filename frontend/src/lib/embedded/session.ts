/**
 * 嵌入式安全会话状态机（UI-01，设计 §4.1/§4.2；REQ-AUTH-02/REQ-EMB-01/02，
 * 契约 v0 §12）。
 *
 * 生命周期：构建 → 生成会话 nonce/channel → 向父页面精确 targetOrigin
 * 发送 `ready`（携带 schema/channel/nonce）→ 等待父页面 `token` →
 * `authenticated`。父页面驱动：`token`/`refresh`/`error`/`logout`/`destroy`。
 *
 * 安全规则：
 * - 每条入站消息经 `validateIncomingMessage` 五要素校验（origin / window
 *   source / schema / nonce / channel），伪造消息**静默丢弃**：不响应、
 *   不转换状态、不落日志正文。
 * - Token 只写 `token-store` 内存（REQ-EMB-02）；日志/指标不得包含 Token。
 * - `logout` 清除 Token 回到 `ready`；`destroy` 清除 Token、移除监听、
 *   进入终态 `destroyed`，之后不再接受任何消息。
 */

import {
  validateIncomingMessage,
  type PmErrorCode,
  type ValidatedInboundMessage,
} from './messages'
import {
  clearResearchToken,
  setResearchToken,
} from './token-store'

export type SessionStatus = 'booting' | 'ready' | 'authenticated' | 'error' | 'destroyed'

export interface SessionState {
  status: SessionStatus
  errorCode?: PmErrorCode
  errorMessage?: string
  tokenExpiresAt?: number
}

export interface EmbeddedSessionOptions {
  /** 父页面精确 origin 白名单（五要素 origin 绑定） */
  allowedOrigins: readonly string[]
  /** postMessage targetOrigin（ready 使用精确 targetOrigin） */
  parentOrigin: string
  /** 期望的父窗口引用（event.source 校验）；默认 window.parent */
  expectedSource?: Window | null
  /** 测试注入：postMessage 发送；默认 window.parent.postMessage */
  post?: (data: unknown, targetOrigin: string) => void
  /** 测试注入：注册 message 监听；默认 window.addEventListener */
  addListener?: (handler: (event: MessageEvent) => void) => void
  /** 测试注入：移除 message 监听；默认 window.removeEventListener */
  removeListener?: (handler: (event: MessageEvent) => void) => void
}

export interface EmbeddedSession {
  getState(): SessionState
  subscribe(listener: (state: SessionState) => void): () => void
  /** 清除 Token、移除监听、进入终态（组件卸载或 destroy 消息） */
  destroy(): void
}

function randomId(prefix: string): string {
  const bytes = new Uint8Array(16)
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(bytes)
  } else {
    for (let i = 0; i < bytes.length; i += 1) {
      bytes[i] = Math.floor(Math.random() * 256)
    }
  }
  return prefix + Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

export function createEmbeddedSession(options: EmbeddedSessionOptions): EmbeddedSession {
  const nonce = randomId('n_')
  const channel = randomId('ch_')
  const expectedSource = options.expectedSource !== undefined
    ? options.expectedSource
    : (typeof window !== 'undefined' ? window.parent : null)
  const post = options.post ?? ((data, targetOrigin) => window.parent.postMessage(data, targetOrigin))
  const addListener = options.addListener ?? ((handler) => window.addEventListener('message', handler))
  const removeListener = options.removeListener ?? ((handler) => window.removeEventListener('message', handler))

  let state: SessionState = { status: 'booting' }
  const listeners = new Set<(state: SessionState) => void>()
  let destroyed = false

  function setState(next: SessionState): void {
    state = next
    for (const listener of listeners) {
      listener(state)
    }
  }

  function handleMessage(message: ValidatedInboundMessage): void {
    switch (message.type) {
      case 'token':
      case 'refresh':
        // 首次交付或过期前刷新：替换内存 Token（REQ-EMB-02）
        setResearchToken(message.token, message.expiresAt)
        setState({ status: 'authenticated', tokenExpiresAt: message.expiresAt })
        break
      case 'error':
        // bootstrap/刷新失败：不清除既有 Token（过期前仍有效，父页面会重试刷新）
        setState({
          status: 'error',
          errorCode: message.code,
          errorMessage: message.message,
        })
        break
      case 'logout':
        // 立即清除 Token 与内存状态，回到等待状态
        clearResearchToken()
        setState({ status: 'ready' })
        break
      case 'destroy':
        destroy()
        break
    }
  }

  function onMessage(event: MessageEvent): void {
    if (destroyed) {
      return
    }
    const validated = validateIncomingMessage(event.data, {
      origin: event.origin,
      sourceMatches: event.source === expectedSource,
      allowedOrigins: options.allowedOrigins,
      nonce,
      channel,
    })
    if (validated === null) {
      // 伪造/非法消息：静默拒绝，不响应、不落日志
      return
    }
    handleMessage(validated)
  }

  addListener(onMessage)

  // ready 握手：精确 targetOrigin；nonce/channel 由本会话生成并由父页面回显
  post(
    { schema: 'research-v0', channel, type: 'ready', nonce },
    options.parentOrigin,
  )
  setState({ status: 'ready' })

  function destroy(): void {
    if (destroyed) {
      return
    }
    destroyed = true
    removeListener(onMessage)
    clearResearchToken()
    setState({ status: 'destroyed' })
  }

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener)
      // 立即回放当前状态（订阅即快照）
      listener(state)
      return () => {
        listeners.delete(listener)
      }
    },
    destroy,
  }
}
