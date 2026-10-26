'use client'

/**
 * 研究会话列表 / 创建状态机（RDLens #602 第三批 PR-2；3B 列表、创建、切换与当前识别）。
 *
 * 规范来源：
 * - `dev_docs/设计方案/Research/issue602_batch3/01_DESIGN.md` §3.1、§3.3、§4.1、§4.3、§4.7
 * - `02_INTERFACE_FREEZE.md` §2–§4
 * - 第一批冻结契约 `Issue602_第一批_契约与测试场景_v1_20261020.json` revision=6（`create_request`/`create_response`/`list_response`）
 *
 * 边界（cards/PR-2.md）：
 * - 只做列表 / 创建 / 能力门禁；不实现 editor/草稿/保存/SSE/composer（PR-3/PR-4/PR-5a）。
 * - 列表响应严格经 `session-contract.parseListResponse` 投影；`create_response`
 *   的 6 键严格校验在本文件（Lead 裁决 R5），不在 `api.ts` 重复契约语义。
 * - `session-runtime.ts` 不修改：本 hook 只调用其公开 API
 *   （`getSnapshot`/`subscribe`/`identity`/`cacheScope`/`cacheAuthority`）。
 * - 第二批接口尚不可用 → 行为以契约 mock 验证（证据级别 `simulated`）。
 *
 * 关键行为（DESIGN §4.1）：
 * - 新协议分页：只有服务端 `next_cursor` 决定是否还有下一页；**不得**因
 *   `items.length < limit` 判结束（权限过滤发生在服务端分页语义内）。
 * - Source 快捷列表走旧读路径（`GET /sources/{id}/chat/sessions`，API 只接受
 *   `limit`、**没有 cursor/offset 参数**），只作 session 身份枚举；本次只取
 *   首页 20 条并把“第 21 条起的续页”登记为未完成能力（不伪造分页）。
 *   旧 `title` 不当作新协议可读标题，也不展示未声明的 `has_draft`/
 *   `record_visibility`；其 404 只说明来源当前不可解析。
 * - 列表失败分类：401 交认证层；403 `chat_owner_required` 终态无权限且不重试
 *   （首屏与加载更多一致）；404 清列表内容显示空态；5xx/网络保留已有列表并
 *   允许重试，不自动创建会话。
 * - 身份（viewer/authGeneration/project/role）变化：同步清空列表内存与创建
 *   状态（不渲染上一身份条目，S1），pending client session_id 一并丢弃。
 * - 列表响应的 `viewer_user_id`/`capabilities` 必须与当前身份/请求一致：
 *   viewer 不符或无 session_ref 的降级 DTO/缺失可见性 → `invalid_response`；
 *   响应 capabilities 降级时只收紧**创建**门禁（阅读入口仍可用，§3.3）。
 */

import { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { QueryClientContext } from '@tanstack/react-query'
import type { QueryClient } from '@tanstack/react-query'

import {
  createChatSession,
  listChatSessions,
  listSourceChatSessions,
  type CreateChatSessionInput,
  type ListChatSessionsParams,
  type ResearchSourceChatSessionSummary,
} from '@/lib/research/api'
import { extractResearchErrorCode } from '@/lib/research/errors'
import { RESEARCH_MUTATION_OPTIONS, researchQueryKey } from '@/lib/api/query-client'
import type { ResearchQueryIdentity } from '@/lib/api/query-client'
import type { SessionRuntime } from '@/lib/research/session-runtime'
import {
  CLIENT_ERROR_CODES,
  SESSION_CONTRACT_VERSION,
  parseEditorState,
  parseListResponse,
  parseSessionRef,
  sessionKey,
  type ResearchSessionCapabilities,
  type ResearchSessionRef,
  type ResearchSessionSummaryProjection,
  type WireEditorState,
} from '@/lib/research/session-contract'

/** 新协议每页条数（`list_query.limit` 1..100，默认 20）。 */
export const RESEARCH_SESSION_PAGE_LIMIT = 20

/** Source 旧读路径固定页大小（API 无 cursor；只取首页）。 */
export const RESEARCH_SOURCE_SESSION_PAGE_LIMIT = 20

const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/
const HASH_PATTERN = /^[a-f0-9]{64}$/

/** 列表/创建被禁用原因（组件据此给出可见文案；不猜能力、不静默降级）。 */
export type ResearchSessionsDisabledReason =
  | 'runtime_unavailable'
  | 'viewer_unverified'
  | 'unauthorized'
  | 'capability_unavailable'
  | 'source_required'

/** 列表错误分类（DESIGN §4.1 末尾 / §4.7）。 */
export type ResearchSessionsErrorKind =
  | 'unauthenticated'
  | 'unauthorized'
  | 'not_found'
  | 'source_unavailable'
  | 'unavailable'

/** 创建失败分类（§4.3）。 */
export type ResearchSessionCreateError = 'invalid_response' | 'unauthorized' | 'failed'

/** 创建成功结果（PR-3 将用 editorState/revision 初始化 editor；PR-2 只激活会话）。 */
export interface ResearchSessionCreateResult {
  readonly ref: ResearchSessionRef
  readonly editorRevision: number
  readonly editorState: WireEditorState | null
  readonly editorIntentHash: string | null
  /** 服务端语义：201/`created=true` 为新建；200/`created=false` 表示同绑定已存在。 */
  readonly created: boolean
}

interface SessionPage {
  readonly items: readonly ResearchSessionSummaryProjection[]
  readonly nextCursor: string | null
  readonly legacySource: boolean
  /** 与列表页同一响应的能力投影；只在请求代际校验通过后随列表一并提交（R1）。 */
  readonly capabilities: ResearchSessionCapabilities | null
}

/** 列表状态归属的身份/作用域键：身份或 surface/source 变化时同帧丢弃旧数据。 */
interface ScopedStateKey {
  readonly identityKey: string | null
  readonly surface: 'global' | 'source'
  readonly sourceId: string | null
  readonly projectHistory: boolean
}

export interface UseResearchSessionsInput {
  /** 可选：无 runtime（例如无 Provider 的装配）时入口隐藏并给出原因。 */
  readonly runtime: SessionRuntime | null
  /** `global` 使用新协议（kind=global 或项目级 kind=all）；`source` 走旧读路径。 */
  readonly surface: 'global' | 'source'
  /** surface='source' 时必填（当前来源）。 */
  readonly sourceId?: string | null
  /** 项目级历史（kind=all）；仅 surface='global' 生效。 */
  readonly projectHistory?: boolean
}

export interface UseResearchSessionsResult {
  readonly sessions: readonly ResearchSessionSummaryProjection[]
  readonly loading: boolean
  readonly loadingMore: boolean
  readonly error: ResearchSessionsErrorKind | null
  readonly loadMoreError: ResearchSessionsErrorKind | null
  readonly unauthorized: boolean
  readonly sourceUnavailable: boolean
  readonly hasMore: boolean
  readonly capabilitiesReady: boolean
  readonly canList: boolean
  readonly canCreate: boolean
  readonly listDisabledReason: ResearchSessionsDisabledReason | null
  readonly createDisabledReason: ResearchSessionsDisabledReason | null
  readonly creating: boolean
  readonly createError: ResearchSessionCreateError | null
  readonly created: ResearchSessionCreateResult | null
  readonly refresh: () => void
  readonly loadMore: () => void
  readonly create: () => Promise<ResearchSessionCreateResult | null>
}

/** 供测试与页面复用的 session_id 生成（格式固定，优先 `sess_` + UUID）。 */
export function generateSessionId(): string {
  const cryptoObject = typeof globalThis !== 'undefined' ? globalThis.crypto : undefined
  if (cryptoObject && typeof cryptoObject.randomUUID === 'function') {
    return `sess_${cryptoObject.randomUUID().replace(/-/g, '')}`
  }
  const bytes = new Uint8Array(16)
  if (cryptoObject && typeof cryptoObject.getRandomValues === 'function') {
    cryptoObject.getRandomValues(bytes)
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256)
    }
  }
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
  return `sess_${hex}`
}

function readHttpStatus(error: unknown): number | null {
  if (typeof error !== 'object' || error === null) return null
  const response = (error as { response?: unknown }).response
  if (typeof response !== 'object' || response === null) return null
  const status = (response as { status?: unknown }).status
  return typeof status === 'number' ? status : null
}

function invalidResponseError(field: string): Error {
  const error = new Error(field) as Error & { code: string }
  error.code = CLIENT_ERROR_CODES.invalidResponse
  return error
}

function classifyListError(error: unknown, surface: 'global' | 'source'): ResearchSessionsErrorKind {
  const code = extractResearchErrorCode(error)
  const status = readHttpStatus(error)
  if (code === CLIENT_ERROR_CODES.invalidResponse) return 'unavailable'
  if (status === 401) return 'unauthenticated'
  if (code === 'chat_owner_required' || status === 403) return 'unauthorized'
  if (code === 'session_not_found') return 'not_found'
  if (status === 404) return surface === 'source' ? 'source_unavailable' : 'not_found'
  // 旧读路径的 404 来自 `_resolve_source_refs`：只说明来源当前不可解析，
  // 不等于会话不存在或撤权；分类为“来源暂不可用”（不显示“会话不存在”）。
  return 'unavailable'
}

/** 旧读路径条目 → 仅身份枚举的投影（不把旧 title 当新协议可读标题）。 */
function toLegacySourceSummary(
  projectId: string,
  sourceId: string,
  row: ResearchSourceChatSessionSummary,
): ResearchSessionSummaryProjection | null {
  if (typeof row !== 'object' || row === null) return null
  if (typeof row.session_id !== 'string' || !SESSION_ID_PATTERN.test(row.session_id)) return null
  if (typeof row.source_id !== 'string' || row.source_id !== sourceId) return null
  if (typeof row.created_at !== 'string' || Number.isNaN(Date.parse(row.created_at))) return null
  if (typeof row.updated_at !== 'string' || Number.isNaN(Date.parse(row.updated_at))) return null
  return {
    ref: {
      domain: 'research',
      kind: 'source',
      projectId,
      sessionId: row.session_id,
      sourceId,
    },
    title: null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    visibility: null,
    hasDraft: null,
    // 旧读路径列表只作身份枚举：标题/可见性/草稿均未按新协议声明。
    legacy: true,
    visibilityDegraded: true,
  }
}

function parseCreateResponse(
  raw: unknown,
  input: { projectId: string; kind: 'global' | 'source'; sourceId: string | null },
): ResearchSessionCreateResult | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const record = raw as Record<string, unknown>
  const keys = [
    'session_ref',
    'editor_revision',
    'editor_state',
    'state_warnings',
    'created',
    'editor_intent_hash',
  ]
  const allowed = new Set(keys)
  if (!Object.keys(record).every((key) => allowed.has(key))) return null
  if (!keys.every((key) => key in record)) return null

  const refResult = parseSessionRef(record.session_ref)
  if (!refResult.ok) return null
  const ref = refResult.value
  if (ref.projectId !== input.projectId || ref.kind !== input.kind) return null
  if (input.kind === 'source' ? ref.sourceId !== input.sourceId : ref.sourceId !== null) return null

  const revision = record.editor_revision
  if (
    typeof revision !== 'number' ||
    !Number.isInteger(revision) ||
    revision < 0 ||
    revision > 2_147_483_647
  ) {
    return null
  }

  const warnings = record.state_warnings
  if (!Array.isArray(warnings)) return null
  const seenWarnings = new Set<string>()
  for (const entry of warnings) {
    if (typeof entry !== 'string' || entry.length === 0 || entry.length > 256) return null
    if (seenWarnings.has(entry)) return null
    seenWarnings.add(entry)
  }

  const created = record.created
  if (typeof created !== 'boolean') return null

  const intentHash = record.editor_intent_hash
  if (intentHash !== null && (typeof intentHash !== 'string' || !HASH_PATTERN.test(intentHash))) {
    return null
  }

  let editorState: WireEditorState | null = null
  if (record.editor_state !== null) {
    const stateResult = parseEditorState(record.editor_state, ref.kind)
    if (!stateResult.ok) return null
    editorState = stateResult.value
  }
  const hasUnreadableWarning = seenWarnings.has('editor_state_unreadable')
  if (editorState === null) {
    if (!hasUnreadableWarning || intentHash !== null) return null
  } else if (hasUnreadableWarning) {
    return null
  } else if (typeof intentHash !== 'string') {
    return null
  }
  if (created && editorState === null) return null

  return {
    ref,
    editorRevision: revision,
    editorState,
    editorIntentHash: typeof intentHash === 'string' ? intentHash : null,
    created,
  }
}

function sessionIdentityKey(identity: ResearchQueryIdentity | null): string | null {
  if (!identity) return null
  if (identity.role === 'owner') {
    return `owner|${identity.projectId}|${identity.viewerUserId}|${identity.authGeneration}`
  }
  return `admin|${identity.projectId}|${identity.authGeneration}`
}

function isCapabilitiesReady(
  capabilities: ResearchSessionCapabilities | null | undefined,
): boolean {
  return (
    capabilities !== null &&
    capabilities !== undefined &&
    capabilities.contract === SESSION_CONTRACT_VERSION &&
    !capabilities.degraded
  )
}

export function useResearchSessions(input: UseResearchSessionsInput): UseResearchSessionsResult {
  const { runtime, surface, sourceId = null, projectHistory = false } = input
  // 可选 QueryClient：真实装配由 QueryProvider 提供；无 Provider 的装配
  // （例如页面级测试替身）仍须稳定渲染，只是无法清理/失效查询缓存。
  const queryClient: QueryClient | null = useContext(QueryClientContext) ?? null

  // ── 订阅运行时快照（无 runtime 时使用模块级稳定 server snapshot） ──
  const [snapshot, setSnapshot] = useState(() => (runtime ? runtime.getSnapshot() : null))
  useEffect(() => {
    if (!runtime) {
      setSnapshot(null)
      return
    }
    setSnapshot(runtime.getSnapshot())
    return runtime.subscribe(() => setSnapshot(runtime.getSnapshot()))
  }, [runtime])

  const identity = runtime ? runtime.identity() : null
  const identityKey = sessionIdentityKey(identity)
  const projectId = identity?.projectId ?? ''

  const scopeKey = useMemo<ScopedStateKey>(
    () => ({ identityKey, surface, sourceId, projectHistory }),
    [identityKey, surface, sourceId, projectHistory],
  )
  /** 当前 state 归属的作用域键；与 scopeKey 不一致时同帧隐藏旧数据（S1）。 */
  const [stateScope, setStateScope] = useState<ScopedStateKey>(scopeKey)

  const scopeMatches =
    stateScope.identityKey === scopeKey.identityKey &&
    stateScope.surface === scopeKey.surface &&
    stateScope.sourceId === scopeKey.sourceId &&
    stateScope.projectHistory === scopeKey.projectHistory

  const snapshotCapabilities = snapshot?.capabilities ?? null
  const snapshotCapabilitiesOk = isCapabilitiesReady(snapshotCapabilities)
  /** 列表响应自带 capabilities：降级时只收紧创建门禁（§3.3）。 */
  const [responseCapabilities, setResponseCapabilities] =
    useState<ResearchSessionCapabilities | null>(null)
  const capabilitiesOk =
    snapshotCapabilitiesOk && (responseCapabilities === null || isCapabilitiesReady(responseCapabilities))

  // ── 门禁（§3.3） ──
  const listDisabledReason: ResearchSessionsDisabledReason | null = useMemo(() => {
    if (!runtime) return 'runtime_unavailable'
    if (!snapshot || !snapshot.ready || snapshot.masked || !identity) return 'viewer_unverified'
    if (snapshot.unauthorized) return 'unauthorized'
    // Admin 只读：服务端 403 `chat_owner_required`（§3.3）；列表入口终态不可读。
    if (identity.role !== 'owner') return 'unauthorized'
    if (surface === 'source' && !sourceId) return 'source_required'
    // Source 快捷列表走旧读路径：新会话契约缺失时“原兼容阅读入口仍可用”，
    // 因此列表本身不因能力降级而禁用；新协议列表（global/history）必须契约就绪。
    if (surface === 'global' && !snapshotCapabilitiesOk) return 'capability_unavailable'
    return null
  }, [runtime, snapshot, identity, surface, sourceId, snapshotCapabilitiesOk])

  const createDisabledReason: ResearchSessionsDisabledReason | null = useMemo(() => {
    if (!runtime) return 'runtime_unavailable'
    if (!snapshot || !snapshot.ready || snapshot.masked || !identity) return 'viewer_unverified'
    if (snapshot.unauthorized) return 'unauthorized'
    if (identity.role !== 'owner') return 'unauthorized'
    if (surface === 'source' && !sourceId) return 'source_required'
    // 创建恒走新协议，因此必须契约就绪（与 source 旧读路径列表不同）。
    if (!capabilitiesOk) return 'capability_unavailable'
    return null
  }, [capabilitiesOk, runtime, snapshot, identity, surface, sourceId])

  // ── 列表状态（手动状态机：401/403 重试语义、旧路径合并去重需要精确控制） ──
  const [pages, setPages] = useState<readonly SessionPage[]>([])
  const [loading, setLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<ResearchSessionsErrorKind | null>(null)
  const [loadMoreError, setLoadMoreError] = useState<ResearchSessionsErrorKind | null>(null)
  const [terminalUnauthorized, setTerminalUnauthorized] = useState(false)
  /** 置为终态时的身份键：只有身份变化才解除（R6，切 surface/source 不解锁）。 */
  const terminalIdentityRef = useRef<string | null>(null)

  const requestIdRef = useRef(0)
  const inFlightRef = useRef(false)
  const pagesRef = useRef<readonly SessionPage[]>([])
  pagesRef.current = pages
  /** state 当前归属作用域（给 reset 比较身份变化用，避免额外 effect 反复重置）。 */
  const stateScopeRef = useRef<ScopedStateKey>(stateScope)
  stateScopeRef.current = stateScope

  const canListBase = listDisabledReason === null && runtime !== null
  // 403 终态：关闭列表/分页/刷新/创建，直到身份变化才解除（不进入重试循环）。
  const canList = canListBase && !terminalUnauthorized
  const canCreate = createDisabledReason === null && runtime !== null && !terminalUnauthorized

  const queryKey = useMemo(() => {
    if (!identity) return null
    const kind: ListChatSessionsParams['kind'] =
      surface === 'source' ? 'source' : projectHistory ? 'all' : 'global'
    return researchQueryKey(identity, 'chat-sessions', kind, sourceId ?? '')
  }, [identity, surface, projectHistory, sourceId])

  /** 新协议列表条目的身份/契约一致性校验（拒绝降级 DTO 与跨身份/跨项目条目）。 */
  const validateListPage = useCallback(
    (
      value: {
        items: readonly ResearchSessionSummaryProjection[]
        nextCursor: string | null
        viewerUserId: number
        capabilities: ResearchSessionCapabilities | null
      },
      expected: { ownerViewerId: string | null; projectId: string; kind: 'global' | 'all' },
    ) => {
      if (expected.kind !== 'all' && value.viewerUserId === 0) {
        throw invalidResponseError('viewer_user_id')
      }
      if (expected.ownerViewerId !== null && String(value.viewerUserId) !== expected.ownerViewerId) {
        throw invalidResponseError('viewer_user_id')
      }
      for (const item of value.items) {
        if (item.legacy) throw invalidResponseError('session_ref')
        if (item.visibilityDegraded) throw invalidResponseError('record_visibility')
        if (item.ref.projectId !== expected.projectId) throw invalidResponseError('session_ref')
        if (expected.kind === 'global' && item.ref.kind !== 'global') {
          throw invalidResponseError('session_ref')
        }
        if (item.ref.kind === 'global' && item.ref.sourceId !== null) {
          throw invalidResponseError('session_ref')
        }
        if (item.ref.kind === 'source' && !item.ref.sourceId) {
          throw invalidResponseError('session_ref')
        }
      }
      return value
    },
    [],
  )

  const fetchPage = useCallback(
    async (mode: 'initial' | 'more'): Promise<SessionPage> => {
      if (!projectId) throw new Error('research sessions require a project identity')
      if (surface === 'source') {
        const targetSourceId = sourceId ?? ''
        const page = await listSourceChatSessions(projectId, targetSourceId, {
          limit: RESEARCH_SOURCE_SESSION_PAGE_LIMIT,
        })
        if (!page || !Array.isArray(page.items)) throw invalidResponseError('items')
        const items: ResearchSessionSummaryProjection[] = []
        for (const row of page.items) {
          const summary = toLegacySourceSummary(projectId, targetSourceId, row)
          if (!summary) throw invalidResponseError('items')
          items.push(summary)
        }
        // 旧读路径 API 没有 cursor/offset：只取首页，不伪造“加载更多”。
        return { items, nextCursor: null, legacySource: true, capabilities: null }
      }
      const lastPage = mode === 'more' ? pagesRef.current[pagesRef.current.length - 1] : null
      const cursor = lastPage?.nextCursor ?? null
      if (mode === 'more' && cursor === null) {
        return { items: [], nextCursor: null, legacySource: false, capabilities: null }
      }
      const kind: 'global' | 'all' = projectHistory ? 'all' : 'global'
      const params: ListChatSessionsParams = {
        kind,
        limit: RESEARCH_SESSION_PAGE_LIMIT,
      }
      if (cursor !== null) params.cursor = cursor
      const raw = await listChatSessions(projectId, params)
      const parsed = parseListResponse(raw)
      if (!parsed.ok) {
        throw invalidResponseError(parsed.error.field ?? 'list_response')
      }
      const value = validateListPage(parsed.value, {
        ownerViewerId:
          identity && identity.role === 'owner' ? (identity.viewerUserId ?? null) : null,
        projectId,
        kind,
      })
      return {
        items: value.items,
        nextCursor: value.nextCursor,
        legacySource: false,
        // R1：能力与列表同属一个响应代际，交给 load 在 requestId 校验后提交。
        capabilities: parsed.value.capabilities,
      }
    },
    [projectId, surface, sourceId, projectHistory, identity, validateListPage],
  )

  // ── 创建（§4.3：显式触发、single-flight、幂等重试复用 client session_id） ──
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<ResearchSessionCreateError | null>(null)
  const [created, setCreated] = useState<ResearchSessionCreateResult | null>(null)
  const createInFlightRef = useRef(false)
  const createRequestIdRef = useRef(0)
  /** 每次 create 调用的尝试号：旧尝试不得释放新尝试的 single-flight（R2）。 */
  const createAttemptIdRef = useRef(0)
  const pendingSessionIdRef = useRef<string | null>(null)

  /** 身份/作用域变化：同步丢弃列表、创建与队列状态（S1，含 pending client id）。 */
  const resetForScopeChange = useCallback((nextScope: ScopedStateKey) => {
    requestIdRef.current += 1
    inFlightRef.current = false
    setPages([])
    setLoading(false)
    setLoadingMore(false)
    setError(null)
    setLoadMoreError(null)
    // R6：403 终态只随身份变化解除；同身份切 surface/source 不得逃逸。
    if (nextScope.identityKey !== stateScopeRef.current.identityKey) {
      setTerminalUnauthorized(false)
      terminalIdentityRef.current = null
    }
    setResponseCapabilities(null)
    setCreated(null)
    setCreateError(null)
    setCreating(false)
    createInFlightRef.current = false
    createRequestIdRef.current += 1
    createAttemptIdRef.current += 1
    pendingSessionIdRef.current = null
    setStateScope(nextScope)
  }, [])

  const load = useCallback(
    async (mode: 'initial' | 'more') => {
      if (!canList || !projectId) return
      if (inFlightRef.current) return
      const requestId = requestIdRef.current + 1
      requestIdRef.current = requestId
      inFlightRef.current = true
      if (mode === 'initial') {
        setLoading(true)
        setError(null)
        setLoadMoreError(null)
      } else {
        setLoadingMore(true)
        setLoadMoreError(null)
      }
      try {
        const page = await fetchPage(mode)
        if (requestIdRef.current !== requestId) return
        // R1：列表响应自带的 capabilities 只在身份/请求代际校验通过后提交，
        // 旧 viewer 的挂起响应不得重开当前身份的创建门禁。
        setResponseCapabilities(page.capabilities)
        setPages((previous) => (mode === 'initial' ? [page] : [...previous, page]))
        if (mode === 'initial') setError(null)
      } catch (caught) {
        if (requestIdRef.current !== requestId) return
        const kind = classifyListError(caught, surface)
        if (kind === 'unauthorized') {
          // 403 终态：首屏与加载更多一致；清列表内容缓存，关闭列表/分页/刷新/
          // 创建，直到身份变化才解除（R7：不 dispose runtime、不自动重试）。
          setPages([])
          setError('unauthorized')
          setLoadMoreError(null)
          setTerminalUnauthorized(true)
          terminalIdentityRef.current = identityKey
          if (queryKey && queryClient) queryClient.removeQueries({ queryKey, exact: true })
        } else if (mode === 'initial') {
          // 404 清列表内容；5xx/网络保留已有列表并允许重试，不自动创建新
          // 会话（DESIGN §4.1 末尾）。
          if (kind !== 'unavailable') setPages([])
          setError(kind)
        } else {
          setLoadMoreError(kind)
        }
      } finally {
        if (requestIdRef.current === requestId) {
          inFlightRef.current = false
          setLoading(false)
          setLoadingMore(false)
        }
      }
    },
    [canList, projectId, fetchPage, surface, queryKey, queryClient, identityKey],
  )

  const loadRef = useRef(load)
  loadRef.current = load

  // 身份/门禁/作用域变化：先同步丢弃旧作用域状态（scopeMatches=false 的那一帧
  // 已隐藏旧数据），再在新身份可列表时重新加载（S1）。
  useEffect(() => {
    if (!scopeMatches) {
      resetForScopeChange(scopeKey)
    }
    if (canList) void loadRef.current('initial')
  }, [scopeMatches, scopeKey, canList, resetForScopeChange])

  // 显式刷新（打开历史抽屉/重试）：不做身份级 reset，5xx 时保留已有列表
  // （DESIGN §4.1 末尾：保留已有列表与本机稿、显示重试）。
  const refresh = useCallback(() => {
    if (!canList) return
    requestIdRef.current += 1
    inFlightRef.current = false
    setError(null)
    setLoadMoreError(null)
    void loadRef.current('initial')
  }, [canList])

  const loadMore = useCallback(() => {
    if (!canList) return
    void loadRef.current('more')
  }, [canList])

  // ── 去重合并（按 sessionKey，跨页重复保留首见） ──
  const sessions = useMemo(() => {
    if (!scopeMatches) return []
    const seen = new Set<string>()
    const merged: ResearchSessionSummaryProjection[] = []
    for (const page of pages) {
      for (const item of page.items) {
        const key = sessionKey(item.ref)
        if (seen.has(key)) continue
        seen.add(key)
        merged.push(item)
      }
    }
    return merged
  }, [pages, scopeMatches])

  const hasMore = useMemo(() => {
    if (!scopeMatches) return false
    const lastPage = pages[pages.length - 1]
    if (!lastPage) return false
    // Source 旧读路径无 cursor：只取首页（第 21 条起的续页登记为未完成能力，
    // 见文件头），不显示“加载更多”按钮。
    if (lastPage.legacySource) return false
    return lastPage.nextCursor !== null
  }, [pages, scopeMatches])

  const create = useCallback(async (): Promise<ResearchSessionCreateResult | null> => {
    if (!canCreate || createInFlightRef.current || !projectId) return null
    if (surface === 'source' && !sourceId) return null
    if (pendingSessionIdRef.current === null) {
      pendingSessionIdRef.current = generateSessionId()
    }
    const sessionId = pendingSessionIdRef.current
    if (!SESSION_ID_PATTERN.test(sessionId)) {
      pendingSessionIdRef.current = null
      setCreateError('failed')
      return null
    }
    createInFlightRef.current = true
    setCreating(true)
    setCreateError(null)
    // 创建使用独立代际：列表刷新（打开抽屉）推进 requestId 不得作废已发出
    // 的创建响应（否则服务端已建会话但页面不激活且无解释）。
    const requestId = createRequestIdRef.current
    const attempt = createAttemptIdRef.current + 1
    createAttemptIdRef.current = attempt
    try {
      const input: CreateChatSessionInput = {
        kind: surface === 'source' ? 'source' : 'global',
        sourceId: surface === 'source' ? sourceId : null,
        sessionId,
      }
      const raw = await createChatSession(projectId, input)
      const parsed = parseCreateResponse(raw, {
        projectId,
        kind: input.kind,
        sourceId: input.sourceId ?? null,
      })
      // R2：尝试号/代际校验必须早于一切 state 写入（含错误态）。
      if (createAttemptIdRef.current !== attempt || createRequestIdRef.current !== requestId) {
        return null
      }
      if (!parsed) {
        // 响应形状非法：服务端可能已创建 → 保留 client session_id 供下次
        // 重试命中 `created=false`（不生成新 id、不产生空壳列表项）。
        setCreateError('invalid_response')
        return null
      }
      pendingSessionIdRef.current = null
      setCreated(parsed)
      setCreateError(null)
      // 列表摘要按服务端事实更新：下一轮刷新/打开抽屉时可见（§4.1 列表更新）。
      if (queryKey && queryClient) void queryClient.invalidateQueries({ queryKey })
      return parsed
    } catch (caught) {
      if (createAttemptIdRef.current !== attempt || createRequestIdRef.current !== requestId) {
        return null
      }
      const kind = classifyListError(caught, surface)
      setCreateError(kind === 'unauthorized' ? 'unauthorized' : 'failed')
      return null
    } finally {
      // R2：旧尝试的 finally 不得释放新作用域/新尝试持有的 single-flight。
      if (createAttemptIdRef.current === attempt) {
        createInFlightRef.current = false
        setCreating(false)
      }
    }
  }, [canCreate, projectId, surface, sourceId, queryKey, queryClient])

  const unauthorized = terminalUnauthorized || (snapshot?.unauthorized ?? false)
  const sourceUnavailable = scopeMatches && error === 'source_unavailable'

  return {
    sessions,
    loading: scopeMatches ? loading : false,
    loadingMore: scopeMatches ? loadingMore : false,
    error: scopeMatches ? error : null,
    loadMoreError: scopeMatches ? loadMoreError : null,
    unauthorized,
    sourceUnavailable,
    hasMore,
    capabilitiesReady: capabilitiesOk,
    canList,
    canCreate,
    listDisabledReason,
    createDisabledReason,
    creating: scopeMatches ? creating : false,
    createError: scopeMatches ? createError : null,
    created: scopeMatches ? created : null,
    refresh,
    loadMore,
    create,
  }
}

/** mutation 选项导出给页面层复用（PR-1 判别键约定：Research mutation 不自动重试）。 */
export const RESEARCH_SESSIONS_MUTATION_OPTIONS = RESEARCH_MUTATION_OPTIONS
