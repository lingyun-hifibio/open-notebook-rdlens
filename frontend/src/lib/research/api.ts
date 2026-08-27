/**
 * Research Gateway API（UI-02 + UI-03 合并，契约 v0 §6/§7/§8/§9/§10；
 * REQ-API-01/02、REQ-DIS-01/02/03、REQ-SRC-04）。
 *
 * 全部请求经 UI-01 `apiClient`——嵌入式模式下 baseURL 只指向 RDLens
 * Research Gateway（REQ-DEP-02），路径精确匹配白名单 §3.7，绝不带
 * `/api` 上游前缀，绝不触达 Open Notebook 原生 API。
 *
 * 契约要点（与后端 `research/router.py` 一致）：
 * - Source 只读（GET 列表/详情）；同步重试仅 Admin（UI-04），Owner 无入口；
 * - Note 保存永不触发 Embedding（REQ-DIS-01）：载荷仅 title/content；
 * - Transformation 仅 prompt-only（REQ-DIS-03）：载荷仅 name/
 *   prompt_template/model_id/scope，无 code/tool/url 字段；
 * - Transformation 运行只走 Gateway run 端点（REQ-DIS-02）；
 * - Search/Chat/Compare/Job 端点（UI-03，契约 §8.1–§8.3/§10）：Chat 为
 *   fetch SSE 流（Bearer=内存 Token、`Last-Event-ID` 重连、409/网络错误
 *   分类）；Compare/Job 为持久任务端点；
 * - 嵌入式模式必配 Gateway，未配置 fail-closed 抛错（REQ-DEP-02）。
 */

import { apiClient } from '@/lib/api/client'
import { getAuthToken } from '@/lib/auth-token'
import { isEmbeddedMode, getEmbeddedGatewayUrl } from '@/lib/embedded/config'
import { getResearchToken } from '@/lib/embedded/token-store'
import { parseSseFrame } from './sse'
import type {
  ResearchChatRequest,
  ResearchCompareCreateRequest,
  ResearchCompareCreateResponse,
  ResearchContextPreview,
  ResearchEgressConsentResponse,
  ResearchExecutionPreferences,
  ResearchJob,
  ResearchModelOption,
  ResearchSearchOutcome,
  ResearchSearchRequest,
  ResearchSearchResponse,
  ResearchSourceRef,
  ResearchSseEvent,
  ResearchTokenUsage,
} from './types'
import type {
  ResearchCitation as ResearchCitationSnapshot,
} from '@/lib/types/research'
import type {
  ResearchExport,
  ResearchInsight,
  ResearchNote,
  ResearchPage,
  ResearchSource,
  ResearchSourceDetail,
  ResearchTransformation,
  TransformationRunResult,
} from '@/lib/types/research'

const researchPath = (projectId: string, ...segments: string[]): string =>
  `/v1/research/projects/${projectId}${segments.length > 0 ? `/${segments.join('/')}` : ''}`

// ── Sources（契约 §6；只读；status: pending/ready/stale/failed） ──

export async function listSources(projectId: string): Promise<ResearchPage<ResearchSource>> {
  const response = await apiClient.get<ResearchPage<ResearchSource>>(
    researchPath(projectId, 'sources'),
  )
  return response.data
}

export async function getSource(
  projectId: string,
  sourceId: string,
): Promise<ResearchSourceDetail> {
  const response = await apiClient.get<ResearchSourceDetail>(
    researchPath(projectId, 'sources', sourceId),
  )
  return response.data
}

// ── Notes（契约 §7.1；Owner 写 / Admin 403 服务端强制） ──

export interface CreateNoteInput {
  title: string
  content: string
}

export interface UpdateNoteInput {
  title?: string
  content?: string
}

export async function listNotes(
  projectId: string,
  params: { q?: string; cursor?: string; limit?: number } = {},
): Promise<ResearchPage<ResearchNote>> {
  const response = await apiClient.get<ResearchPage<ResearchNote>>(
    researchPath(projectId, 'notes'),
    { params },
  )
  return response.data
}

export async function createNote(
  projectId: string,
  input: CreateNoteInput,
): Promise<ResearchNote> {
  const response = await apiClient.post<ResearchNote>(
    researchPath(projectId, 'notes'),
    input,
  )
  return response.data
}

export async function updateNote(
  projectId: string,
  noteId: string,
  input: UpdateNoteInput,
): Promise<ResearchNote> {
  const response = await apiClient.patch<ResearchNote>(
    researchPath(projectId, 'notes', noteId),
    input,
  )
  return response.data
}

export async function deleteNote(projectId: string, noteId: string): Promise<void> {
  await apiClient.delete(researchPath(projectId, 'notes', noteId))
}

// ── Insights（契约 §7.2；manual 用户提供 / ai 携带已批准 model_id） ──

export interface CreateInsightInput {
  title: string
  content: string
  insight_type: 'ai' | 'manual'
  model_id?: string | null
}

export async function listInsights(
  projectId: string,
  params: { insight_type?: string; cursor?: string; limit?: number } = {},
): Promise<ResearchPage<ResearchInsight>> {
  const response = await apiClient.get<ResearchPage<ResearchInsight>>(
    researchPath(projectId, 'insights'),
    { params },
  )
  return response.data
}

export async function createInsight(
  projectId: string,
  input: CreateInsightInput,
): Promise<ResearchInsight> {
  const response = await apiClient.post<ResearchInsight>(
    researchPath(projectId, 'insights'),
    input,
  )
  return response.data
}

// ── Transformations（契约 §7.3；prompt-only，REQ-DIS-03） ──

export interface CreateTransformationInput {
  name: string
  prompt_template: string
  model_id: string
  scope: 'admin_template' | 'project_private'
}

export async function listTransformations(
  projectId: string,
  params: { cursor?: string; limit?: number } = {},
): Promise<ResearchPage<ResearchTransformation>> {
  const response = await apiClient.get<ResearchPage<ResearchTransformation>>(
    researchPath(projectId, 'transformations'),
    { params },
  )
  return response.data
}

export async function createTransformation(
  projectId: string,
  input: CreateTransformationInput,
): Promise<ResearchTransformation> {
  const response = await apiClient.post<ResearchTransformation>(
    researchPath(projectId, 'transformations'),
    input,
  )
  return response.data
}

export async function runTransformation(
  projectId: string,
  transformationId: string,
  input: { source_ids: string[]; note_ids: string[] },
): Promise<TransformationRunResult> {
  const response = await apiClient.post<TransformationRunResult>(
    researchPath(projectId, 'transformations', transformationId, 'run'),
    input,
  )
  return response.data
}

// ── 导出（契约 §7.4；Owner/Admin 均可，均审计） ──

export const EXPORT_ARTIFACTS = 'note,insight,transformation_result'

export async function createExport(projectId: string): Promise<ResearchExport> {
  const response = await apiClient.get<ResearchExport>(researchPath(projectId, 'export'), {
    params: { artifacts: EXPORT_ARTIFACTS },
  })
  return response.data
}

/** 下载导出文件（经 Gateway 鉴权；下载路径来自 export.download_url）。 */
export async function downloadExport(projectId: string, downloadUrl: string): Promise<Blob> {
  const response = await apiClient.get<Blob>(downloadUrl, { responseType: 'blob' })
  return response.data
}

// ── Search / Chat / Compare / Jobs（UI-03，契约 §8.1–§8.3/§10） ──

export const RESEARCH_API_PREFIX = '/v1/research/projects'

/** 嵌入式模式必配 Gateway；未配置或非嵌入式 → fail-closed 抛错 */
export function requireResearchGateway(): string {
  if (!isEmbeddedMode()) {
    throw new Error('research workspace requires embedded mode')
  }
  const url = getEmbeddedGatewayUrl()
  if (!url) {
    throw new Error('NEXT_PUBLIC_RD_GATEWAY_URL is not configured for embedded mode')
  }
  return url
}

export function buildResearchUrl(projectId: string, path: string): string {
  return `${RESEARCH_API_PREFIX}/${encodeURIComponent(projectId)}${path}`
}

/** 当前请求使用的 Bearer Token（嵌入式取内存 Research Token） */
export function researchBearerToken(): string | null {
  return isEmbeddedMode() ? getResearchToken() : getAuthToken()
}

export async function search(
  projectId: string,
  request: ResearchSearchRequest,
): Promise<ResearchSearchResponse> {
  const response = await apiClient.post<ResearchSearchResponse>(
    researchPath(projectId, 'search'),
    request,
  )
  return response.data
}

// ── Contract v1（Issue #200 Phase 2b，§14.2/§14.3） ──

/** v1 幂等键：每次用户发起的新执行一个键；重试同一请求复用同键。 */
export function newIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return `ui-${crypto.randomUUID()}`
  }
  return `ui-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

export async function listModels(
  projectId: string,
): Promise<{ models: ResearchModelOption[] }> {
  const response = await apiClient.get<{ models: ResearchModelOption[] }>(
    researchPath(projectId, 'models'),
  )
  return response.data
}

export async function getExecutionPreferences(
  projectId: string,
): Promise<ResearchExecutionPreferences> {
  const response = await apiClient.get<ResearchExecutionPreferences>(
    researchPath(projectId, 'execution-preferences'),
  )
  return response.data
}

export interface SaveExecutionPreferencesInput {
  default_context_level: ResearchExecutionPreferences['default_context_level']
  preferred_model_id: string | null
}

export async function saveExecutionPreferences(
  projectId: string,
  input: SaveExecutionPreferencesInput,
): Promise<ResearchExecutionPreferences> {
  const response = await apiClient.put<ResearchExecutionPreferences>(
    researchPath(projectId, 'execution-preferences'),
    input,
  )
  return response.data
}

export type ResearchContextPreviewRequest = {
  context_level: 'focused' | 'document' | 'workspace'
  source_ids: string[]
  note_ids: string[]
  question: string
}

export async function fetchContextPreview(
  projectId: string,
  request: ResearchContextPreviewRequest,
): Promise<ResearchContextPreview> {
  const response = await apiClient.post<ResearchContextPreview>(
    researchPath(projectId, 'context-preview'),
    request,
  )
  return response.data
}

/** Issue #202 Phase 3b：Workspace 外发确认（§6.3/§14.2 用户侧端点）。 */

export async function getExternalEgressConsent(
  projectId: string,
): Promise<ResearchEgressConsentResponse> {
  const response = await apiClient.get<ResearchEgressConsentResponse>(
    researchPath(projectId, 'external-egress-consent'),
  )
  return response.data
}

export async function acknowledgeExternalEgressConsent(
  projectId: string,
): Promise<ResearchEgressConsentResponse> {
  const response = await apiClient.post<ResearchEgressConsentResponse>(
    researchPath(projectId, 'external-egress-consent'),
    {},
  )
  return response.data
}

export async function revokeExternalEgressConsent(
  projectId: string,
): Promise<ResearchEgressConsentResponse> {
  const response = await apiClient.delete<ResearchEgressConsentResponse>(
    researchPath(projectId, 'external-egress-consent'),
  )
  return response.data
}

/**
 * v1 Search：发送契约头并按 HTTP status + Content-Type 判别分支。
 *
 * §14.3：status 与 Content-Type 双条件——200 application/json =
 * direct 结果；202 application/json = 后台 Job 受理（generation_id/
 * job_id）。非 JSON 的 2xx（反代错误页等）fail-closed 抛错，不猜测。
 */
export async function searchV1(
  projectId: string,
  request: ResearchSearchRequest,
  options: { idempotencyKey?: string } = {},
): Promise<ResearchSearchOutcome> {
  // 幂等键由调用方决定复用策略；未提供时本次请求生成新键
  const idempotencyKey = options.idempotencyKey ?? newIdempotencyKey()
  const response = await apiClient.post<ResearchSearchResponse>(
    researchPath(projectId, 'search'),
    request,
    {
      headers: {
        'X-Research-Contract': 'v1',
        'Idempotency-Key': idempotencyKey,
      },
    },
  )
  const contentType = String(
    (response.headers?.['content-type'] as string | undefined) ?? '',
  )
  if (!contentType.includes('application/json')) {
    throw new Error(
      `unexpected search response content-type: ${contentType || 'none'}`,
    )
  }
  if (response.status === 200) {
    return { kind: 'direct', result: response.data }
  }
  if (response.status === 202) {
    const body = response.data as Partial<ResearchSearchResponse> & {
      generation_id?: string
      job_id?: string | null
      status?: string
    }
    return {
      kind: 'background',
      generation_id: String(body.generation_id ?? ''),
      job_id: body.job_id ?? null,
      status: String(body.status ?? 'queued'),
    }
  }
  throw new Error(`unexpected search response status: ${response.status}`)
}

export async function createCompare(
  projectId: string,
  request: ResearchCompareCreateRequest,
  options: { idempotencyKey?: string } = {},
): Promise<ResearchCompareCreateResponse> {
  // #238：v1 契约（Phase 6 锁死：无头/无幂等键 → 426/422）
  const idempotencyKey = options.idempotencyKey ?? newIdempotencyKey()
  const response = await apiClient.post<ResearchCompareCreateResponse>(
    researchPath(projectId, 'compare', 'jobs'),
    request,
    {
      headers: {
        'X-Research-Contract': 'v1',
        'Idempotency-Key': idempotencyKey,
      },
    },
  )
  return response.data
}

export async function getJob(projectId: string, jobId: string): Promise<ResearchJob> {
  const response = await apiClient.get<ResearchJob>(
    researchPath(projectId, 'jobs', jobId),
  )
  return response.data
}

export async function cancelJob(projectId: string, jobId: string): Promise<void> {
  await apiClient.post(researchPath(projectId, 'jobs', jobId, 'cancel'))
}

// ── Source Chat 会话（Issue #182；owner-only，Gateway 化专属端点） ──

/** Source-scoped Chat 会话摘要（契约：GET sessions items 元素） */
export interface ResearchSourceChatSessionSummary {
  session_id: string
  title: string | null
  source_id: string
  created_at: string
  updated_at: string
}

/**
 * 持久化消息（GET session detail，字段与 T2 响应模型对齐）。
 * Citation 为 17 字段快照（契约 §13.2）；resolved_mode/degradation_reasons/
 * usage 挂在 assistant 消息上，source_ref 仅 assistant 消息携带（可选，
 * 容错缺省）。
 */
export interface ResearchSourceChatMessage {
  message_id: string
  role: 'user' | 'assistant'
  content: string
  thinking?: string | null
  created_at?: string | null
  resolved_mode?: string | null
  degradation_reasons?: string[] | null
  source_ref?: ResearchSourceRef | null
  citations?: ResearchCitationSnapshot[] | null
  usage?: ResearchTokenUsage | null
}

/** GET session detail 响应（消息按 created_at ASC, message_id ASC 返回） */
export interface ResearchSourceChatSessionDetail {
  session: ResearchSourceChatSessionSummary
  messages: ResearchSourceChatMessage[]
  next_cursor: string | null
}

export async function listSourceChatSessions(
  projectId: string,
  sourceId: string,
  params: { limit?: number } = {},
): Promise<ResearchPage<ResearchSourceChatSessionSummary>> {
  const response = await apiClient.get<ResearchPage<ResearchSourceChatSessionSummary>>(
    researchPath(projectId, 'sources', sourceId, 'chat', 'sessions'),
    { params },
  )
  return response.data
}

export async function getSourceChatSession(
  projectId: string,
  sourceId: string,
  sessionId: string,
): Promise<ResearchSourceChatSessionDetail> {
  const response = await apiClient.get<ResearchSourceChatSessionDetail>(
    researchPath(projectId, 'sources', sourceId, 'chat', 'sessions', sessionId),
  )
  return response.data
}

/** SSE 流 HTTP 错误分类（含 409 resume_after） */
export class ResearchStreamHttpError extends Error {
  status: number
  body: unknown

  constructor(status: number, body: unknown) {
    super(`Research stream HTTP ${status}`)
    this.name = 'ResearchStreamHttpError'
    this.status = status
    this.body = body
  }
}

export interface ResearchChatStreamOptions {
  projectId: string
  request: ResearchChatRequest
  /**
   * SSE 端点路径（默认 `/chat` 全局多篇语义不变；Issue #182 source chat
   * 传 `/sources/{source_id}/chat`）。仅路径参数化，鉴权/帧解析共用。
   */
  path?: string
  /** #238：v1 契约幂等键；调用方复用策略决定，缺省新键 */
  idempotencyKey?: string
  /** 断线重连的 Last-Event-ID（0 = 从头开始） */
  lastEventId?: number
  /** 响应到达时读取一次响应头（Issue #182：X-Chat-Session-Id 回显） */
  onResponseMeta?: (headers: Headers) => void
  /** 流正常读尽（EOF）；是否重连由调用方按终态判定（Issue #182 恢复边界） */
  onEnd?: () => void
  /** 服务端事件（已按 event_id 校验） */
  onEvent: (event: ResearchSseEvent) => void
  /** 非 2xx（409 时 body.detail.resume_after 为服务端缓冲最早事件游标或 null） */
  onHttpError?: (status: number, body: unknown) => void
  /** 传输层错误（断线/网络不可达） */
  onNetworkError?: (error: Error) => void
}

/**
 * 打开 Research Chat SSE 流；返回中止函数（仅关闭本地读取，
 * 浏览器断开 ≠ 取消——服务端继续执行，契约 §9.6）。
 */
export function openResearchChatStream(options: ResearchChatStreamOptions): () => void {
  const controller = new AbortController()
  const url = `${requireResearchGateway()}${buildResearchUrl(options.projectId, options.path ?? '/chat')}`
  const token = researchBearerToken()

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
    // #238：v1 契约（Phase 6 锁死：生成 POST 必须带版本头 + 幂等键）
    'X-Research-Contract': 'v1',
    'Idempotency-Key': options.idempotencyKey ?? newIdempotencyKey(),
  }
  if (token) {
    headers.Authorization = `Bearer ${token}`
  }
  if (options.lastEventId && options.lastEventId > 0) {
    headers['Last-Event-ID'] = String(options.lastEventId)
  }

  fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(options.request),
    signal: controller.signal,
    cache: 'no-store',
  })
    .then(async (response) => {
      if (!response.ok) {
        let body: unknown = null
        try {
          body = await response.json()
        } catch {
          // 非 JSON 错误体：保留 null
        }
        options.onHttpError?.(response.status, body)
        return
      }
      if (!response.body) {
        options.onNetworkError?.(new Error('no response body'))
        return
      }
      // Issue #182：响应头只读一次透传（X-Chat-Session-Id 回显），不作行为依赖
      options.onResponseMeta?.(response.headers)
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          const frames = buffer.split('\n\n')
          buffer = frames.pop() ?? ''
          for (const frame of frames) {
            const event = parseSseFrame(frame)
            if (event) {
              options.onEvent(event)
            }
          }
        }
        // 正常读尽（EOF）：终态与否由调用方依 sse 状态判定；
        // 调用方 abort 的收尾不算 EOF（不触发 onEnd）
        if (!controller.signal.aborted) {
          options.onEnd?.()
        }
      } catch (error) {
        if ((error as Error).name !== 'AbortError') {
          options.onNetworkError?.(error as Error)
        }
      }
    })
    .catch((error) => {
      if ((error as Error).name !== 'AbortError') {
        options.onNetworkError?.(error as Error)
      }
    })

  return () => {
    controller.abort()
  }
}
