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
import {
  decodeResearchClaims,
  type ResearchRole,
} from './claims'

export type SessionStatus = 'booting' | 'ready' | 'authenticated' | 'error' | 'destroyed'

export interface SessionState {
  status: SessionStatus
  /**
   * 认证代际（单调递增；DESIGN §3.2）：每条 `token`/`refresh` 消息处理成功
   * 都 +1（同一 token 重发也算），`logout`/`destroy` 也 +1。不得从
   * `tokenExpiresAt`/`projectId`/effect 派生——刷新后它必须可观察地变化，
   * 否则旧代响应无法与新一代区分。
   */
  authEpoch: number
  errorCode?: PmErrorCode
  errorMessage?: string
  tokenExpiresAt?: number
  /** Token subject; only used to namespace browser-local Research Scope state. */
  userId?: string
  /** UI-02：Token claims 中的项目 ID（工作台 Gateway 路径；服务端权威） */
  projectId?: string
  /** UI-02：Owner 写 / Admin 只读矩阵数据源（设计 §4.4） */
  role?: ResearchRole
  /** RWV2-50：父页下发的解析主题；仅 authenticated 态存续，离开即清 */
  embeddedTheme?: 'light' | 'dark'
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
  /** PR5（D1）：请求宿主打开「添加资料」入库对话框 */
  requestIngest(): void
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

  let state: SessionState = { status: 'booting', authEpoch: 0 }
  let authEpoch = 0
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
      case 'refresh': {
        // UI-02：claims 解码 fail-closed——无法确定项目/角色时拒绝
        // authenticated，不驻留 Token，工作台不猜测 Gateway 路径或权限
        // （契约 v0 §4.1；设计 §4.4）。签名/权威校验仍在 Gateway。
        const claims = decodeResearchClaims(message.token)
        if (claims === null) {
          // session_invalid 属于“令牌不可信”：立即清空身份（§3.2 清空分支），
          // 并推进代际使旧代请求/回调一律失效。
          clearResearchToken()
          authEpoch += 1
          setState({
            status: 'error',
            errorCode: 'session_invalid',
            errorMessage: 'research token claims are invalid',
            authEpoch,
          })
          break
        }
        // 首次交付或过期前刷新：替换内存 Token（REQ-EMB-02）。
        // 每条成功 token/refresh（含同 token 重发）都推进 authEpoch：
        // 新代 transport 与旧代在途回调据此区分。
        setResearchToken(message.token, message.expiresAt)
        authEpoch += 1
        setState({
          status: 'authenticated',
          authEpoch,
          tokenExpiresAt: message.expiresAt,
          userId: claims.userId,
          projectId: claims.projectId,
          role: claims.role,
          // RWV2-50：Token 刷新不抹掉已应用主题（仅 authenticated 前态携带）
          embeddedTheme: state.status === 'authenticated' ? state.embeddedTheme : undefined,
        })
        break
      }
      case 'error':
        // bootstrap/刷新失败：不清除既有 Token（过期前仍有效，父页面重试刷新）。
        // 若此前已认证成功，显式保留最后身份（projectId/role/userId）供 shell
        // 维持 Provider 挂载并遮蔽（DESIGN §3.2）；从未认证过则保持空白错误页。
        setState({
          status: 'error',
          authEpoch,
          errorCode: message.code,
          errorMessage: message.message,
          ...(state.userId !== undefined
            ? {
                tokenExpiresAt: state.tokenExpiresAt,
                userId: state.userId,
                projectId: state.projectId,
                role: state.role,
                embeddedTheme: state.embeddedTheme,
              }
            : {}),
        })
        break
      case 'logout':
        // 立即清除 Token 与内存状态，回到等待状态；代际 +1 使旧代全部失效。
        clearResearchToken()
        authEpoch += 1
        setState({ status: 'ready', authEpoch })
        break
      case 'destroy':
        destroy()
        break
      case 'theme':
        // RWV2-50：父页主题仅在 authenticated 后应用（fail-closed）；
        // 未认证时忽略——父页在每次成功 token 交付后重放当前主题。
        // 同值消息跳过：父页重放（bind/refresh）与手动切换可能重复同值，
        // 会话层去重避免向 shell 推冗余通知（store 侧另有 early-return）。
        if (state.status === 'authenticated' && state.embeddedTheme !== message.theme) {
          setState({ ...state, embeddedTheme: message.theme })
        }
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
  setState({ status: 'ready', authEpoch })

  function destroy(): void {
    if (destroyed) {
      return
    }
    destroyed = true
    removeListener(onMessage)
    clearResearchToken()
    authEpoch += 1
    setState({ status: 'destroyed', authEpoch })
  }

  /**
   * PR5（D1/D-06）：请求宿主打开入库对话框（无载荷；project_id 由宿主路由
   * 决定）。未绑定/已销毁时静默忽略（宿主在握手前也不接受）。
   */
  function requestIngest(): void {
    post({ schema: 'research-v0', channel, type: 'open_ingest' }, options.parentOrigin)
  }

  return {
    requestIngest,
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
