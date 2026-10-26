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
 * - 不含 editor/conversation 控制器（归 PR-3/PR-4），只提供身份、缓存授权、
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
  writeCandidatePointer,
  writeDisplayPointer,
  writePointer,
  type SessionCacheAuthority,
  type SessionCacheScope,
  type SessionCacheStorage,
  type SessionDisplayPointer,
} from './session-cache'
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
  const requestBody = deepFreeze({ ...input.requestBody })
  return Object.freeze({
    mutationId: input.mutationId,
    kind: input.kind,
    sessionKey: sessionKey(input.ref),
    ref: input.ref,
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
    return value
  }
  if (typeof value === 'object' && value !== null) {
    Object.values(value as Record<string, unknown>).forEach((entry) => deepFreeze(entry))
    Object.freeze(value)
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
  /** 当前可用于查询键的身份；owner 在 viewer 确认前返回 null（enabled=false）。 */
  readonly identity: () => ResearchQueryIdentity | null
  /** viewer 分区缓存作用域；Admin 只读为 null（不读 owner 分区）。 */
  readonly cacheScope: () => SessionCacheScope | null
  /** 当前代际的缓存读取授权（旧代/未认证时不可读）。 */
  readonly cacheAuthority: () => SessionCacheAuthority
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
      masked: state.masked || state.phase === 'masked' || state.phase === 'bootstrapping',
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

  function cacheAuthorityInternal(): SessionCacheAuthority {
    return {
      authenticatedViewerUserId: confirmedViewerUserId ?? state.scope.viewerUserId,
      projectId: state.scope.projectId,
      authGeneration: state.scope.authGeneration,
      currentAuthGeneration: state.scope.authGeneration,
    }
  }

  function currentIdentity(): ResearchQueryIdentity | null {
    if (state.disposed || state.phase !== 'ready') return null
    const { role, projectId, authGeneration } = state.scope
    if (role === 'owner') {
      const viewer = confirmedViewerUserId ?? state.scope.viewerUserId
      if (!viewer) return null
      return { role: 'owner', projectId, authGeneration, viewerUserId: viewer }
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
    const display = readDisplayPointer(scope, authority, { storage: storage() })
    const globalPointer = readPointer(scope, authority, 'global', null, { storage: storage() })
    const displayGlobal = display?.surface === 'global' ? display.ref : null
    const global = displayGlobal ?? globalPointer?.ref ?? null
    let source: ResearchSessionRef | null = null
    if (display?.surface === 'source') {
      source =
        display.ref ??
        readPointer(scope, authority, 'source', display.sourceId, { storage: storage() })?.ref ??
        null
    }
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
    state.masked = true
    if (transport === null) {
      // 未接线（PR-1）：保留只读降级能力，不伪装真实接入；无 bootstrap
      // 端口时 viewer 以 claims 为准（identity 可用），因此不处于遮蔽态。
      state.masked = false
      state.phase = 'ready'
      state.lastBootstrap = 'degraded'
      state.capabilities = degradedCapabilities('missing')
      state.viewerChanged = false
      restoreActiveFromCache()
      commit()
      return
    }
    const attemptId = ++state.bootstrapAttemptId
    const captured = {
      authGeneration: state.scope.authGeneration,
      projectId: state.scope.projectId,
      viewerUserId: state.scope.viewerUserId,
      role: state.scope.role,
    }
    state.phase = 'bootstrapping'
    state.lastBootstrap = 'pending'
    state.lastErrorCode = null
    commit()
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
          // viewer 变化：立即遮蔽并清除旧内容，等待下一次认证消息重新 bootstrap。
          confirmedViewerUserId = serverViewer
          state.phase = 'viewer_changed'
          state.masked = true
          state.viewerChanged = true
          state.capabilities = null
          state.active = { global: null, source: null }
          invalidateGuards()
          const staleScope = cacheScopeInternal()
          if (staleScope) purgeViewerScope(staleScope, { storage: storage() })
          purgeViewerCache(serverViewer, { storage: storage() })
          purgeQueryCaches(state.scope.projectId, null)
          commit()
          return
        }
        confirmedViewerUserId = serverViewer
        state.capabilities = result.capabilities
        state.phase = 'ready'
        state.masked = false
        state.lastBootstrap = result.capabilities.degraded ? 'degraded' : 'ok'
        state.lastErrorCode = null
        state.viewerChanged = false
        restoreActiveFromCache()
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

  function dispose(reason: SessionRuntimeDisposeReason): void {
    if (state.disposed) return
    const scope = cacheScopeInternal()
    state.disposed = true
    state.started = false
    state.bootstrapAttemptId += 1
    state.phase = 'locked'
    state.masked = false
    state.active = { global: null, source: null }
    state.viewerChanged = false
    if (reason !== 'unmount') {
      // 先使写入失效，再清理本机分区（清理后不得再由 cleanup flush 旧稿）。
      invalidateGuards()
      if (scope) purgeViewerScope(scope, { storage: storage() })
      purgeQueryCaches(state.scope.projectId, null)
    }
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
      if (oldScope) purgeViewerScope(oldScope, { storage: storage() })
      purgeViewerCache(next.viewerUserId ?? '', { storage: storage() })
      purgeQueryCaches(previousProject, null)
      if (projectChanged && previousProject !== next.projectId) {
        purgeQueryCaches(next.projectId, null)
      }
    } else if (generationChanged || projectChanged) {
      // 同 viewer refresh：保留 editor store/内存 dirty/可见消息，只换 transport 代际。
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
    if (state.masked === masked) return
    state.masked = masked
    if (masked) {
      state.phase = 'masked'
    } else if (state.phase === 'masked') {
      state.phase = confirmedViewerUserId ? 'ready' : 'bootstrapping'
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
      if (!isViewerScopedCacheReadable(scope, authority)) {
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
    if (!isViewerScopedCacheReadable(scope, authority)) return
    writeDisplayPointer(scope, display, { storage: storage() })
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
    updateAuth,
    setMasked,
    dispose,
    isDisposed: () => state.disposed,
    isReady: () => state.phase === 'ready',
    isMasked: () => state.masked || state.phase === 'masked' || state.phase === 'bootstrapping',
    active,
    activate,
    setDisplayPointer,
    identity: () => currentIdentity(),
    cacheScope: () => cacheScopeInternal(),
    cacheAuthority: () => cacheAuthorityInternal(),
    createWriteGuard,
    runIfCurrent,
    now,
  }
}
