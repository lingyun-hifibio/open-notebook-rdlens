/**
 * Research Gateway API 客户端（UI-03，设计 §9.3；REQ-DEP-02/REQ-API-02）。
 *
 * 嵌入式模式下所有请求只发往 `NEXT_PUBLIC_RD_GATEWAY_URL`（浏览器唯一可达
 * API 入口），Bearer 只取内存 Research Token（UI-01 token-store）。
 * 非嵌入式或 Gateway 未配置 → fail-closed 抛错。
 *
 * SSE 流（/chat）用 fetch + ReadableStream 消费，支持 `Last-Event-ID`
 * 重连（契约 §9.5）；409（缓冲不足且任务进行中）分类为
 * ResearchStreamHttpError 供调用方重试。
 */

import apiClient from '@/lib/api/client'
import { getAuthToken } from '@/lib/auth-token'
import { isEmbeddedMode, getEmbeddedGatewayUrl } from '@/lib/embedded/config'
import { getResearchToken } from '@/lib/embedded/token-store'
import { parseSseFrame } from './sse'
import type {
  ResearchChatRequest,
  ResearchCompareCreateRequest,
  ResearchCompareCreateResponse,
  ResearchJob,
  ResearchNoteSummary,
  ResearchPage,
  ResearchSearchRequest,
  ResearchSearchResponse,
  ResearchSseEvent,
  ResearchSourceSummary,
} from './types'

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

export async function listSources(projectId: string): Promise<ResearchSourceSummary[]> {
  const { data } = await apiClient.get<ResearchPage<ResearchSourceSummary>>(
    buildResearchUrl(projectId, '/sources'),
  )
  return data.items ?? []
}

export async function listNotes(projectId: string): Promise<ResearchNoteSummary[]> {
  const { data } = await apiClient.get<ResearchPage<ResearchNoteSummary>>(
    buildResearchUrl(projectId, '/notes'),
  )
  return data.items ?? []
}

export async function search(
  projectId: string,
  request: ResearchSearchRequest,
): Promise<ResearchSearchResponse> {
  const { data } = await apiClient.post<ResearchSearchResponse>(
    buildResearchUrl(projectId, '/search'),
    request,
  )
  return data
}

export async function createCompare(
  projectId: string,
  request: ResearchCompareCreateRequest,
): Promise<ResearchCompareCreateResponse> {
  const { data } = await apiClient.post<ResearchCompareCreateResponse>(
    buildResearchUrl(projectId, '/compare/jobs'),
    request,
  )
  return data
}

export async function getJob(projectId: string, jobId: string): Promise<ResearchJob> {
  const { data } = await apiClient.get<ResearchJob>(
    buildResearchUrl(projectId, `/jobs/${encodeURIComponent(jobId)}`),
  )
  return data
}

export async function cancelJob(projectId: string, jobId: string): Promise<void> {
  await apiClient.post(buildResearchUrl(projectId, `/jobs/${encodeURIComponent(jobId)}/cancel`))
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
  /** 断线重连的 Last-Event-ID（0 = 从头开始） */
  lastEventId?: number
  /** 服务端事件（已按 event_id 校验） */
  onEvent: (event: ResearchSseEvent) => void
  /** 非 2xx（含 409 resume_after） */
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
  const url = `${requireResearchGateway()}${buildResearchUrl(options.projectId, '/chat')}`
  const token = researchBearerToken()

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
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
