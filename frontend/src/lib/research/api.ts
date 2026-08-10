/**
 * Research Gateway API（UI-02，契约 v0 §6/§7/§9；REQ-API-01、REQ-DIS-01/02/03）。
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
 * - Transformation 运行只走 Gateway run 端点（REQ-DIS-02）。
 */

import { apiClient } from '@/lib/api/client'
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
