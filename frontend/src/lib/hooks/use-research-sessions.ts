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
 * - Source 快捷列表走旧读路径（`GET /sources/{id}/chat/sessions`，无 cursor），
 *   只作 session 身份枚举；旧 `title` 不当作新协议可读标题，也不展示未声明的
 *   `has_draft`/`record_visibility`；其 404 只说明来源当前不可解析。
 * - 列表失败分类：401 交认证层；403 `chat_owner_required` 终态无权限且不重试；
 *   404 清列表内容显示空态；5xx/网络保留已有列表并允许重试，不自动创建会话。
 * - 身份（viewer/authGeneration/project/role）变化：清空列表内存与创建状态，
 *   不渲染上一身份条目（S1）。
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
  type ResearchSessionRef,
  type ResearchSessionSummaryProjection,
  type WireEditorState,
} from '@/lib/research/session-contract'
import type { ResearchSourceChatSessionSummary } from '@/lib/research/api'

/** 新协议每页条数（`list_query.limit` 1..100，默认 20）。 */
export const RESEARCH_SESSION_PAGE_LIMIT = 20

/** Source 旧读路径固定页大小（hook 既有实现固定 `limit:20`，无 cursor）。 */
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

function classifyListError(error: unknown, surface: 'global' | 'source'): ResearchSessionsErrorKind {
  const code = extractResearchErrorCode(error)
  const status = readHttpStatus(error)
  if (status === 401) return 'unauthenticated'
  if (code === 'chat_owner_required' || status === 403) return 'unauthorized'
  if (code === 'session_not_found') return 'not_found'
  if (status === 404) return surface === 'source' ? 'source_unavailable' : 'not_found'
  // 旧读路径的 404 来自 `_resolve_source_refs`：只说明来源当前不可解析，
  // 不等于会话不存在或撤权；分类为“来源暂不可用”（不显示“会话不存在”）。
  if (code === null) return 'unavailable'
  return 'unavailable'
}

/** 旧读路径条目 → 仅身份枚举的投影（不把旧 title 当新协议可读标题）。 */
function toLegacySourceSummary(
  projectId: string,
  sourceId: string,
  row: ResearchSourceChatSessionSummary,
): ResearchSessionSummaryProjection {
  return {
    ref: {
      domain: 'research',
      kind: 'source',
      projectId,
      sessionId: row.session_id,
      sourceId,
    },
    title: null,
    createdAt: typeof row.created_at === 'string' ? row.created_at : '',
    updatedAt: typeof row.updated_at === 'string' ? row.updated_at : '',
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

export function useResearchSessions(input: UseResearchSessionsInput): UseResearchSessionsResult {
  const { runtime, surface, sourceId = null, projectHistory = false } = input
  // 可选 QueryClient：真实装配由 QueryProvider 提供；无 Provider 的装配
  // （例如页面级测试替身）仍须稳定渲染，只是无法清理/失效查询缓存。
  const queryClient: QueryClient | null = useContext(QueryClientContext) ?? null

  // ── 订阅运行时快照（无 runtime 时使用模块级稳定 server snapshot） ──
  const [snapshot, setSnapshot] = useState(() =>
    runtime ? runtime.getSnapshot() : null,
  )
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

  const capabilitiesOk =
    snapshot !== null &&
    snapshot.ready &&
    !snapshot.masked &&
    snapshot.capabilities !== null &&
    snapshot.capabilities.contract === SESSION_CONTRACT_VERSION &&
    !snapshot.capabilities.degraded

  // ── 门禁（§3.3） ──
  const listDisabledReason: ResearchSessionsDisabledReason | null = useMemo(() => {
    if (!runtime) return 'runtime_unavailable'
    if (!snapshot || !snapshot.ready || snapshot.masked || !identity) return 'viewer_unverified'
    if (snapshot.unauthorized) return 'unauthorized'
    if (surface === 'source' && !sourceId) return 'source_required'
    // Source 快捷列表走旧读路径：新会话契约缺失时“原兼容阅读入口仍可用”，
    // 因此列表本身不因能力降级而禁用；新协议列表（global/history）必须契约就绪。
    if (surface === 'global' && !capabilitiesOk) return 'capability_unavailable'
    return null
  }, [runtime, snapshot, identity, surface, sourceId, capabilitiesOk])

  const createDisabledReason: ResearchSessionsDisabledReason | null = useMemo(() => {
    if (!runtime) return 'runtime_unavailable'
    if (!snapshot || !snapshot.ready || snapshot.masked || !identity) return 'viewer_unverified'
    if (snapshot.unauthorized) return 'unauthorized'
    if (surface === 'source' && !sourceId) return 'source_required'
    // 创建恒走新协议，因此必须契约就绪（与 source 旧读路径列表不同）。
    if (!capabilitiesOk) return 'capability_unavailable'
    return null
  }, [capabilitiesOk, runtime, snapshot, identity, surface, sourceId])

  const canList = listDisabledReason === null && runtime !== null
  const canCreate = createDisabledReason === null && runtime !== null

  // ── 列表状态（手动状态机：401/403 重试语义、旧路径合并去重需要精确控制） ──
  const [pages, setPages] = useState<readonly SessionPage[]>([])
  const [loading, setLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<ResearchSessionsErrorKind | null>(null)
  const [loadMoreError, setLoadMoreError] = useState<ResearchSessionsErrorKind | null>(null)
  const [terminalUnauthorized, setTerminalUnauthorized] = useState(false)

  const requestIdRef = useRef(0)
  const inFlightRef = useRef(false)
  const pagesRef = useRef<readonly SessionPage[]>([])
  pagesRef.current = pages

  const queryKey = useMemo(() => {
    if (!identity) return null
    const kind: ListChatSessionsParams['kind'] =
      surface === 'source' ? 'source' : projectHistory ? 'all' : 'global'
    return researchQueryKey(identity, 'chat-sessions', kind, sourceId ?? '')
  }, [identity, surface, projectHistory, sourceId])

  const fetchPage = useCallback(
    async (mode: 'initial' | 'more'): Promise<SessionPage> => {
      if (!projectId) throw new Error('research sessions require a project identity')
      if (surface === 'source') {
        const page = await listSourceChatSessions(projectId, sourceId ?? '', {
          limit: RESEARCH_SOURCE_SESSION_PAGE_LIMIT,
        })
        return {
          items: page.items.map((row) => toLegacySourceSummary(projectId, sourceId ?? '', row)),
          nextCursor: null,
          legacySource: true,
        }
      }
      const lastPage = mode === 'more' ? pagesRef.current[pagesRef.current.length - 1] : null
      const cursor = lastPage?.nextCursor ?? null
      if (mode === 'more' && cursor === null) {
        return { items: [], nextCursor: null, legacySource: false }
      }
      const params: ListChatSessionsParams = {
        kind: projectHistory ? 'all' : 'global',
        limit: RESEARCH_SESSION_PAGE_LIMIT,
      }
      if (cursor !== null) params.cursor = cursor
      const raw = await listChatSessions(projectId, params)
      const parsed = parseListResponse(raw)
      if (!parsed.ok) {
        const error = new Error(parsed.error.message) as Error & { code: string }
        error.code = parsed.error.code ?? CLIENT_ERROR_CODES.invalidResponse
        throw error
      }
      return {
        items: parsed.value.items,
        nextCursor: parsed.value.nextCursor,
        legacySource: false,
      }
    },
    [projectId, surface, sourceId, projectHistory],
  )

  const resetForKeyChange = useCallback(() => {
    requestIdRef.current += 1
    inFlightRef.current = false
    setPages([])
    setLoading(false)
    setLoadingMore(false)
    setError(null)
    setLoadMoreError(null)
    setTerminalUnauthorized(false)
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
        setPages((previous) => (mode === 'initial' ? [page] : [...previous, page]))
        if (mode === 'initial') {
          setError(null)
          setTerminalUnauthorized(false)
        }
      } catch (caught) {
        if (requestIdRef.current !== requestId) return
        const kind = classifyListError(caught, surface)
        if (mode === 'initial') {
          // 403/404 清列表内容；5xx/网络保留已有列表并允许重试，不自动创建
          // 新会话（DESIGN §4.1 末尾）。
          if (kind !== 'unavailable') setPages([])
          setError(kind)
          if (kind === 'unauthorized') {
            // 终态：不进入重试循环，清该列表内容缓存（R7），不 dispose runtime。
            setTerminalUnauthorized(true)
            if (queryKey && queryClient) queryClient.removeQueries({ queryKey, exact: true })
          }
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
    [canList, projectId, fetchPage, surface, queryKey, queryClient],
  )

  const loadRef = useRef(load)
  loadRef.current = load

  // 身份/门禁变化：清空内存态并（在新身份可列表时）重新加载（S1）。
  useEffect(() => {
    resetForKeyChange()
    if (canList) void loadRef.current('initial')
  }, [identityKey, canList, surface, sourceId, resetForKeyChange])

  // 显式刷新（打开历史抽屉/重试）：不做身份级 reset，5xx 时保留已有列表
  // （DESIGN §4.1 末尾：保留已有列表与本机稿、显示重试）。
  const refresh = useCallback(() => {
    requestIdRef.current += 1
    inFlightRef.current = false
    setError(null)
    setLoadMoreError(null)
    if (canList) void loadRef.current('initial')
  }, [canList])

  const loadMore = useCallback(() => {
    void loadRef.current('more')
  }, [])

  // ── 去重合并（按 sessionKey，跨页重复保留首见） ──
  const sessions = useMemo(() => {
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
  }, [pages])

  const hasMore = useMemo(() => {
    const lastPage = pages[pages.length - 1]
    if (!lastPage) return false
    if (lastPage.legacySource) {
      // 旧读路径固定 limit 且无 cursor：以“本页是否满页”作为是否还提供
      // “加载更多”的启发式（**不**据此断言历史总量；§4.1 排序不稳定限制）。
      return lastPage.items.length >= RESEARCH_SOURCE_SESSION_PAGE_LIMIT
    }
    return lastPage.nextCursor !== null
  }, [pages])

  // ── 创建（§4.3：显式触发、single-flight、幂等重试复用 client session_id） ──
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<ResearchSessionCreateError | null>(null)
  const [created, setCreated] = useState<ResearchSessionCreateResult | null>(null)
  const createInFlightRef = useRef(false)
  const pendingSessionIdRef = useRef<string | null>(null)

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
    const requestId = requestIdRef.current
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
      if (!parsed) {
        // 响应形状非法：服务端可能已创建 → 保留 client session_id 供下次
        // 重试命中 `created=false`（不生成新 id、不产生空壳列表项）。
        setCreateError('invalid_response')
        return null
      }
      if (requestIdRef.current !== requestId) return null
      pendingSessionIdRef.current = null
      setCreated(parsed)
      setCreateError(null)
      // 列表摘要按服务端事实更新：下一轮刷新/打开抽屉时可见（§4.1 列表更新）。
      if (queryKey && queryClient) void queryClient.invalidateQueries({ queryKey })
      return parsed
    } catch (caught) {
      if (requestIdRef.current !== requestId) return null
      const kind = classifyListError(caught, surface)
      setCreateError(kind === 'unauthorized' ? 'unauthorized' : 'failed')
      return null
    } finally {
      createInFlightRef.current = false
      setCreating(false)
    }
  }, [canCreate, projectId, surface, sourceId, queryKey, queryClient])

  const unauthorized = terminalUnauthorized || (snapshot?.unauthorized ?? false)
  const sourceUnavailable = error === 'source_unavailable'

  return {
    sessions,
    loading,
    loadingMore,
    error,
    loadMoreError,
    unauthorized,
    sourceUnavailable,
    hasMore,
    capabilitiesReady: capabilitiesOk,
    canList,
    canCreate,
    listDisabledReason,
    createDisabledReason,
    creating,
    createError,
    created,
    refresh,
    loadMore,
    create,
  }
}

/** mutation 选项导出给页面层复用（PR-1 判别键约定：Research mutation 不自动重试）。 */
export const RESEARCH_SESSIONS_MUTATION_OPTIONS = RESEARCH_MUTATION_OPTIONS
