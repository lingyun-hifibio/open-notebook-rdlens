import { QueryClient } from '@tanstack/react-query'
import type { Query } from '@tanstack/react-query'
import { isNotFoundError } from '@/lib/utils/error-handler'

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5 * 60 * 1000, // 5 minutes
      gcTime: 10 * 60 * 1000, // 10 minutes
      // Retry transient failures, but never retry 404s: the item was
      // deleted (or never existed) and retrying cannot change that.
      retry: (failureCount, error) => !isNotFoundError(error) && failureCount < 2,
      refetchOnWindowFocus: false,
    },
    mutations: {
      retry: 1,
    },
  },
})

export const QUERY_KEYS = {
  notebooks: ['notebooks'] as const,
  notebook: (id: string) => ['notebooks', id] as const,
  notes: (notebookId?: string) => ['notes', notebookId] as const,
  note: (id: string) => ['notes', id] as const,
  sources: (notebookId?: string) => ['sources', notebookId] as const,
  sourcesInfinite: (notebookId: string) => ['sources', 'infinite', notebookId] as const,
  source: (id: string) => ['sources', id] as const,
  settings: ['settings'] as const,
  sourceChatSessions: (sourceId: string) => ['source-chat', sourceId, 'sessions'] as const,
  sourceChatSession: (sourceId: string, sessionId: string) => ['source-chat', sourceId, 'sessions', sessionId] as const,
  notebookChatSessions: (notebookId: string) => ['notebook-chat', notebookId, 'sessions'] as const,
  notebookChatSession: (sessionId: string) => ['notebook-chat', 'sessions', sessionId] as const,
  podcastEpisodes: ['podcasts', 'episodes'] as const,
  podcastEpisode: (episodeId: string) => ['podcasts', 'episodes', episodeId] as const,
  episodeProfiles: ['podcasts', 'episode-profiles'] as const,
  speakerProfiles: ['podcasts', 'speaker-profiles'] as const,
  languages: ['languages'] as const,
  // UI-02：Research Gateway 项目级查询键（与上游 notebook 域完全隔离）
  research: (projectId: string) => ['research', projectId] as const,
  researchSources: (projectId: string) => ['research', projectId, 'sources'] as const,
  researchSource: (projectId: string, sourceId: string) => ['research', projectId, 'sources', sourceId] as const,
  researchNotes: (projectId: string) => ['research', projectId, 'notes'] as const,
  researchInsights: (projectId: string) => ['research', projectId, 'insights'] as const,
  researchTransformations: (projectId: string) => ['research', projectId, 'transformations'] as const,
  // RWV2-20/21：Transformation Result 历史（独立于模板 key；run onSuccess 只失效此 key）
  researchTransformationResults: (projectId: string) => ['research', projectId, 'transformation-results'] as const,
  researchTransformationResult: (projectId: string, resultId: string) => ['research', projectId, 'transformation-results', resultId] as const,
  // #243 GMOD：全局模型/偏好/外发确认（Research 根级 shared settings）
  researchModelCatalog: (projectId: string) => ['research', projectId, 'model-catalog'] as const,
  researchExecutionPreferences: (projectId: string) => ['research', projectId, 'execution-preferences'] as const,
  researchEgressConsent: (projectId: string) => ['research', projectId, 'egress-consent'] as const,
}

/**
 * Research mutation 的默认选项（RDLens #602 第三批 PR-1，DESIGN §3.2）。
 *
 * 全局 mutation 默认 `retry:1`：认证代际切换后旧 mutation 失败若自动重试，
 * 会带着**新 token** 重发旧身份请求。Research 域一律 `retry:0`；需要重试的
 * 操作必须自行捕获 `{viewerUserId, authGeneration, projectId}` 并在每次派发
 * 前复核身份。
 *
 * 注意：只用于本 PR 触及的调用点，不修改全局 `defaultOptions.mutations.retry`，
 * 以免改变非 Research 行为（PR-1 决策 R2）。
 */
export const RESEARCH_MUTATION_OPTIONS = { retry: 0 } as const

/**
 * Research 私有查询键的判别身份（DESIGN §3.2）：
 * - owner：`{role:'owner', viewerUserId, projectId, authGeneration}`；
 * - Admin 只读：`{role:'admin_readonly', projectId, authGeneration}`，
 *   不需要 viewer，也**不得**读取 owner 的本机分区。
 */
export interface ResearchQueryIdentity {
  readonly role: 'owner' | 'admin_readonly'
  readonly projectId: string
  readonly authGeneration: number
  /** 仅 owner 身份携带（服务端 `viewer_user_id` 的字符串形式）。 */
  readonly viewerUserId?: string
}

/** 追加在 Query 键尾部的身份段标记（与普通过滤器对象区分）。 */
const RESEARCH_IDENTITY_MARKER = 'research-identity' as const

function isResearchIdentitySegment(value: unknown): value is ResearchQueryIdentity & { kind: typeof RESEARCH_IDENTITY_MARKER } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const candidate = value as Record<string, unknown>
  return (
    candidate.kind === RESEARCH_IDENTITY_MARKER &&
    (candidate.role === 'owner' || candidate.role === 'admin_readonly') &&
    typeof candidate.projectId === 'string' &&
    typeof candidate.authGeneration === 'number'
  )
}

function identitySegment(identity: ResearchQueryIdentity): ResearchQueryIdentity & { kind: typeof RESEARCH_IDENTITY_MARKER } {
  if (identity.role === 'owner') {
    if (typeof identity.viewerUserId !== 'string' || identity.viewerUserId.length === 0) {
      throw new Error('owner research identity requires viewerUserId')
    }
    return {
      kind: RESEARCH_IDENTITY_MARKER,
      role: 'owner',
      projectId: identity.projectId,
      authGeneration: identity.authGeneration,
      viewerUserId: identity.viewerUserId,
    }
  }
  // Admin 只读：不带 viewer，避免把 owner 身份混进 Admin 分区。
  return {
    kind: RESEARCH_IDENTITY_MARKER,
    role: 'admin_readonly',
    projectId: identity.projectId,
    authGeneration: identity.authGeneration,
  }
}

/** owner 查询身份（viewer 必须已确认且非空）。 */
export function ownerResearchIdentity(
  projectId: string,
  viewerUserId: string,
  authGeneration: number,
): ResearchQueryIdentity {
  return { role: 'owner', projectId, viewerUserId, authGeneration }
}

/** Admin 只读查询身份（不伪造 viewer、不读 owner 分区）。 */
export function adminReadonlyResearchIdentity(
  projectId: string,
  authGeneration: number,
): ResearchQueryIdentity {
  return { role: 'admin_readonly', projectId, authGeneration }
}

/** 身份相等比较：owner 比较 viewer；admin 不比较 viewer。 */
export function researchIdentityEquals(
  left: ResearchQueryIdentity | null | undefined,
  right: ResearchQueryIdentity | null | undefined,
): boolean {
  if (left === right) return true
  if (!left || !right) return false
  if (left.role !== right.role) return false
  if (left.projectId !== right.projectId) return false
  if (left.authGeneration !== right.authGeneration) return false
  if (left.role === 'owner' && left.viewerUserId !== right.viewerUserId) return false
  return true
}

/**
 * 构造带判别身份的 Research 查询键：
 * `['research', projectId, ...domainSegments, identitySegment]`。
 *
 * 身份段追加在**尾部**，因此沿用旧前缀失效（如
 * `invalidateQueries({queryKey:['research',projectId,'notes']})`）仍能命中
 * 所有代际/身份的同类查询；不同 viewer/代际不会互相串读。
 */
export function researchQueryKey(
  identity: ResearchQueryIdentity,
  ...domainSegments: readonly unknown[]
): readonly unknown[] {
  if (identity.projectId.length === 0) {
    throw new Error('research query key requires projectId')
  }
  return ['research', identity.projectId, ...domainSegments, identitySegment(identity)]
}

/** 判别键：Sources 列表。 */
export function researchSourcesIdentityKey(identity: ResearchQueryIdentity): readonly unknown[] {
  return researchQueryKey(identity, 'sources')
}

/** 判别键：Notes 列表（搜索词保留在身份段之前，保前缀失效）。 */
export function researchNotesIdentityKey(
  identity: ResearchQueryIdentity,
  search = '',
): readonly unknown[] {
  return researchQueryKey(identity, 'notes', search)
}

/** 判别键：模型目录。 */
export function researchModelCatalogIdentityKey(identity: ResearchQueryIdentity): readonly unknown[] {
  return researchQueryKey(identity, 'model-catalog')
}

/** 判别键：执行偏好（PATCH 回填）。 */
export function researchExecutionPreferencesIdentityKey(identity: ResearchQueryIdentity): readonly unknown[] {
  return researchQueryKey(identity, 'execution-preferences')
}

/** 判别键：外发（egress）consent。 */
export function researchEgressConsentIdentityKey(identity: ResearchQueryIdentity): readonly unknown[] {
  return researchQueryKey(identity, 'egress-consent')
}

function identityFromQuery(query: Query): ResearchQueryIdentity | null {
  const last = query.queryKey[query.queryKey.length - 1]
  if (!isResearchIdentitySegment(last)) return null
  return last
}

export interface PurgeResearchAuthScopeOptions {
  readonly projectId: string
  /**
   * 当前代际/身份。`null` 表示已无有效身份（登出/destroy），清除项目内全部
   * Research 私有缓存。旧代或无身份标记（迁移前的旧键）的查询一律移除。
   */
  readonly current: ResearchQueryIdentity | null
}

/**
 * 认证切换时清理旧代 Research 缓存（DESIGN §3.2）：
 * 1. `cancelQueries` 中止旧代在途请求（**不是** mutation 已取消证明）；
 * 2. `removeQueries` 移除旧代/无身份标记的查询缓存；
 * 3. 当前身份对应的缓存保留（同 viewer refresh 复用，不丢内存态）。
 *
 * 返回移除的查询数（用于测试/诊断）。
 */
export async function purgeResearchAuthScope(
  client: QueryClient,
  options: PurgeResearchAuthScopeOptions,
): Promise<number> {
  const { projectId, current } = options
  const scopeKey = ['research', projectId] as const
  const queries = client.getQueryCache().findAll({ queryKey: scopeKey })
  await client.cancelQueries({ queryKey: scopeKey })
  let removed = 0
  for (const query of queries) {
    const identity = identityFromQuery(query)
    if (current !== null && researchIdentityEquals(identity, current)) {
      continue
    }
    client.removeQueries({ queryKey: query.queryKey, exact: true })
    removed += 1
  }
  return removed
}
