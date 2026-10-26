/**
 * 研究会话运行时骨架（RDLens #602 第三批 PR-1）。
 *
 * 规范来源：DESIGN §3.2（认证代际）、§3.4（运行时所有权）、§3.6（状态图）、
 * §9.2（SessionRuntime 接口）、02_INTERFACE_FREEZE §8。
 *
 * PR-1 只交付**骨架**：
 * - 认证代际 `authGeneration` 是状态唯一来源，transport 变更不得销毁内存态；
 * - 两个表面（global/source）各自持有活动会话，指针互不覆盖；
 * - `activate` 不触发任何网络请求（显示切换与任务执行分离，I2）；
 * - `dispose('logout'|'viewer-change')` 先使写入失效再清理，之后不得再由
 *   cleanup flush 旧稿；`dispose('unmount')` 允许尽力写本机缓存；
 * - editor 控制器接线自 PR-3 起在此提供（实现见 editor-machine.ts），
 *   conversation 控制器归 PR-4；本文件只提供身份、缓存授权、
 *   MutationRecord/TransportAttempt 骨架与写入守卫。
 *
 * SSR：`createSessionRuntime` 在 render 阶段不读 `localStorage`/`window`，
 * 存储读取只发生在 `start()`/`activate()` 等事件或 effect 调用路径。
 */

import {
  degradedCapabilities,
  sessionKey,
  type ResearchSessionCapabilities,
  type ResearchSessionKind,
  type ResearchSessionRef,
} from './session-contract'
import {
  isViewerScopedCacheReadable,
  purgeViewer as purgeViewerCache,
  purgeViewerScope,
  readCandidatePointer,
  readDisplayPointer,
  readPointer,
  resolveSessionCacheStorage,
  readLatestSourcePointer,
  writeCandidatePointer,
  writeDisplayPointer,
  writePointer,
  type SessionCacheAuthority,
  type SessionCacheScope,
  type SessionCacheStorage,
  type SessionDisplayPointer,
} from './session-cache'
import {
  createEditorController,
  type EditorController,
  type EditorRuntimeView,
  type EditorTransport,
} from './editor-machine'
import {
  purgeResearchAuthScope,
  type ResearchQueryIdentity,
} from '@/lib/api/query-client'
import type { QueryClient } from '@tanstack/react-query'

/** 两个独立表面（DESIGN §3.1/§9.2；global 与 source 可同时存在）。 */
export type SessionSurface = 'global' | 'source'

export type SessionRuntimeRole = 'owner' | 'admin_readonly'

/**
 * 运行时阶段（DESIGN §3.6）：
 * locked → masked → bootstrapping → ready；token refresh → masked；
 * logout/destroy → locked；viewer 变化 → viewer_changed；403 → unauthorized。
 */
export type SessionRuntimePhase =
  | 'locked'
  | 'masked'
  | 'bootstrapping'
  | 'ready'
  | 'viewer_changed'
  | 'unauthorized'
  | 'error'

/** dispose 原因（DESIGN §3.4）。 */
export type SessionRuntimeDisposeReason = 'unmount' | 'logout' | 'viewer-change'

/** 认证作用域：`authGeneration` 来自 `SessionState.authEpoch`（显式递增，禁止派生）。 */
export interface SessionRuntimeScope {
  readonly authGeneration: number
  readonly projectId: string
  readonly viewerUserId: string | null
  readonly role: SessionRuntimeRole
}

/** bootstrap 请求（列表第一页，用于建立 viewer 与 capabilities）。 */
export interface SessionRuntimeBootstrapInput {
  readonly authGeneration: number
  readonly projectId: string
  readonly viewerUserId: string | null
  readonly role: SessionRuntimeRole
}

/**
 * bootstrap 结果。transport 不抛错而是返回判别结果，便于运行时区分
 * 403（终态不重试）与 5xx（可重试、保持遮蔽）。
 */
export type SessionRuntimeBootstrapOutcome =
  | {
      readonly status: 'ok'
      /** 服务端 `viewer_user_id`（契约整型；运行时与 claims 字符串比较）。 */
      readonly viewerUserId: string | number
      readonly capabilities: ResearchSessionCapabilities
    }
  | { readonly status: 'unauthorized'; readonly code?: string }
  | { readonly status: 'error'; readonly code?: string; readonly retryable?: boolean }

/** bootstrap 传输端口（PR-1 测试注入 mock；真实 API 接入归 PR-6）。 */
export interface SessionRuntimeTransport {
  bootstrap(input: SessionRuntimeBootstrapInput): Promise<SessionRuntimeBootstrapOutcome>
}

export interface SessionRuntimeActiveSessions {
  readonly global: ResearchSessionRef | null
  readonly source: ResearchSessionRef | null
}

/** 运行时快照（`useSyncExternalStore` 使用；引用只在状态变化时替换）。 */
export interface SessionRuntimeSnapshot {
  readonly phase: SessionRuntimePhase
  readonly authGeneration: number
  readonly projectId: string
  readonly viewerUserId: string | null
  readonly role: SessionRuntimeRole
  readonly capabilities: ResearchSessionCapabilities | null
  readonly ready: boolean
  readonly masked: boolean
  readonly unauthorized: boolean
  readonly disposed: boolean
  readonly transportWired: boolean
  readonly lastBootstrap: 'idle' | 'pending' | 'ok' | 'degraded' | 'unauthorized' | 'error'
  readonly lastErrorCode: string | null
  readonly active: SessionRuntimeActiveSessions
  /** 发生 viewer 变化时置 true 且清空旧内容；下次 bootstrap 成功后复位。 */
  readonly viewerChanged: boolean
  readonly revision: number
}

/**
 * SSR/hydration 的稳定 server snapshot：不得包含任何浏览器状态；
 * 模块级冻结常量保证 `useSyncExternalStore` 引用稳定。
 */
export const SESSION_RUNTIME_SERVER_SNAPSHOT: SessionRuntimeSnapshot = Object.freeze({
  phase: 'locked',
  authGeneration: 0,
  projectId: '',
  viewerUserId: null,
  role: 'owner',
  capabilities: null,
  ready: false,
  masked: false,
  unauthorized: false,
  disposed: false,
  transportWired: false,
  lastBootstrap: 'idle',
  lastErrorCode: null,
  active: Object.freeze({ global: null, source: null }),
  viewerChanged: false,
  revision: 0,
})

export function getSessionRuntimeServerSnapshot(): SessionRuntimeSnapshot {
  return SESSION_RUNTIME_SERVER_SNAPSHOT
}

// ---------------------------------------------------------------------------
// MutationRecord / TransportAttempt 骨架（不可变记录与传输尝试分开）
// ---------------------------------------------------------------------------

export type MutationRecordKind = 'save' | 'submission'

export type MutationRecordStatus = 'pending' | 'result-unconfirmed' | 'settled' | 'abandoned'

/**
 * 不可变持久 mutation 记录（DESIGN §3.2）：`mutation_id` + **完整请求体** +
 * 本地版本。认证刷新不重新构造请求体，也不清队列。
 */
export interface MutationRecord {
  readonly mutationId: string
  readonly kind: MutationRecordKind
  readonly sessionKey: string
  readonly ref: ResearchSessionRef
  readonly requestBody: Readonly<Record<string, unknown>>
  readonly baseRevision: number | null
  readonly draftToken: string | null
  readonly idempotencyKey: string | null
  readonly status: MutationRecordStatus
  readonly createdAt: string
}

export interface CreateMutationRecordInput {
  readonly mutationId: string
  readonly kind: MutationRecordKind
  readonly ref: ResearchSessionRef
  readonly requestBody: Readonly<Record<string, unknown>>
  readonly baseRevision?: number | null
  readonly draftToken?: string | null
  readonly idempotencyKey?: string | null
  readonly createdAt: string
}

/** 创建不可变 MutationRecord（深冻结，禁止调用方后续改写请求体）。 */
export function createMutationRecord(input: CreateMutationRecordInput): MutationRecord {
  const requestBody = deepFreeze(cloneJsonValue({ ...input.requestBody }))
  return Object.freeze({
    mutationId: input.mutationId,
    kind: input.kind,
    sessionKey: sessionKey(input.ref),
    // 身份引用与本记录一起冻结/复制：调用方改写原 ref 不得改变记录身份（review F11）。
    ref: Object.freeze({ ...input.ref }),
    requestBody,
    baseRevision: input.baseRevision ?? null,
    draftToken: input.draftToken ?? null,
    idempotencyKey: input.idempotencyKey ?? null,
    status: 'pending' as const,
    createdAt: input.createdAt,
  })
}

/** 传输尝试：每次实际派发绑定 `authGeneration`/`attemptId`（与记录本身分离）。 */
export interface TransportAttempt {
  readonly attemptId: string
  readonly mutationId: string
  readonly authGeneration: number
  readonly projectId: string
  readonly viewerUserId: string | null
  readonly sessionKey: string
  readonly dispatchState: 'not-dispatched' | 'dispatched'
  readonly createdAt: string
}

export interface CreateTransportAttemptInput {
  readonly attemptId: string
  readonly mutationId: string
  readonly scope: SessionRuntimeScope
  readonly sessionKey: string
  readonly createdAt: string
}

export function createTransportAttempt(input: CreateTransportAttemptInput): TransportAttempt {
  return Object.freeze({
    attemptId: input.attemptId,
    mutationId: input.mutationId,
    authGeneration: input.scope.authGeneration,
    projectId: input.scope.projectId,
    viewerUserId: input.scope.viewerUserId,
    sessionKey: input.sessionKey,
    dispatchState: 'not-dispatched' as const,
    createdAt: input.createdAt,
  })
}

/** 派发前标记；旧代/旧身份的尝试不得派发（DESIGN §3.2）。 */
export function markTransportAttemptDispatched(attempt: TransportAttempt): TransportAttempt {
  return Object.freeze({ ...attempt, dispatchState: 'dispatched' as const })
}

/**
 * 传输尝试是否仍属当前身份：旧代/旧 viewer/旧项目的响应必须丢弃
 * （I1/I6：迟到结果不得写入新分区）。
 */
export function transportAttemptMatches(
  attempt: TransportAttempt,
  scope: { readonly authGeneration: number; readonly projectId: string; readonly viewerUserId: string | null },
): boolean {
  return (
    attempt.authGeneration === scope.authGeneration &&
    attempt.projectId === scope.projectId &&
    attempt.viewerUserId === scope.viewerUserId
  )
}

function deepFreeze<T>(value: T): T {
  if (Array.isArray(value)) {
    value.forEach((entry) => deepFreeze(entry))
    Object.freeze(value)
    return value
  }
  if (typeof value === 'object' && value !== null) {
    Object.values(value as Record<string, unknown>).forEach((entry) => deepFreeze(entry))
    Object.freeze(value)
  }
  return value
}

/** 请求快照必须是调用后的深拷贝：调用方后续修改不得影响可重放的原请求。 */
function cloneJsonValue<T>(value: T): T {
  if (Array.isArray(value)) return value.map((entry) => cloneJsonValue(entry)) as T
  if (typeof value === 'object' && value !== null) {
    const result: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      result[key] = cloneJsonValue(entry)
    }
    return result as T
  }
  return value
}

// ---------------------------------------------------------------------------
// 写入守卫（dispose('logout'|'viewer-change') 后不得 flush 旧稿）
// ---------------------------------------------------------------------------

export interface SessionWriteGuard {
  /** 守卫来源说明（测试/诊断用）。 */
  readonly label: string
  isInvalidated(): boolean
  /** 使守卫及其后续写入失效（dispose/身份切换时由运行时调用）。 */
  invalidate(): void
  /** 写入前复核；失效立即返回 `{status:'stale'}`，执行体不会被调用。 */
  run<T>(operation: () => T): { readonly status: 'ok'; readonly value: T } | { readonly status: 'stale' }
}

interface WriteGuardState {
  invalidated: boolean
  readonly label: string
}

// ---------------------------------------------------------------------------
// 运行时
// ---------------------------------------------------------------------------

/** 编辑器控制器创建参数（PR-3；transport 由 hook 用本代际身份组装）。 */
export interface SessionEditorOptions {
  readonly transport: EditorTransport | null
  /** 文档实例 writerId；刷新/新标签/复制标签必须重新生成，禁止继承。 */
  readonly writerId?: string
  readonly storage?: SessionCacheStorage | null
}

export interface CreateSessionRuntimeOptions {
  readonly authGeneration: number
  readonly projectId: string
  readonly viewerUserId?: string | null
  readonly role: SessionRuntimeRole
  readonly queryClient?: QueryClient | null
  /** 显式注入存储（测试）；省略时在第一次使用时解析 `window.localStorage`。 */
  readonly storage?: SessionCacheStorage | null
  readonly transport?: SessionRuntimeTransport | null
  readonly now?: () => string
}

export interface SessionRuntime {
  readonly getSnapshot: () => SessionRuntimeSnapshot
  readonly subscribe: (listener: () => void) => () => void
  /** 启动 bootstrap（按 `{authGeneration, projectId, viewer}` 去重，StrictMode 安全）。 */
  readonly start: () => void
  /**
   * 重试 bootstrap：仅 error 态可用（DESIGN §3.2「5xx/网络错误可重试」）；
   * 递增尝试代际、不产生重复 bootstrap；其他阶段返回 false。
   */
  readonly retryBootstrap: () => boolean
  /** 认证代际/项目/viewer 变化；同 viewer refresh 保留内存态与活动会话。 */
  readonly updateAuth: (scope: SessionRuntimeScope) => void
  readonly setMasked: (masked: boolean) => void
  readonly dispose: (reason: SessionRuntimeDisposeReason) => void
  readonly isDisposed: () => boolean
  readonly isReady: () => boolean
  readonly isMasked: () => boolean
  readonly active: (surface: SessionSurface) => ResearchSessionRef | null
  /** 更新某表面活动会话并写该 surface 指针；ref=null 清除。不发请求。 */
  readonly activate: (surface: SessionSurface, ref: ResearchSessionRef | null) => boolean
  /** 显示模型指针写入（刷新显示权威；PR-2 使用）。 */
  readonly setDisplayPointer: (display: SessionDisplayPointer) => void
  /**
   * 取/建某会话的编辑器控制器（PR-3；DESIGN §3.4/§9.2）。
   *
   * - 每次调用创建新实例；卸载时必须调用 `releaseEditor` 释放（尽力写本机草稿）；
   * - 刷新/新标签/复制标签必须由调用方传入新的 `writerId`，禁止继承；
   * - 控制器订阅运行时变更：代际刷新保留内存态，viewer 变化/dispose 时失效。
   */
  readonly editor: (ref: ResearchSessionRef, options: SessionEditorOptions) => EditorController
  /** 释放编辑器控制器（文档实例卸载/切换）；不发服务端 cancel。 */
  readonly releaseEditor: (ref: ResearchSessionRef, controller: EditorController) => void
  /** 当前可用于查询键的身份；owner 在 viewer 确认前返回 null（enabled=false）。 */
  readonly identity: () => ResearchQueryIdentity | null
  /** viewer 分区缓存作用域；Admin 只读为 null（不读 owner 分区）。 */
  readonly cacheScope: () => SessionCacheScope | null
  /** 当前代际的缓存读取授权（旧代/未认证时不可读）。 */
  readonly cacheAuthority: () => SessionCacheAuthority | null
  readonly createWriteGuard: (label: string) => SessionWriteGuard
  /** 只在当前身份有效时执行回调（迟到回调/定时器守卫）。 */
  readonly runIfCurrent: <T>(generation: number, operation: () => T) => { readonly status: 'ok'; readonly value: T } | { readonly status: 'stale' }
  readonly now: () => string
}

interface MutableState {
  scope: SessionRuntimeScope
  phase: SessionRuntimePhase
  masked: boolean
  capabilities: ResearchSessionCapabilities | null
  lastBootstrap: SessionRuntimeSnapshot['lastBootstrap']
  lastErrorCode: string | null
  active: { global: ResearchSessionRef | null; source: ResearchSessionRef | null }
  viewerChanged: boolean
  disposed: boolean
  started: boolean
  bootstrapAttemptId: number
}

export function createSessionRuntime(options: CreateSessionRuntimeOptions): SessionRuntime {
  const now = options.now ?? (() => new Date().toISOString())
  const listeners = new Set<() => void>()
  const guards = new Set<WriteGuardState>()
  let transport = options.transport ?? null
  const queryClient = options.queryClient ?? null
  let confirmedViewerUserId: string | null = options.viewerUserId ?? null
  // 只有 bootstrap 成功（服务端 list 确认 viewer）后才允许读 viewer 分区；
  // 未接线/遮蔽/旧代时不得把 claims 当成确认结果（DESIGN §3.2/§3.5）。
  let viewerConfirmed = false
  // 外部遮蔽（shell error 态等）与运行时内部遮蔽分开记录：bootstrap 成功
  // 不得吞掉外部遮蔽要求（review F5）。
  let maskedExternally = false
  // 服务端 viewer 与 claims viewer 不一致后、重新确认前，不得按任一 viewer
  // 清理本机分区（review F9）。
  let viewerMismatch = false

  const state: MutableState = {
    scope: {
      authGeneration: options.authGeneration,
      projectId: options.projectId,
      viewerUserId: options.viewerUserId ?? null,
      role: options.role,
    },
    phase: options.viewerUserId ? 'masked' : 'locked',
    masked: false,
    capabilities: null,
    lastBootstrap: 'idle',
    lastErrorCode: null,
    active: { global: null, source: null },
    viewerChanged: false,
    disposed: false,
    started: false,
    bootstrapAttemptId: 0,
  }

  let revision = 0
  let snapshot = buildSnapshot()

  function buildSnapshot(): SessionRuntimeSnapshot {
    return Object.freeze({
      phase: state.phase,
      authGeneration: state.scope.authGeneration,
      projectId: state.scope.projectId,
      viewerUserId: state.scope.viewerUserId,
      role: state.scope.role,
      capabilities: state.capabilities,
      ready: state.phase === 'ready',
      // DESIGN §3.2：bootstrap 5xx/网络错误保持遮蔽；error 阶段即使外部
      // 已经解除 masked prop，也不得显示为未遮蔽（Lead F-M1）。
      masked:
        state.masked ||
        state.phase === 'masked' ||
        state.phase === 'bootstrapping' ||
        state.phase === 'error' ||
        state.phase === 'unauthorized',
      unauthorized: state.phase === 'unauthorized',
      disposed: state.disposed,
      transportWired: transport !== null,
      lastBootstrap: state.lastBootstrap,
      lastErrorCode: state.lastErrorCode,
      active: Object.freeze({ global: state.active.global, source: state.active.source }),
      viewerChanged: state.viewerChanged,
      revision,
    })
  }

  function commit(): void {
    revision += 1
    snapshot = buildSnapshot()
    for (const listener of [...listeners]) listener()
  }

  function storage(): SessionCacheStorage | null {
    return options.storage !== undefined ? options.storage : resolveSessionCacheStorage()
  }

  function cacheScopeInternal(): SessionCacheScope | null {
    // Admin 只读不得读取 owner 本机分区（DESIGN §3.2）。
    if (state.scope.role !== 'owner') return null
    const viewer = confirmedViewerUserId ?? state.scope.viewerUserId
    if (!viewer || !state.scope.projectId) return null
    return { viewerUserId: viewer, projectId: state.scope.projectId }
  }

  function cacheAuthorityInternal(): SessionCacheAuthority | null {
    // 读取授权只在「已认证且 viewer 已由服务端确认、当前代、未遮蔽、未 dispose」
    // 时发放；Admin 不读 owner 分区。
    if (state.disposed || state.phase !== 'ready' || state.scope.role !== 'owner') return null
    if (!viewerConfirmed || confirmedViewerUserId === null) return null
    return {
      authenticatedViewerUserId: confirmedViewerUserId,
      projectId: state.scope.projectId,
      authGeneration: state.scope.authGeneration,
      currentAuthGeneration: state.scope.authGeneration,
    }
  }

  function currentIdentity(): ResearchQueryIdentity | null {
    if (state.disposed || state.phase !== 'ready') return null
    const { role, projectId, authGeneration } = state.scope
    if (role === 'owner') {
      if (!viewerConfirmed || confirmedViewerUserId === null) return null
      return { role: 'owner', projectId, authGeneration, viewerUserId: confirmedViewerUserId }
    }
    return { role: 'admin_readonly', projectId, authGeneration }
  }

  function invalidateGuards(): void {
    for (const guard of guards) guard.invalidated = true
  }

  function restoreActiveFromCache(): void {
    const scope = cacheScopeInternal()
    if (!scope) return
    const authority = cacheAuthorityInternal()
    if (!authority) return
    const display = readDisplayPointer(scope, authority, { storage: storage() })
    const globalPointer = readPointer(scope, authority, 'global', null, { storage: storage() })
    const displayGlobal = display?.surface === 'global' ? display.ref : null
    const global = displayGlobal ?? globalPointer?.ref ?? null
    // 两个 surface 各自从自己的指针恢复；display 只决定显示哪个 surface，
    // 不得让另一 surface 丢失（DESIGN §4.5）。
    // display 已钉住具体 source 时不得跨 source 回退（review N3：显示 source 与
    // 活动会话身份必须一致）。仅在 display 未指向 source 时才用最近 source 指针。
    const source = display?.surface === 'source'
      ? (display.ref ??
        readPointer(scope, authority, 'source', display.sourceId, { storage: storage() })?.ref ??
        null)
      : (readLatestSourcePointer(scope, authority, { storage: storage() })?.ref ?? null)
    if (global !== null && global.kind !== 'global') return
    if (source !== null && source.kind !== 'source') return
    state.active = { global, source }
  }

  function purgeQueryCaches(projectId: string, keep: ResearchQueryIdentity | null): void {
    if (!queryClient) return
    void purgeResearchAuthScope(queryClient, { projectId, current: keep }).catch(() => {
      // 清理失败不阻断认证切换；旧代请求仍被代际守卫丢弃。
    })
  }

  function start(): void {
    if (state.disposed || state.started) return
    state.started = true
    state.masked = maskedExternally
    if (transport === null) {
      // 未接线（PR-1）：不伪装真实接入。Admin artifacts 只读不依赖 Chat
      // bootstrap，可保持 ready；owner 在服务端确认 viewer 前必须保持遮蔽，
      // 不发放本机缓存读取授权。
      state.lastBootstrap = 'degraded'
      state.capabilities = degradedCapabilities('missing')
      state.viewerChanged = false
      if (state.scope.role === 'admin_readonly') {
        state.masked = maskedExternally
        state.phase = maskedExternally ? 'masked' : 'ready'
      } else {
        state.masked = maskedExternally
        state.phase = 'masked'
      }
      commit()
      return
    }
    runBootstrapAttempt()
  }

  /** 发起一次 bootstrap 尝试；调用方负责 started/遮蔽等前置状态。 */
  function runBootstrapAttempt(): void {
    if (transport === null) return
    const attemptId = ++state.bootstrapAttemptId
    const captured = {
      authGeneration: state.scope.authGeneration,
      projectId: state.scope.projectId,
      viewerUserId: state.scope.viewerUserId,
      role: state.scope.role,
    }
    // 每次尝试在成功前都不得沿用上一代/上一次的 viewer 确认（review R3）：
    // 否则新代 bootstrap 失败后 setMasked(false) 会带着旧确认回到 ready 并
    // 重新发放本机分区授权。
    viewerConfirmed = false
    state.phase = 'bootstrapping'
    state.lastBootstrap = 'pending'
    state.lastErrorCode = null
    commit()
    runBootstrapOutcome(attemptId, captured)
  }

  function runBootstrapOutcome(
    attemptId: number,
    captured: {
      readonly authGeneration: number
      readonly projectId: string
      readonly viewerUserId: string | null
      readonly role: SessionRuntimeRole
    },
  ): void {
    if (transport === null) return
    let outcome: Promise<SessionRuntimeBootstrapOutcome>
    try {
      outcome = transport.bootstrap(captured)
    } catch (error) {
      state.phase = 'error'
      state.lastBootstrap = 'error'
      state.lastErrorCode = error instanceof Error ? error.name : 'bootstrap_failed'
      commit()
      return
    }
    void outcome.then(
      (result) => {
        if (state.disposed || attemptId !== state.bootstrapAttemptId) return
        if (
          captured.authGeneration !== state.scope.authGeneration ||
          captured.projectId !== state.scope.projectId
        ) {
          return
        }
        if (result.status === 'unauthorized') {
          state.phase = 'unauthorized'
          state.lastBootstrap = 'unauthorized'
          state.lastErrorCode = result.code ?? 'chat_owner_required'
          commit()
          return
        }
        if (result.status === 'error') {
          state.phase = 'error'
          state.lastBootstrap = 'error'
          state.lastErrorCode = result.code ?? 'bootstrap_failed'
          commit()
          return
        }
        const serverViewer = String(result.viewerUserId)
        const expectedViewer = state.scope.viewerUserId
        if (expectedViewer !== null && serverViewer !== expectedViewer) {
          // viewer 变化：立即遮蔽并清除旧 viewer 内容，等待下一次认证消息重新
          // bootstrap。必须先捕获旧分区再改 confirmedViewer，且不得清掉新
          // viewer 自己的恢复数据。
          const staleScope = cacheScopeInternal()
          confirmedViewerUserId = serverViewer
          viewerConfirmed = false
          viewerMismatch = true
          state.phase = 'viewer_changed'
          state.masked = true
          state.viewerChanged = true
          state.capabilities = null
          state.active = { global: null, source: null }
          invalidateGuards()
          if (staleScope) purgeViewerScope(staleScope, { storage: storage() })
          purgeQueryCaches(state.scope.projectId, null)
          commit()
          return
        }
        confirmedViewerUserId = serverViewer
        viewerConfirmed = true
        viewerMismatch = false
        state.capabilities = result.capabilities
        // 外部遮蔽（shell error 态）仍在时不得因 bootstrap 成功解除遮蔽（review F5）。
        state.masked = maskedExternally
        state.phase = maskedExternally ? 'masked' : 'ready'
        state.lastBootstrap = result.capabilities.degraded ? 'degraded' : 'ok'
        state.lastErrorCode = null
        state.viewerChanged = false
        if (!maskedExternally) restoreActiveFromCache()
        commit()
      },
      (error: unknown) => {
        if (state.disposed || attemptId !== state.bootstrapAttemptId) return
        state.phase = 'error'
        state.lastBootstrap = 'error'
        state.lastErrorCode = error instanceof Error ? error.name : 'bootstrap_failed'
        commit()
      },
    )
  }

  function retryBootstrap(): boolean {
    if (state.disposed || transport === null) return false
    if (state.phase !== 'error') return false
    state.started = true
    state.masked = maskedExternally
    runBootstrapAttempt()
    return true
  }

  function dispose(reason: SessionRuntimeDisposeReason): void {
    if (state.disposed) return
    if (reason === 'unmount') {
      // 卸载：尽力写本机草稿（此时缓存授权仍有效），但不写服务端、不发 cancel。
      for (const { controller } of editors.values()) controller.releaseDocument()
      editors.clear()
      releasedEditors.clear()
    }
    const scope = cacheScopeInternal()
    state.disposed = true
    state.started = false
    viewerConfirmed = false
    state.bootstrapAttemptId += 1
    state.phase = 'locked'
    state.masked = false
    state.active = { global: null, source: null }
    state.viewerChanged = false
    if (reason !== 'unmount') {
      // 先使写入失效，再清理本机分区（清理后不得再由 cleanup flush 旧稿）。
      invalidateGuards()
      for (const { controller } of editors.values()) {
        controller.invalidate(reason === 'logout' ? 'logout' : 'viewer-change')
      }
      for (const controller of releasedEditors) {
        controller.invalidate(reason === 'logout' ? 'logout' : 'viewer-change')
      }
      editors.clear()
      releasedEditors.clear()
      // 服务端 viewer 与 claims 不一致且尚未重新确认时，按任一 viewer 清理
      // 都可能误删对方恢复数据（review F9）；旧 viewer 已在 mismatch 时清理。
      if (scope && !viewerMismatch) purgeViewerScope(scope, { storage: storage() })
      purgeQueryCaches(state.scope.projectId, null)
    }
    maskedExternally = false
    commit()
  }

  function updateAuth(next: SessionRuntimeScope): void {
    if (state.disposed) return
    const previous = state.scope
    const sameScope =
      previous.authGeneration === next.authGeneration &&
      previous.projectId === next.projectId &&
      previous.viewerUserId === next.viewerUserId &&
      previous.role === next.role
    if (sameScope) return
    const viewerChanged =
      next.viewerUserId !== null && next.viewerUserId !== (confirmedViewerUserId ?? previous.viewerUserId)
    const generationChanged = previous.authGeneration !== next.authGeneration
    const projectChanged = previous.projectId !== next.projectId
    const previousProject = previous.projectId
    state.scope = {
      authGeneration: next.authGeneration,
      projectId: next.projectId,
      viewerUserId: next.viewerUserId,
      role: next.role,
    }
    if (viewerChanged) {
      // 换人：旧内容立即清除，本机分区按新 viewer 重新确认。
      invalidateGuards()
      confirmedViewerUserId = null
      viewerConfirmed = false
      state.phase = 'masked'
      state.masked = true
      state.active = { global: null, source: null }
      state.capabilities = null
      state.viewerChanged = true
      state.started = false
      const oldScope =
        previous.projectId && previous.viewerUserId
          ? { viewerUserId: previous.viewerUserId, projectId: previous.projectId }
          : null
      // 旧 viewer 的编辑器快照（文本/token/锚点）必须立即清除，不能等后续 dispose
      // 才清理（review3 P1：一次 viewer-change 后旧快照仍可读到敏感文本）。
      for (const { controller } of editors.values()) controller.invalidate('viewer-change')
      for (const controller of releasedEditors) controller.invalidate('viewer-change')
      editors.clear()
      releasedEditors.clear()
      if (oldScope) purgeViewerScope(oldScope, { storage: storage() })
      // 新 viewer 自己的本机恢复数据不得在确认前被误删。
      purgeQueryCaches(previousProject, null)
      if (projectChanged && previousProject !== next.projectId) {
        purgeQueryCaches(next.projectId, null)
      }
    } else if (generationChanged || projectChanged) {
      // 同 viewer refresh：保留 editor store/内存 dirty/可见消息，只换 transport 代际；
      // 新代际仍需重新 bootstrap 确认 viewer 后才恢复缓存读取授权。
      if (projectChanged) viewerConfirmed = false
      state.phase = 'masked'
      state.masked = true
      state.started = false
      const keep = confirmedViewerUserId && !projectChanged ? currentIdentityForGeneration() : null
      purgeQueryCaches(previousProject, keep)
      if (projectChanged) {
        state.active = { global: null, source: null }
        state.capabilities = null
      }
    }
    state.lastBootstrap = 'idle'
    state.lastErrorCode = null
    commit()
    start()
  }

  function currentIdentityForGeneration(): ResearchQueryIdentity | null {
    const { role, projectId, authGeneration } = state.scope
    if (role === 'owner') {
      const viewer = confirmedViewerUserId ?? state.scope.viewerUserId
      if (!viewer) return null
      return { role: 'owner', projectId, authGeneration, viewerUserId: viewer }
    }
    return { role: 'admin_readonly', projectId, authGeneration }
  }

  function setMasked(masked: boolean): void {
    if (state.disposed) return
    if (maskedExternally === masked && state.masked === masked) return
    maskedExternally = masked
    state.masked = masked
    if (masked) {
      // 只叠加显示门禁，不覆盖已有 bootstrap 结果（error/unauthorized/
      // bootstrapping 阶段保持原状；review R3）。
      if (state.phase === 'ready' || state.phase === 'masked') state.phase = 'masked'
    } else if (state.phase === 'masked') {
      // 仅“单纯被外部遮蔽”的 masked 阶段可恢复；error 等失败阶段必须等
      // retryBootstrap 成功才能离开（DESIGN §3.2，review R3）。
      state.phase = viewerConfirmed ? 'ready' : 'bootstrapping'
      if (state.phase === 'ready') restoreActiveFromCache()
    }
    commit()
  }

  function active(surface: SessionSurface): ResearchSessionRef | null {
    return state.active[surface]
  }

  function activate(surface: SessionSurface, ref: ResearchSessionRef | null): boolean {
    if (state.disposed) return false
    if (ref !== null) {
      if (ref.projectId !== state.scope.projectId || ref.kind !== surface) return false
      if (surface === 'global' && ref.sourceId !== null) return false
      if (surface === 'source' && !ref.sourceId) return false
    }
    state.active = { ...state.active, [surface]: ref }
    const scope = cacheScopeInternal()
    if (scope) {
      const authority = cacheAuthorityInternal()
      if (!authority || !isViewerScopedCacheReadable(scope, authority)) {
        commit()
        return true
      }
      writePointer(scope, surface, ref?.sourceId ?? null, ref, now(), { storage: storage() })
      if (ref !== null) {
        writeCandidatePointer(scope.projectId, ref, now(), { storage: storage() })
      }
    }
    commit()
    return true
  }

  function setDisplayPointer(display: SessionDisplayPointer): void {
    const scope = cacheScopeInternal()
    if (!scope) return
    const authority = cacheAuthorityInternal()
    if (!authority || !isViewerScopedCacheReadable(scope, authority)) return
    writeDisplayPointer(scope, display, { storage: storage() })
  }

  // ── 编辑器控制器注册表（PR-3；实现见 editor-machine.ts） ──

  /**
   * 同一会话的多个消费者（面板 + composer，PR-4/PR-5b）共享同一控制器；
   * 引用计数归零时释放文档（尽力写本机草稿）。writerId 由首个消费者决定。
   */
  const editors = new Map<string, { controller: EditorController; refs: number }>()
  // 引用归零后仍保留最近释放的 controller，使 logout/viewer-change 能清理其敏感快照
  // （二次 review N12）；容量有界，避免长会话无界增长。
  const releasedEditors = new Set<EditorController>()
  let attemptSequence = 0

  function editorRuntimeView(): EditorRuntimeView {
    return {
      authGeneration: state.scope.authGeneration,
      projectId: state.scope.projectId,
      viewerUserId: confirmedViewerUserId ?? state.scope.viewerUserId ?? null,
      phase: state.phase,
      ready: state.phase === 'ready',
      editorReady: state.capabilities === null ? undefined : state.capabilities.editorReady,
      disposed: state.disposed,
      viewerChanged: state.viewerChanged,
    }
  }

  function editor(ref: ResearchSessionRef, options: SessionEditorOptions): EditorController {
    const key = sessionKey(ref)
    const existing = editors.get(key)
    if (existing !== undefined) {
      existing.refs += 1
      return existing.controller
    }
    const controller = createEditorController({
      ref,
      writerId: options.writerId,
      transport: state.disposed ? null : options.transport,
      storage: options.storage,
      getRuntimeView: editorRuntimeView,
      subscribeRuntime: (listener: () => void) => {
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
        }
      },
      createWriteGuard,
      mutations: {
        createMutationRecord,
        createTransportAttempt: (input) => {
          attemptSequence += 1
          return createTransportAttempt({
            ...input,
            attemptId: `a${attemptSequence}`,
            scope: { ...input.scope, role: state.scope.role },
          })
        },
        markTransportAttemptDispatched,
        transportAttemptMatches,
      },
      getCacheScope: cacheScopeInternal,
      getCacheAuthority: cacheAuthorityInternal,
      now,
    })
    editors.set(key, { controller, refs: 1 })
    if (state.disposed) controller.invalidate('logout')
    return controller
  }

  function releaseEditor(ref: ResearchSessionRef, controller: EditorController): void {
    const key = sessionKey(ref)
    const entry = editors.get(key)
    if (entry === undefined || entry.controller !== controller) return
    entry.refs -= 1
    if (entry.refs > 0) return
    // 还有未决 mutation 的控制器不得直接丢弃：保留注册项（refs=0），
    // 同一会话的新消费者必须复用它，避免为同一会话并发两个不同 mutation（review3 N5）。
    if (entry.controller.hasPendingWork()) return
    editors.delete(key)
    entry.controller.releaseDocument()
    releasedEditors.add(entry.controller)
    if (releasedEditors.size > 8) {
      const oldest = releasedEditors.values().next()
      if (!oldest.done) {
        // 被淘汰出清理窗口的控制器必须先作废敏感快照，否则 logout/viewer-change
        // 再也无法覆盖它（review3 P1）。
        oldest.value.invalidate('logout')
        releasedEditors.delete(oldest.value)
      }
    }
  }

  function createWriteGuard(label: string): SessionWriteGuard {
    const guard: WriteGuardState = { invalidated: state.disposed, label }
    guards.add(guard)
    return {
      label,
      isInvalidated: () => guard.invalidated,
      invalidate: () => {
        guard.invalidated = true
      },
      run: <T>(operation: () => T) => {
        if (guard.invalidated) return { status: 'stale' as const }
        return { status: 'ok' as const, value: operation() }
      },
    }
  }

  function runIfCurrent<T>(
    generation: number,
    operation: () => T,
  ): { readonly status: 'ok'; readonly value: T } | { readonly status: 'stale' } {
    if (state.disposed || state.scope.authGeneration !== generation) {
      return { status: 'stale' as const }
    }
    return { status: 'ok' as const, value: operation() }
  }

  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    start,
    retryBootstrap,
    updateAuth,
    setMasked,
    dispose,
    isDisposed: () => state.disposed,
    isReady: () => state.phase === 'ready',
    isMasked: () => snapshot.masked,
    active,
    activate,
    setDisplayPointer,
    editor,
    releaseEditor,
    identity: () => currentIdentity(),
    cacheScope: () => cacheScopeInternal(),
    cacheAuthority: () => cacheAuthorityInternal(),
    createWriteGuard,
    runIfCurrent,
    now,
  }
}
