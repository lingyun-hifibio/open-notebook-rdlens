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
import {
  STREAM_IDLE_TIMEOUT_MS,
  createAttemptSettlement,
  hasRetrySemanticsStatus,
  isHeartbeatComment,
  isSseContentType,
  type ResearchStreamEndReason,
} from './c05-stream-guard'
import type { C05Budget } from './c05-preview-gate'
import type { C05ResolvedScope } from './c05-scope-projection'
import type {
  EditorSaveRequestWire,
  ResearchChatRequest,
  ResearchCompareCreateRequest,
  ResearchCompareCreateResponse,
  ResearchCompareReportResponse,
  ResearchContextPreview,
  ResearchCoverageReportResponse,
  ResearchEgressConsentResponse,
  ResearchExecutionPreferences,
  ResearchJob,
  ResearchModelsResponse,
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
  ResearchSaveFromResultRequest,
  ResearchSaveResultResponse,
  ResearchSource,
  ResearchSourceDetail,
  ResearchTransformation,
  TransformationResultRecord,
  TransformationRunResult,
} from '@/lib/types/research'
import { saveIdempotencyKey } from './save-idempotency'
import {
  SESSION_CONTRACT_HEADER,
  SESSION_CONTRACT_VERSION,
  type ResearchSessionRef,
} from './session-contract'

const researchPath = (projectId: string, ...segments: string[]): string =>
  `/v1/research/projects/${projectId}${segments.length > 0 ? `/${segments.join('/')}` : ''}`

// ── Sources（契约 §6；只读；status: pending/ready/stale/failed） ──

export async function listSources(
  projectId: string,
  params: { cursor?: string; limit?: number } = {},
  signal?: AbortSignal,
): Promise<ResearchPage<ResearchSource>> {
  const response = await apiClient.get<ResearchPage<ResearchSource>>(
    researchPath(projectId, 'sources'),
    { params, ...(signal ? { signal } : {}) },
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
  signal?: AbortSignal,
): Promise<ResearchPage<ResearchNote>> {
  const response = await apiClient.get<ResearchPage<ResearchNote>>(
    researchPath(projectId, 'notes'),
    { params, ...(signal ? { signal } : {}) },
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
  input: {
    source_ids: string[]
    note_ids: string[]
    model_id: string
    /** RWV2-35（RDLens 迁移 v9）：admin 双语模板显式选中的变体语言；
     *  仅当 UI 语言选择器选中时发送；单 prompt（project/legacy）不发——
     *  服务端按 content 检测。缺省 = 服务端默认（admin 双语无指令 → en）。 */
    response_language?: 'zh' | 'en'
  },
  options: { idempotencyKey?: string } = {},
): Promise<TransformationRunResult> {
  // v1 契约（Phase 6，`contract_v1_enabled`）：无 X-Research-Contract/
  // Idempotency-Key → 426/422。Rerun 为新建派发，每次必须生成新幂等键
  //（复用旧 key 会被后端幂等重放/409，不会新建结果）。
  const idempotencyKey = options.idempotencyKey ?? newIdempotencyKey()
  const response = await apiClient.post<TransformationRunResult>(
    researchPath(projectId, 'transformations', transformationId, 'run'),
    input,
    {
      headers: {
        'X-Research-Contract': 'v1',
        'Idempotency-Key': idempotencyKey,
      },
    },
  )
  return response.data
}

// ── Transformation Result 历史（RWV2-20 / Issue #330；只读，Owner/Admin） ──

/** 分页列出 Transformation Result 历史（服务端 keyset cursor；list 项含完整输出）。 */
export async function listTransformationResults(
  projectId: string,
  params: { cursor?: string; limit?: number } = {},
): Promise<ResearchPage<TransformationResultRecord>> {
  const response = await apiClient.get<ResearchPage<TransformationResultRecord>>(
    researchPath(projectId, 'transformation-results'),
    { params },
  )
  return response.data
}

/** 读取单条 Transformation Result 详情（非法/不存在/跨项目 → 后端 404 非泄露）。 */
export async function getTransformationResult(
  projectId: string,
  resultId: string,
): Promise<TransformationResultRecord> {
  const response = await apiClient.get<TransformationResultRecord>(
    researchPath(projectId, 'transformation-results', resultId),
  )
  return response.data
}

// ── Save-as-Insight/Note（RWV2-22 / Issue #331；RWV2-23 / Issue #43 消费） ──

/**
 * 把已持久化的 Search/Chat/Transformation 结果显式保存为 Insight 或 Note。
 *
 * - 只发送 origin_kind/origin_id/destination_kind/可选 title（extra=forbid
 *   域：正文/Citation/provenance 由服务端从项目内持久源解析，不信任客户端）；
 * - 幂等键默认取确定性键（saveIdempotencyKey，D3）：同一逻辑保存恒同 key，
 *   服务端重放返回原 artifact（200）；调用方仅在测试/特殊重放场景显式覆盖；
 * - 返回 note/insight detail 视图（含 citations + provenance），按
 *   `note_id`/`insight_id` 判别目标类型。
 */
export async function saveResultFromResult(
  projectId: string,
  request: ResearchSaveFromResultRequest,
  options: { idempotencyKey?: string } = {},
): Promise<ResearchSaveResultResponse> {
  const title = request.title?.trim()
  // 空白 title 视为未提供（与后端 L5 语义一致）；>128 截断防御（后端上限）。
  const body = title
    ? { ...request, title: title.slice(0, 128) }
    : {
        origin_kind: request.origin_kind,
        origin_id: request.origin_id,
        destination_kind: request.destination_kind,
      }
  const idempotencyKey =
    options.idempotencyKey ??
    saveIdempotencyKey(
      projectId,
      request.origin_kind,
      request.origin_id,
      request.destination_kind,
    )
  const response = await apiClient.post<ResearchSaveResultResponse>(
    researchPath(projectId, 'save-result'),
    body,
    {
      headers: {
        'X-Research-Contract': 'v1',
        'Idempotency-Key': idempotencyKey,
      },
    },
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

/**
 * #358：从 axios/网络错误中解析后端结构化 `detail.code` / `detail.message`
 * （FastAPI HTTPException 的 detail 对象形态）。解析失败返回双 null，调用方
 * 兜底用原始 error.message——用户不再看到无解释的通用 Axios 503。
 *
 * 兼容形态：
 * - `{ detail: { code, message } }`——#358 后端结构化错误；
 * - `{ detail: 'string' }`——纯字符串 detail；
 * - `{ detail: { message } }`——对象但无 code。
 */
export interface ResearchApiErrorDetail {
  code: string | null
  message: string | null
}

export function researchApiErrorDetail(error: unknown): ResearchApiErrorDetail {
  const data = (error as { response?: { data?: unknown } } | null)?.response?.data
  const detail = (data as { detail?: unknown } | null)?.detail
  if (typeof detail === 'string' && detail) {
    return { code: null, message: detail }
  }
  if (typeof detail === 'object' && detail !== null) {
    const code = (detail as { code?: unknown }).code
    const message = (detail as { message?: unknown }).message
    return {
      code: typeof code === 'string' && code ? code : null,
      message: typeof message === 'string' && message ? message : null,
    }
  }
  return { code: null, message: null }
}

export async function listModels(
  projectId: string,
): Promise<ResearchModelsResponse> {
  const response = await apiClient.get<ResearchModelsResponse>(
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

/**
 * #243 GMOD：PATCH 部分更新输入——只携带请求实际出现的字段。保存模型
 * 只 PATCH preferred_model_id；保存 Search 上下文只 PATCH
 * default_context_level（互不覆盖，计划 §6.1）。显式 `null` 表示清除
 * 模型选择（后端区分字段缺失与显式 null）。
 */
export interface PatchExecutionPreferencesInput {
  preferred_model_id?: string | null
  default_context_level?: ResearchExecutionPreferences['default_context_level']
}

export async function patchExecutionPreferences(
  projectId: string,
  input: PatchExecutionPreferencesInput,
): Promise<ResearchExecutionPreferences> {
  const response = await apiClient.patch<ResearchExecutionPreferences>(
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
  /** #243 GMOD §6.7：新正式前端 required——始终发送 confirmed global model */
  model_id: string
}

/**
 * PR5（R2-M10/D-12）：只读 C-05 Preview（#748 实际响应形状，主仓
 * `50c6e415` 的 `c05_preview_response` schema）。
 * 服务端 preview_supported=false 时以 503 c05_entry_not_ready 拒绝——
 * 调用方 catch 后 budget=null（D-12：缺失不阻断、显示"未经预览校验"）。
 * 只读约束：无 Generation/Job/配额预留/模型调用/检索。
 */
export interface C05PreviewAvailability {
  source_versions: number | null
  chunks: number | null
  requested_notes: number | null
  nonempty_notes: number | null
}

export interface C05PreviewResponse {
  scope_contract_version: 'c05-v1'
  resolved_scope: C05ResolvedScope
  availability: C05PreviewAvailability
  budget: C05Budget
  execution_hint: 'interactive' | 'background_job' | null
  needs_consent: boolean
  /** 上下文 warnings（非范围投影 warnings；#748 实际为稳定码字符串数组）。 */
  warnings: string[]
}

export async function fetchC05Preview(
  projectId: string,
  request: {
    entry: 'search'
    question: string
    model_id: string
    context_level: string
    source_scope: { mode: 'all' | 'selected' | 'single'; source_ids: string[]; single_source_id: string | null }
    note_ids: string[]
  },
): Promise<C05PreviewResponse> {
  const response = await apiClient.post<C05PreviewResponse>(
    researchPath(projectId, 'context-preview'),
    request,
    { headers: { 'X-Research-Contract': 'c05-v1' } },
  )
  return response.data
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
  options: { idempotencyKey?: string; contract?: 'v1' | 'c05-v1' } = {},
): Promise<ResearchSearchOutcome> {
  // 幂等键由调用方决定复用策略；未提供时本次请求生成新键
  const idempotencyKey = options.idempotencyKey ?? newIdempotencyKey()
  // PR5（B3）：契约头显式分支——C-05 请求必须携带 c05-v1 头；旧分支 v1 不变
  const contract = options.contract ?? 'v1'
  const response = await apiClient.post<ResearchSearchResponse>(
    researchPath(projectId, 'search'),
    request,
    {
      headers: {
        'X-Research-Contract': contract,
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
      // §3.3：202 与 200 同一投影——**不得**在这里裁掉（评审 MEDIUM-7）
      scope_contract_version: (body as Record<string, unknown>).scope_contract_version,
      resolved_scope: (body as Record<string, unknown>).resolved_scope,
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

/**
 * 项目内 Job 列表（Issue #311：跨设备恢复查看；RDLens 后端 keyset
 * 分页 created_at DESC）。读端点：与 getJob/listNotes 同款，不发
 * X-Research-Contract v1 头。恢复/刷新路径调用方传 limit=100 拉满
 * 服务端单页上限（老的非终态任务不掉出第一页）。
 */
export async function listJobs(
  projectId: string,
  params: { cursor?: string; limit?: number } = {},
): Promise<ResearchPage<ResearchJob>> {
  const response = await apiClient.get<ResearchPage<ResearchJob>>(
    researchPath(projectId, 'jobs'),
    { params },
  )
  return response.data
}

export async function cancelJob(projectId: string, jobId: string): Promise<void> {
  await apiClient.post(researchPath(projectId, 'jobs', jobId, 'cancel'))
}

// ── Coverage（COV-08 §12.1/§12.2；COV-09 UI 消费） ──

/** all_selected 提交响应：202 JSON（Generation/Job 标识，不走 SSE） */
export interface CoverageChatResponse {
  generation_id: string
  job_id: string
  status: string
  session_id: string
}

/**
 * #602 第三批 PR-5b（DESIGN §9.6）：Coverage 受理必须是真实的 **202 +
 * generation/job 标识**。非 202（含通用 200 兜底）都不得进入“已受理”状态，
 * 否则调用方会错误清空本地 Coverage 输入。
 */
export class CoverageAcceptanceError extends Error {
  readonly code = 'coverage_acceptance_invalid' as const

  constructor(message: string) {
    super(message)
    this.name = 'CoverageAcceptanceError'
  }
}

const isValidGenerationId = (value: unknown): value is string =>
  typeof value === 'string' && /^(?:gen|s)_[A-Za-z0-9._:-]+$/.test(value)

const isValidJobId = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0

/**
 * all_selected 提交：POST /chat 携带 synthesis_scope，202 返回持久
 * research_coverage Job 标识。幂等键每次用户发起新覆盖任务一个键
 * （同键同参数可重入，同键改参 409）。
 */
export async function createCoverageChat(
  projectId: string,
  request: {
    query: string
    /** 旧 v1：显式集合；C-05 分支禁用（改走 source_scope，且恒空 note_ids） */
    source_ids?: string[]
    note_ids?: string[]
    model_id: string
    session_id?: string
    synthesis_scope: 'all_selected'
    /** PR5/R1-H7：C-05 分支载荷（仅 c05-v1 契约头携带） */
    source_scope?: {
      mode: 'all' | 'selected' | 'single'
      source_ids: string[]
      single_source_id: string | null
    }
  },
  idempotencyKey: string,
  options: { contract?: 'v1' | 'c05-v1' } = {},
): Promise<CoverageChatResponse> {
  const response = await apiClient.post<CoverageChatResponse>(
    researchPath(projectId, 'chat'),
    request,
    {
      headers: {
        // R1-H7：契约头显式分支（能力就绪 → c05-v1；缺省 v1 不变）
        'X-Research-Contract': options.contract ?? 'v1',
        'Idempotency-Key': idempotencyKey,
      },
    },
  )
  if (response.status !== 202) {
    throw new CoverageAcceptanceError(
      `coverage submission was not accepted (status ${response.status})`,
    )
  }
  const accepted = response.data
  if (!isValidGenerationId(accepted?.generation_id) || !isValidJobId(accepted?.job_id)) {
    throw new CoverageAcceptanceError(
      'coverage acceptance is missing a valid generation or job identifier',
    )
  }
  return accepted
}

/** 最终报告 + Citation snapshot + 固定 snapshot（仅 render_report 完成后可读） */
export async function getCoverageReport(
  projectId: string,
  jobId: string,
): Promise<ResearchCoverageReportResponse> {
  const response = await apiClient.get<ResearchCoverageReportResponse>(
    researchPath(projectId, 'jobs', jobId, 'report'),
  )
  return response.data
}

/**
 * #307：deep_compare Job 最终报告读取（与 coverage 共用
 * GET /jobs/{id}/report 端点，后端按 job_type 分支返回）。
 * 仅 completed 且 result_ref 指向报告 Artifact 可读；
 * 未完成/Artifact 不可读 → 409 report_unavailable。
 */
export async function getCompareReport(
  projectId: string,
  jobId: string,
): Promise<ResearchCompareReportResponse> {
  const response = await apiClient.get<ResearchCompareReportResponse>(
    researchPath(projectId, 'jobs', jobId, 'report'),
  )
  return response.data
}

/**
 * outcome_unknown 显式人工重试（§12.2）：确认计费风险后创建新 run。
 * 必须使用新幂等键（复用旧键 → 409）。
 */
export async function retryCoverageJob(
  projectId: string,
  jobId: string,
  idempotencyKey: string,
): Promise<CoverageChatResponse & { retry_of_generation_id?: string }> {
  const response = await apiClient.post<
    CoverageChatResponse & { retry_of_generation_id?: string }
  >(
    researchPath(projectId, 'jobs', jobId, 'retry'),
    { confirm_billing_risk: true },
    {
      headers: {
        'X-Research-Contract': 'v1',
        'Idempotency-Key': idempotencyKey,
      },
    },
  )
  return response.data
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
  options: { sessionContract?: boolean } = {},
): Promise<ResearchSourceChatSessionDetail> {
  const response = await apiClient.get<ResearchSourceChatSessionDetail>(
    researchPath(projectId, 'sources', sourceId, 'chat', 'sessions', sessionId),
    options.sessionContract === true ? { headers: sessionContractHeaders } : undefined,
  )
  return response.data
}

// ── 全局 Chat 会话详情（Issue #302：刷新恢复读路径） ──

/**
 * 持久化消息行（GET .../chat/sessions/{session_id} 的 messages 元素；
 * 字段与后端 router 载荷对齐）。Citation 为 17 字段快照（§13.2），
 * 前端统一经展示最小结构归一后渲染。
 */
export interface ResearchGlobalChatMessage {
  message_id: string
  role: 'user' | 'assistant'
  content: string
  thinking?: string | null
  citations?: Array<Record<string, unknown>> | null
  usage?: ResearchTokenUsage | null
  resolved_mode?: string | null
  degradation_reasons?: string[] | null
  created_at?: string | null
}

/** 后台 Generation 卡（未交付/未完成才出卡；completed 且已 delivered 不出） */
export interface ResearchGlobalChatCard {
  generation_id: string
  job_id: string | null
  status: string
  failure_code: string | null
  created_at?: string | null
  /**
   * PR-5b（§7.3）：失败卡自身携带的容量报告（后端加性字段；缺失 =
   * unknown，不得回退到其它 Generation 的报告）。
   */
  context_report?: unknown
}

/** GET 全局会话详情响应（消息按阅读顺序返回；next_cursor 分页游标） */
export interface ResearchGlobalChatSessionDetail {
  session: {
    session_id: string
    title: string | null
    owner_user_id?: number | null
    created_at?: string | null
    updated_at?: string | null
    /** PR-5b（§4.6）：列表/详情同语义的会话可见性（第三批加性字段）。 */
    record_visibility?: string | null
  }
  messages: ResearchGlobalChatMessage[]
  cards: ResearchGlobalChatCard[]
  next_cursor: string | null
}

/**
 * 拉取全局 Chat 会话详情（消息 + 在途/失败后台卡）。owner-only
 * （后端 404 不泄露其他 Owner 会话存在性）。
 */
export async function getResearchChatSession(
  projectId: string,
  sessionId: string,
  params: { cursor?: string; sessionContract?: boolean } = {},
): Promise<ResearchGlobalChatSessionDetail> {
  const { cursor, sessionContract } = params
  const response = await apiClient.get<ResearchGlobalChatSessionDetail>(
    researchPath(projectId, 'chat', 'sessions', sessionId),
    {
      ...(cursor === undefined ? {} : { params: { cursor } }),
      // PR-5b（§6.7/§9.5）：只有新会话协议路径显式请求 session DTO 扩展；
      // legacy 调用不携带该头，返回形状/行为保持不变（Lead 裁决 D2）。
      ...(sessionContract === true ? { headers: sessionContractHeaders } : {}),
    },
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

/** SSE 流的公共回调（legacy 与新会话协议共用）。 */
interface ResearchChatStreamCallbacks {
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
  /**
   * PR5（D-24/§5.3 第 2 行）：状态码通过但 `Content-Type` 不是
   * `text/event-stream` —— 协议违反，**在消费流之前** fail-closed。
   * 不进入有界重连（重试只会拿到同样的非流响应）。
   */
  onProtocolError?: (reason: string) => void
  /**
   * PR5（D-24/§5.3 第 1、2 行）：传输超时。`phase` 区分两个计时制度——
   * `'response'` = 等待响应头（§5.3 第 1 行的"等待响应"，预算 API_TIMEOUT_MS）；
   * `'idle'` = 已进入事件流后的空闲计时（收到字节/heartbeat 重置）。
   * **这是唯一可进入有界重试的 abort 原因**。
   */
  onIdleTimeout?: (phase: 'response' | 'idle') => void
}

/**
 * legacy SSE 变体（#602 第三批 PR-5a D1 裁决）：
 * `protocol` 可省略，保持旧调用方/旧测试的既有签名与原行为（v1 或 c05-v1）；
 * `sessionRef`/editor 字段在类型级禁止出现（禁止静默携带会话身份走旧协议）。
 */
export interface ResearchChatStreamLegacyOptions extends ResearchChatStreamCallbacks {
  /** 显式 legacy 标记；省略视为 legacy（仅用于向后兼容） */
  protocol?: 'legacy'
  sessionRef?: never
  kind?: never
  editorRevision?: never
  draftToken?: never
  editorIntentHash?: never
  projectId: string
  request: ResearchChatRequest
  /**
   * SSE 端点路径（默认 `/chat` 全局多篇语义不变；Issue #182 source chat
   * 传 `/sources/{source_id}/chat`）。仅路径参数化，鉴权/帧解析共用。
   */
  path?: string
  /** #238：v1 契约幂等键；调用方复用策略决定，缺省新键 */
  idempotencyKey?: string
  /** PR5（B3）：契约头显式分支——C-05 Chat 携带 c05-v1；缺省 v1 不变 */
  contract?: 'v1' | 'c05-v1'
  /** 断线重连的 Last-Event-ID（0 = 从头开始） */
  lastEventId?: number
}

/**
 * 新会话协议 SSE 变体（#602 第三批 PR-5a；DESIGN §6.2/§9.4）：
 * 必填 `sessionRef + editorRevision + draftToken + editorIntentHash + idempotencyKey`；
 * `kind=global` 携带 `X-Research-Contract: c05-v1`，`kind=source` 携带 `v1`；
 * 两分支都携带 `X-Research-Session-Contract: research-session-v1`。
 * 缺失字段由类型系统拒绝，**不存在静默降级到 legacy 的路径**。
 */
export interface ResearchChatSessionStreamOptions extends ResearchChatStreamCallbacks {
  protocol: 'research-session-v1'
  projectId: string
  kind: 'global' | 'source'
  sessionRef: ResearchSessionRef
  request: ResearchChatRequest
  editorRevision: number
  draftToken: string
  editorIntentHash: string
  /** 新协议固定 `focused`（DESIGN §6.2）；缺省即 focused */
  contextLevel?: 'focused'
  /** `s1_` 提交幂等键（重连/重放必须复用同一值） */
  idempotencyKey: string
  /** 断线重连的 Last-Event-ID（0 = 从头开始） */
  lastEventId?: number
}

/** 判别联合：legacy 变体与 `research-session-v1` 变体。 */
export type ResearchChatStreamOptions =
  | ResearchChatStreamLegacyOptions
  | ResearchChatSessionStreamOptions

/**
 * 调用方中止流的原因（D-24/§5.3 第 3 行）；缺省视为用户取消。
 * `terminal_reached`：SSE 已给出 done/error 终态——本地收尾不应再重试，
 * 但必须**释放**读取器与看门狗（评审 MEDIUM-6：仅把 disposer 置 null
 * 会让已完成轮继续持有计时器与 reader）。
 */
export type ResearchStreamAbortReason = 'user_cancel' | 'identity' | 'page_change' | 'terminal_reached'

/**
 * 打开 Research Chat SSE 流；返回中止函数（仅关闭本地读取，
 * 浏览器断开 ≠ 取消——服务端继续执行，契约 §9.6）。
 *
 * PR5（D-24/§5.3）：
 * - 校验状态与 `Content-Type` **之后**才切换为流空闲计时；收到字节重置空闲
 *   （heartbeat 同样是字节，但它**不是**模型进度）；
 * - abort 原因区分（timeout／用户取消／身份／页面变化／正常结束），仅
 *   `timeout` 可进入调用方的有界重试；
 * - 每次尝试**只结算一次**：所有终止路径（HTTP 错误/协议错误/空闲超时/
 *   网络错误/EOF）共用同一个 settlement 守卫，避免一次尝试上报两次；
 * - `Last-Event-ID`、事件去重、终态一次保持；不新增 SSE 事件类型。
 */
export function openResearchChatStream(
  options: ResearchChatStreamOptions,
): (reason?: ResearchStreamAbortReason) => void {
  const isSessionProtocol = options.protocol === 'research-session-v1'
  if (!isSessionProtocol) {
    // 运行时防御（D1 裁决）：未声明新协议却携带会话字段 → 协议错误，
    // 绝不静默降级为 legacy v1。
    const raw = options as unknown as Record<string, unknown>
    if (
      raw.sessionRef != null
      || raw.draftToken != null
      || raw.editorIntentHash != null
      || raw.editorRevision != null
      || raw.kind != null
    ) {
      options.onProtocolError?.('session_fields_require_research_session_v1')
      return () => {}
    }
  }
  const legacyOptions = isSessionProtocol ? null : (options as ResearchChatStreamLegacyOptions)
  const sessionOptions = isSessionProtocol ? (options as ResearchChatSessionStreamOptions) : null
  if (sessionOptions !== null) {
    const refSourceMissing =
      sessionOptions.kind === 'source'
      && (sessionOptions.sessionRef.sourceId ?? '').length === 0
    if (
      sessionOptions.sessionRef.kind !== sessionOptions.kind
      || refSourceMissing
      || sessionOptions.sessionRef.projectId !== sessionOptions.projectId
    ) {
      options.onProtocolError?.('invalid_session_ref')
      return () => {}
    }
  }
  let streamPath = '/chat'
  let idempotencyKey = newIdempotencyKey()
  // legacy 请求体沿用调用方原样 wire；新协议补齐 §6.2 必填字段（session_id/
  // editor_revision/draft_token/editor_intent_hash/context_level）。
  let requestBody: unknown = null
  let contractHeader: 'v1' | 'c05-v1' = 'v1'
  if (legacyOptions !== null) {
    streamPath = legacyOptions.path ?? '/chat'
    idempotencyKey = legacyOptions.idempotencyKey ?? newIdempotencyKey()
    requestBody = legacyOptions.request
    contractHeader = legacyOptions.contract ?? 'v1'
  } else {
    const session = options as ResearchChatSessionStreamOptions
    streamPath = session.kind === 'source'
      ? `/sources/${session.sessionRef.sourceId ?? ''}/chat`
      : '/chat'
    idempotencyKey = session.idempotencyKey
    requestBody = {
      ...session.request,
      session_id: session.sessionRef.sessionId,
      editor_revision: session.editorRevision,
      draft_token: session.draftToken,
      editor_intent_hash: session.editorIntentHash,
      context_level: session.contextLevel ?? 'focused',
    }
    contractHeader = session.kind === 'global' ? 'c05-v1' : 'v1'
  }
  const controller = new AbortController()
  const url = `${requireResearchGateway()}${buildResearchUrl(options.projectId, streamPath)}`
  const token = researchBearerToken()
  const settlement = createAttemptSettlement()
  /** 调用方中止的原因（用于区分 timeout / 取消 / 身份 / 页面变化） */
  let abortReason: ResearchStreamEndReason | null = null
  /**
   * 传输看门狗（两相位共用一个计时器）：
   * - `'response'`：fetch 发出后即武装（§5.3 第 1 行的"等待响应"）；
   * - `'idle'`：响应头 + Content-Type 校验通过后武装，每收到一批字节重置
   *   （§5.3 第 2 行）。
   * `STREAM_IDLE_TIMEOUT_MS <= 0` 时**明确禁用**（与 axios `timeout: 0` 一致）。
   */
  let watchdog: ReturnType<typeof setTimeout> | null = null
  let watchdogPhase: 'response' | 'idle' = 'response'
  /**
   * 审查轮 2 B2：非 2xx 已给出状态码、但响应体读取卡住时，必须**如实按 HTTP
   * 错误上报**——否则看门狗抢先结算成 `timeout`，调用方会把它当成可重试的
   * 传输超时（对 401/403/422 重试是徒劳的），真实状态码也丢了。
   */
  let httpStatusAwaitingBody: number | null = null

  const clearWatchdog = (): void => {
    if (watchdog !== null) {
      clearTimeout(watchdog)
      watchdog = null
    }
  }

  const armWatchdog = (phase: 'response' | 'idle'): void => {
    clearWatchdog()
    watchdogPhase = phase
    if (STREAM_IDLE_TIMEOUT_MS <= 0) return
    watchdog = setTimeout(() => {
      watchdog = null
      if (abortReason !== null) return // 调用方已中止：不重复上报
      abortReason = 'timeout'
      controller.abort()
      if (!settlement.settle()) return
      if (httpStatusAwaitingBody !== null) {
        // 已知状态码但体读不完。审查轮 3 L1：**带重试语义的状态**（409/429/5xx）
        // 不得在这里被升级成终态错误——那会让 409 的同键自愈（completed-replay）
        // 与 5xx/429 的有界重试变得不可达。只有"确定无重试语义"的状态才按
        // HTTP 错误如实上报（保住状态码，不做无意义重试）。
        if (hasRetrySemanticsStatus(httpStatusAwaitingBody)) {
          options.onIdleTimeout?.(phase)
          return
        }
        options.onHttpError?.(httpStatusAwaitingBody, null)
        return
      }
      options.onIdleTimeout?.(phase)
    }, STREAM_IDLE_TIMEOUT_MS)
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
    // #238：契约头显式分支（PR5：C-05 → c05-v1；缺省 v1 不变）；
    // PR-5a：新会话协议按 kind 固定 c05-v1/v1，不读取 legacy contract。
    'X-Research-Contract': contractHeader,
    'Idempotency-Key': idempotencyKey,
  }
  if (sessionOptions !== null) {
    // 02 §2：所有新协议请求必带会话契约头。
    headers[SESSION_CONTRACT_HEADER] = SESSION_CONTRACT_VERSION
  }
  if (token) {
    headers.Authorization = `Bearer ${token}`
  }
  if (options.lastEventId && options.lastEventId > 0) {
    // §5.3 第 4 行：Last-Event-ID 语义保持（重连从服务端缓冲游标续读）
    headers['Last-Event-ID'] = String(options.lastEventId)
  }

  // §5.3 第 1 行：等待响应头也必须在预算内（此前只有流内空闲计时，
  // 代理吞掉响应头会让请求永久悬挂）
  armWatchdog('response')

  fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(requestBody),
    signal: controller.signal,
    cache: 'no-store',
  })
    .then(async (response) => {
      if (!response.ok) {
        // 先记录状态码：体读取期间若看门狗到期，按该状态码上报（B2）
        httpStatusAwaitingBody = response.status
        let body: unknown = null
        try {
          body = await response.json()
        } catch {
          // 非 JSON 错误体：保留 null
        }
        clearWatchdog()
        httpStatusAwaitingBody = null
        if (settlement.settle()) options.onHttpError?.(response.status, body)
        return
      }
      // D-24（§5.3 第 2 行）：状态通过后**先**校验 Content-Type，
      // 不是 SSE 就在消费流之前 fail-closed（不武装空闲计时、不读 body）
      const contentType = response.headers?.get?.('content-type') ?? null
      if (!isSseContentType(contentType)) {
        clearWatchdog()
        if (settlement.settle()) options.onProtocolError?.(`unexpected_content_type:${contentType ?? 'none'}`)
        return
      }
      if (!response.body) {
        clearWatchdog()
        if (settlement.settle()) options.onNetworkError?.(new Error('no response body'))
        return
      }
      // Issue #182：响应头只读一次透传（X-Chat-Session-Id 回显），不作行为依赖
      options.onResponseMeta?.(response.headers)
      // 校验通过 → 切换为流空闲计时（每收到一批字节即重置）
      armWatchdog('idle')
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          // 收到字节（含 heartbeat 注释帧）→ 重置传输空闲；**不**当作模型进度
          armWatchdog('idle')
          buffer += decoder.decode(value, { stream: true })
          const frames = buffer.split('\n\n')
          buffer = frames.pop() ?? ''
          for (const frame of frames) {
            // §5.3 第 2 行：heartbeat/注释帧只是传输活跃信号，**不是**模型进度
            // ——不解析、不产生事件（它已在上面重置过空闲计时）
            if (isHeartbeatComment(frame)) continue
            const event = parseSseFrame(frame)
            if (event) {
              options.onEvent(event)
            }
          }
        }
        // 正常读尽（EOF）：终态与否由调用方依 sse 状态判定；
        // 调用方 abort 的收尾不算 EOF（不触发 onEnd）
        clearWatchdog()
        if (abortReason === null && !controller.signal.aborted && settlement.settle()) {
          abortReason = 'normal_end'
          options.onEnd?.()
        }
      } catch (error) {
        clearWatchdog()
        if ((error as Error).name !== 'AbortError' && settlement.settle()) {
          options.onNetworkError?.(error as Error)
        }
      }
    })
    .catch((error) => {
      clearWatchdog()
      if ((error as Error).name !== 'AbortError' && settlement.settle()) {
        options.onNetworkError?.(error as Error)
      }
    })

  return (reason: ResearchStreamAbortReason = 'user_cancel') => {
    // 调用方主动中止：区分原因（仅 timeout 可重试——此处必非 timeout），
    // 并让终止路径保持"只结算一次"。timeout 由空闲看门狗自行 abort。
    if (abortReason === null) abortReason = reason
    clearWatchdog()
    controller.abort()
  }
}

// ── 会话列表 / 创建（#602 第三批 PR-2；契约 research-session-v1） ──

/**
 * `GET /chat/sessions` 查询参数（02 §3 `list_query`）：
 * 只允许 cursor/limit/kind，**没有 source_id**（已知契约缺口，见 DESIGN §4.1）。
 */
export interface ListChatSessionsParams {
  kind: 'global' | 'source' | 'all'
  cursor?: string | null
  limit?: number
}

/** 新协议请求头（所有会话列表/创建请求必带，02 §2）。 */
const sessionContractHeaders = {
  [SESSION_CONTRACT_HEADER]: SESSION_CONTRACT_VERSION,
} as const

/**
 * `GET /v1/research/projects/{project_id}/chat/sessions`（list_query → list_response）。
 *
 * 返回**原始 JSON**：`list_response` 的严格校验由调用方经
 * `session-contract.parseListResponse` 完成（本函数只负责传输与协议头）。
 */
export async function listChatSessions(
  projectId: string,
  params: ListChatSessionsParams,
): Promise<unknown> {
  const query: Record<string, string | number> = { kind: params.kind }
  if (params.cursor !== undefined && params.cursor !== null) query.cursor = params.cursor
  if (params.limit !== undefined) query.limit = params.limit
  const response = await apiClient.get<unknown>(
    researchPath(projectId, 'chat', 'sessions'),
    { params: query, headers: sessionContractHeaders },
  )
  return response.data
}

/** `create_request`（02 §3）：body 只有 `{session_id}`。 */
export interface CreateChatSessionInput {
  kind: 'global' | 'source'
  /** kind=source 时必填（绑定当前来源，不可变）。 */
  sourceId?: string | null
  /** 客户端生成，`^[A-Za-z0-9_-]{1,128}$`；网络重试必须复用同一值（§4.3）。 */
  sessionId: string
}

/**
 * `POST /v1/research/projects/{project_id}/chat/sessions`
 * 或 `POST .../sources/{source_id}/chat/sessions`（create_request → create_response）。
 *
 * 返回**原始 JSON**：`create_response` 6 键严格校验由调用方完成
 * （PR-2 决定 R5：解析放 `use-research-sessions.ts`，本函数只做传输）。
 */
export async function createChatSession(
  projectId: string,
  input: CreateChatSessionInput,
): Promise<unknown> {
  const path =
    input.kind === 'source'
      ? researchPath(projectId, 'sources', input.sourceId ?? '', 'chat', 'sessions')
      : researchPath(projectId, 'chat', 'sessions')
  const response = await apiClient.post<unknown>(
    path,
    { session_id: input.sessionId },
    { headers: sessionContractHeaders },
  )
  return response.data
}

// ── 编辑器状态（#602 第三批 PR-3；DESIGN §5，02 §4） ──

/** `GET/PUT .../editor-state` 的目标会话（全局或来源绑定）。 */
export interface EditorStateTarget {
  kind: 'global' | 'source'
  sessionId: string
  /** kind=source 时必填（绑定来源，不可变）。 */
  sourceId?: string | null
}

const editorStatePath = (projectId: string, target: EditorStateTarget): string =>
  target.kind === 'source'
    ? researchPath(projectId, 'sources', target.sourceId ?? '', 'chat', 'sessions', target.sessionId, 'editor-state')
    : researchPath(projectId, 'chat', 'sessions', target.sessionId, 'editor-state')

/**
 * `GET .../editor-state`（editor_response）。
 *
 * 返回**原始 JSON**：严格校验由调用方经 `session-contract.parseEditorResponse`
 * 完成（PR-3 决定 R4：本函数只负责传输与协议头）。
 */
export async function getEditorState(
  projectId: string,
  target: EditorStateTarget,
): Promise<unknown> {
  const response = await apiClient.get<unknown>(editorStatePath(projectId, target), {
    headers: sessionContractHeaders,
  })
  return response.data
}

/**
 * `PUT .../editor-state`（editor_save_request → save_response）。
 *
 * 返回**原始 JSON**：严格校验由调用方经 `session-contract.parseSaveResponse`
 * 完成；`mutation_id` 由调用方生成并在重试/跨代际接管时原样复用。
 */
export async function putEditorState(
  projectId: string,
  target: EditorStateTarget,
  body: EditorSaveRequestWire,
): Promise<unknown> {
  const response = await apiClient.put<unknown>(editorStatePath(projectId, target), body, {
    headers: sessionContractHeaders,
  })
  return response.data
}

// ── 提交查回（#602 第三批 PR-5a；DESIGN §3.5/§6.7，02 §3） ──

/** 提交查回目标；`kind=source` 时 `sourceId` 必填（绑定当前来源）。 */
export interface ChatSubmissionTarget {
  kind: 'global' | 'source'
  sourceId?: string | null
}

const chatSubmissionPath = (
  projectId: string,
  target: ChatSubmissionTarget,
  sessionId: string,
  draftToken: string,
): string => {
  const encodedSession = encodeURIComponent(sessionId)
  const encodedToken = encodeURIComponent(draftToken)
  return target.kind === 'source'
    ? researchPath(
        projectId,
        'sources',
        target.sourceId ?? '',
        'chat',
        'sessions',
        encodedSession,
        'submissions',
        encodedToken,
      )
    : researchPath(
        projectId,
        'chat',
        'sessions',
        encodedSession,
        'submissions',
        encodedToken,
      )
}

/**
 * `GET .../chat/sessions/{session_id}/submissions/{draft_token}`（submission_response）。
 *
 * 返回**原始 JSON**：严格校验由调用方经
 * `session-contract.parseSubmissionResponse` 完成（PR-5a 决定与 PR-2/PR-3 一致：
 * 本函数只负责传输与协议头）。查回可重复执行，服务端不得产生新 Generation。
 */
export async function getChatSubmission(
  projectId: string,
  target: ChatSubmissionTarget,
  sessionId: string,
  draftToken: string,
): Promise<unknown> {
  const response = await apiClient.get<unknown>(
    chatSubmissionPath(projectId, target, sessionId, draftToken),
    { headers: sessionContractHeaders },
  )
  return response.data
}
