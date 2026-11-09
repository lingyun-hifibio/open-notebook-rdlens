/**
 * Issue #1077 W2（fork 宽屏阅读器）数据层 hook 测试（合并计划 §2.3/§2.4/
 * §2.8/§2.10；DESIGN「reader-media 交付」）。
 *
 * 替身位置：**axios adapter 级**（沿 `api.v1.test.ts` / 主题概览 hook 先例）。
 * hook 走真实 `@/lib/research/api` + 真实 `ResearchMediaError`，因此同一文件
 * 同时覆盖：
 * - detail 读取：citation 入口成对 `document_id/document_version`；source
 *   入口零参数（既有行为）；query key 含成对版本；request=null 不发请求；
 * - 版本护栏：match / latest / 服务端 422 `source_ref_mismatch` → mismatch /
 *   客户端版本漂移 → mismatch（不回退最新内容）；
 * - 页图：单页按需、blob URL 创建与切换/卸载回收、§2.10 全部失败分类、
 *   手动重试（无自动循环）；
 * - 原文件：blob + `<a download>`（Content-Disposition 优先、本地回退名）、
 *   失败分类、绝不 `window.open`；token 只在 Authorization header。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createElement, type ReactNode } from 'react'
import type { InternalAxiosRequestConfig } from 'axios'
import { apiClient } from '@/lib/api/client'
import type { TargetReaderOpenRequest } from '@/components/research/target/target-reader-state'
import type { ResearchSourceDetail } from '@/lib/types/research'
import { useSourceMedia, type UseSourceMediaInput } from './use-source-media'

vi.mock('@/lib/embedded/config', () => ({
  isEmbeddedMode: vi.fn(() => true),
  getEmbeddedGatewayUrl: vi.fn(() => 'https://gateway.example.com'),
}))

vi.mock('@/lib/embedded/token-store', () => ({
  getResearchToken: vi.fn(() => 'memory-token'),
}))

const PROJECT = 'p1'
const SOURCE_ID = 'src_1'
const DETAIL_URL = `/v1/research/projects/${PROJECT}/sources/${SOURCE_ID}`
const FILE_URL = `${DETAIL_URL}/file`
const pageUrl = (pageIdx: number): string => `${DETAIL_URL}/pages/${pageIdx}/image`

const DOC_REF = { documentId: 'doc_1', documentVersion: 'v3' }

interface Captured {
  url: string
  method: string
  params?: Record<string, unknown>
  responseType?: unknown
  headers?: Record<string, string>
}

const calls: Captured[] = []

interface Outcome {
  status: number
  data: unknown
  headers?: Record<string, string>
}

/** `status === 0` = 网络错误（无响应）；`status >= 400` = HTTP 错误。 */
type Responder = (config: InternalAxiosRequestConfig) => Outcome | Promise<Outcome>

let responder: Responder = () => ({ status: 200, data: {} })

function installAdapter(): void {
  apiClient.defaults.adapter = async (config) => {
    calls.push({
      url: String(config.url),
      method: String(config.method ?? 'get').toUpperCase(),
      params: config.params as Record<string, unknown> | undefined,
      responseType: config.responseType,
      headers: (config.headers ?? {}) as Record<string, string>,
    })
    const outcome = await responder(config)
    if (outcome.status === 0) {
      throw new Error('Network Error')
    }
    if (outcome.status >= 400) {
      const error = Object.assign(new Error(`Request failed with status code ${outcome.status}`), {
        isAxiosError: true,
        // 真实 axios 错误形状：顶层 code 是传输层码（不是服务端 envelope 码）。
        code: 'ERR_BAD_REQUEST',
        response: {
          status: outcome.status,
          statusText: '',
          data: outcome.data,
          headers: outcome.headers ?? {},
          config,
        },
      })
      throw error
    }
    return {
      data: outcome.data,
      status: outcome.status,
      statusText: 'OK',
      headers: outcome.headers ?? {},
      config,
    }
  }
}

function callsTo(url: string): Captured[] {
  return calls.filter((call) => call.url === url)
}

function pageCalls(): Captured[] {
  return calls.filter((call) => call.url.includes('/pages/'))
}

const wait = (ms = 40): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function makeDetail(overrides: Partial<ResearchSourceDetail> = {}): ResearchSourceDetail {
  return {
    source_id: SOURCE_ID,
    document_id: 'doc_1',
    document_version: 'v3',
    status: 'ready',
    content_hash: null,
    synced_at: null,
    last_error: null,
    title: 'Paper A',
    markdown_chunks: [
      { chunk_id: 'c0', page_idx: 0, markdown: 'page zero' },
      { chunk_id: 'c3', page_idx: 3, markdown: 'page three' },
    ],
    source_type: 'pdf',
    file_available: true,
    ...overrides,
  }
}

function citationRequest(
  overrides: Partial<TargetReaderOpenRequest> = {},
): TargetReaderOpenRequest {
  return {
    origin: 'citation',
    sourceId: SOURCE_ID,
    citation: {
      citation_id: 'cit_1',
      claim: 'claim text',
      doc_id: 'doc_1',
      page_idx: 3,
      doc_version: 'v3',
      chunk_id: 'c3',
    },
    messageId: 'msg_1',
    documentRef: { ...DOC_REF },
    initialPageIdx: 3,
    ...overrides,
  }
}

function sourceRequest(
  overrides: Partial<TargetReaderOpenRequest> = {},
): TargetReaderOpenRequest {
  return {
    origin: 'source',
    sourceId: SOURCE_ID,
    citation: null,
    messageId: null,
    documentRef: null,
    initialPageIdx: null,
    ...overrides,
  }
}

function inputOf(
  request: TargetReaderOpenRequest | null,
  overrides: Partial<UseSourceMediaInput> = {},
): UseSourceMediaInput {
  return {
    projectId: PROJECT,
    request,
    pageIdx: null,
    wantPageImage: false,
    ...overrides,
  }
}

let queryClient: QueryClient
let objectUrlSeq = 0
const originalCreateObjectURL = URL.createObjectURL
const originalRevokeObjectURL = URL.revokeObjectURL
let createObjectURL: ReturnType<typeof vi.fn>
let revokeObjectURL: ReturnType<typeof vi.fn>
let anchorClick: ReturnType<typeof vi.spyOn>
let windowOpen: ReturnType<typeof vi.spyOn>

function wrapper({ children }: { children: ReactNode }) {
  return createElement(QueryClientProvider, { client: queryClient }, children)
}

beforeEach(() => {
  calls.length = 0
  objectUrlSeq = 0
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  responder = () => ({ status: 200, data: makeDetail() })
  installAdapter()

  createObjectURL = vi.fn(() => `blob:mock-${++objectUrlSeq}`)
  revokeObjectURL = vi.fn()
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    writable: true,
    value: createObjectURL,
  })
  Object.defineProperty(URL, 'revokeObjectURL', {
    configurable: true,
    writable: true,
    value: revokeObjectURL,
  })
  anchorClick = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
  windowOpen = vi.spyOn(window, 'open').mockImplementation(() => null)
})

afterEach(() => {
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    writable: true,
    value: originalCreateObjectURL,
  })
  Object.defineProperty(URL, 'revokeObjectURL', {
    configurable: true,
    writable: true,
    value: originalRevokeObjectURL,
  })
  anchorClick.mockRestore()
  windowOpen.mockRestore()
  vi.restoreAllMocks()
})

describe('useSourceMedia — detail 读取与版本护栏', () => {
  it('未打开（request=null）→ idle、不发任何请求、retry/open 均为安全 no-op', async () => {
    const { result } = renderHook(() => useSourceMedia(inputOf(null)), { wrapper })
    await waitFor(() => expect(result.current.detailStatus).toBe('idle'))
    expect(result.current.detail).toBeNull()
    expect(result.current.detailFailure).toBeNull()
    expect(result.current.pages).toEqual([])
    expect(result.current.pageImage).toEqual({ status: 'idle', url: null, failure: null })
    expect(result.current.file).toEqual({ status: 'idle', failure: null })
    act(() => result.current.retryDetail())
    act(() => result.current.retryPageImage())
    act(() => result.current.openFile())
    await wait()
    expect(calls).toHaveLength(0)
  })

  it('source 入口 → 按最新版读取（无 query 参数）、versionState=latest、页集合来自 chunks', async () => {
    const { result } = renderHook(() => useSourceMedia(inputOf(sourceRequest())), { wrapper })
    await waitFor(() => expect(result.current.detailStatus).toBe('ready'))
    expect(result.current.versionState).toEqual({ kind: 'latest' })
    expect(result.current.detail?.title).toBe('Paper A')
    expect(result.current.sourceType).toBe('pdf')
    expect(result.current.pages).toEqual([0, 3])
    const detailCalls = callsTo(DETAIL_URL)
    expect(detailCalls).toHaveLength(1)
    expect(detailCalls[0].params).toBeUndefined()
    expect(detailCalls[0].headers?.Authorization).toBe('Bearer memory-token')
    expect(detailCalls[0].url).not.toMatch(/token|bearer/i)
  })

  it('citation 入口 → detail 成对版本参数 + query key 含成对版本；版本一致 = match 且并入 citation 页', async () => {
    responder = () => ({
      status: 200,
      data: makeDetail({
        markdown_chunks: [{ chunk_id: 'c0', page_idx: 0, markdown: 'only page zero' }],
      }),
    })
    const { result } = renderHook(() => useSourceMedia(inputOf(citationRequest())), { wrapper })
    await waitFor(() => expect(result.current.detailStatus).toBe('ready'))
    expect(callsTo(DETAIL_URL)[0].params).toEqual({
      document_id: 'doc_1',
      document_version: 'v3',
    })
    expect(result.current.versionState).toEqual({ kind: 'match' })
    // chunks 页 [0] ∪ citation 页 [3]（仅 match 时并入）
    expect(result.current.pages).toEqual([0, 3])
    const keys = queryClient.getQueryCache().findAll().map((entry) => entry.queryKey)
    expect(keys).toContainEqual(['research', PROJECT, 'sources', SOURCE_ID, 'doc_1', 'v3'])
  })

  it('citation 缺成对版本 → 读取最新版（无参数）、unverifiable、citation 页不并入页集合', async () => {
    responder = () => ({
      status: 200,
      data: makeDetail({
        markdown_chunks: [{ chunk_id: 'c0', page_idx: 0, markdown: 'only page zero' }],
      }),
    })
    const { result } = renderHook(
      () => useSourceMedia(inputOf(citationRequest({ documentRef: null }))),
      { wrapper },
    )
    await waitFor(() => expect(result.current.detailStatus).toBe('ready'))
    expect(result.current.versionState).toEqual({ kind: 'unverifiable' })
    expect(result.current.detail).not.toBeNull()
    expect(callsTo(DETAIL_URL)[0].params).toBeUndefined()
    // B4-L3：版本不可核对时 citation 页（3）不得并入/定位
    expect(result.current.pages).toEqual([0])
  })

  it('旧 host（source_type 缺失）→ sourceType=null、detail 照常返回（能力 fail-closed 交给组件）', async () => {
    responder = () => ({
      status: 200,
      data: makeDetail({ source_type: undefined }),
    })
    const { result } = renderHook(() => useSourceMedia(inputOf(sourceRequest())), { wrapper })
    await waitFor(() => expect(result.current.detailStatus).toBe('ready'))
    expect(result.current.sourceType).toBeNull()
    expect(result.current.detail?.document_id).toBe('doc_1')
    // 未请求页图（wantPageImage=false）：不伪造页图
    expect(pageCalls()).toHaveLength(0)
    expect(result.current.pageImage.status).toBe('idle')
  })

  it('服务端 422 source_ref_mismatch → mismatch + source_unavailable + error，且不自动重试', async () => {
    responder = () => ({
      status: 422,
      data: { detail: { code: 'source_ref_mismatch', message: 'version mismatch' } },
    })
    const { result } = renderHook(() => useSourceMedia(inputOf(citationRequest())), { wrapper })
    await waitFor(() => expect(result.current.detailStatus).toBe('error'))
    expect(result.current.detailFailure).toBe('source_unavailable')
    expect(result.current.versionState).toEqual({ kind: 'mismatch' })
    expect(result.current.detail).toBeNull()
    expect(result.current.pages).toEqual([])
    expect(callsTo(DETAIL_URL)).toHaveLength(1)
    await wait()
    expect(callsTo(DETAIL_URL)).toHaveLength(1)
  })

  it('客户端版本漂移（服务端忽略参数返回异版本）→ mismatch、detail 置空、不回退最新', async () => {
    responder = () => ({ status: 200, data: makeDetail({ document_version: 'v4' }) })
    const { result } = renderHook(() => useSourceMedia(inputOf(citationRequest())), { wrapper })
    await waitFor(() => expect(result.current.detailStatus).toBe('error'))
    expect(result.current.versionState).toEqual({ kind: 'mismatch' })
    expect(result.current.detailFailure).toBe('source_unavailable')
    expect(result.current.detail).toBeNull()
    expect(result.current.pages).toEqual([])
    // 不回退「最新版」重读：只发过一次原请求
    expect(callsTo(DETAIL_URL)).toHaveLength(1)
  })

  it.each([
    ['410 envelope 撤权', 410, { detail: { code: 'source_access_restricted', message: 'revoked' } }, 'forbidden'],
    ['404 Source not found', 404, { detail: 'Source not found' }, 'source_unavailable'],
    ['404 位置/文件不可用', 404, { detail: 'Source file is not available' }, 'unavailable'],
    ['500', 500, { detail: 'internal error' }, 'retryable'],
    ['503 envelope', 503, { detail: { code: 'session_store_unavailable', message: 'down' } }, 'retryable'],
  ] as const)(
    'detail %s → §2.10 分类 %s',
    async (_label, status, data, expected) => {
      responder = () => ({ status, data })
      const { result } = renderHook(() => useSourceMedia(inputOf(sourceRequest())), { wrapper })
      await waitFor(() => expect(result.current.detailStatus).toBe('error'))
      expect(result.current.detailFailure).toBe(expected)
      expect(result.current.detail).toBeNull()
      expect(callsTo(DETAIL_URL)).toHaveLength(1)
    },
  )

  it('页图 410 撤权子请求 → restricted=true（NORMATIVE 14：清空正文/摘录）', async () => {
    responder = (config) => {
      const url = String(config.url)
      if (url.endsWith('/pages/0/image')) {
        return { status: 410, data: { detail: { code: 'source_access_restricted', message: 'revoked' } } }
      }
      if (url.endsWith('/image')) return { status: 200, data: new Blob(['img'], { type: 'image/jpeg' }) }
      return { status: 200, data: makeDetail() }
    }
    const { result } = renderHook(
      () =>
        useSourceMedia(
          inputOf(citationRequest({ initialPageIdx: 0 }), {
            pageIdx: 0,
            wantPageImage: true,
          }),
        ),
      { wrapper },
    )
    await waitFor(() => expect(result.current.detailStatus).toBe('ready'))
    await waitFor(() => expect(result.current.pageImage.failure).toBe('forbidden'))
    expect(result.current.restricted).toBe(true)
    // 详情本身成功也不得展示「未撤权」的正文（读者层负责清空）。
    expect(result.current.detail).not.toBeNull()
  })

  it('detail 401 会话失效 → session_expired（§2.9：结束重试，不混入撤权/可重试）', async () => {
    responder = () => ({ status: 401, data: { detail: 'Not authenticated' } })
    const { result } = renderHook(() => useSourceMedia(inputOf(sourceRequest())), { wrapper })
    await waitFor(() => expect(result.current.detailStatus).toBe('error'))
    expect(result.current.detailFailure).toBe('session_expired')
    expect(result.current.detail).toBeNull()
    expect(result.current.pages).toEqual([])
    // 无自动重试：只发过一次原请求。
    await wait()
    expect(callsTo(DETAIL_URL)).toHaveLength(1)
  })

  it('detail 网络错误 → retryable；retryDetail 手动重试才重发（成功后 ready）', async () => {
    let fail = true
    responder = () =>
      fail ? { status: 0, data: null } : { status: 200, data: makeDetail() }
    const { result } = renderHook(() => useSourceMedia(inputOf(sourceRequest())), { wrapper })
    await waitFor(() => expect(result.current.detailStatus).toBe('error'))
    expect(result.current.detailFailure).toBe('retryable')
    await wait()
    expect(callsTo(DETAIL_URL)).toHaveLength(1)

    fail = false
    act(() => result.current.retryDetail())
    await waitFor(() => expect(result.current.detailStatus).toBe('ready'))
    expect(result.current.detail?.title).toBe('Paper A')
    expect(callsTo(DETAIL_URL)).toHaveLength(2)
  })
})

describe('useSourceMedia — 页图状态机', () => {
  it('wantPageImage + 当前页 + detail 成对版本 → 自动单页请求（blob URL，不预取）', async () => {
    responder = (config) => {
      if (config.url === DETAIL_URL) return { status: 200, data: makeDetail() }
      if (config.url === pageUrl(3)) {
        return { status: 200, data: new Blob(['jpeg-bytes'], { type: 'image/jpeg' }) }
      }
      return { status: 500, data: { detail: 'unexpected page request' } }
    }
    const { result } = renderHook(
      () =>
        useSourceMedia(
          inputOf(citationRequest(), { pageIdx: 3, wantPageImage: true }),
        ),
      { wrapper },
    )
    await waitFor(() => expect(result.current.detailStatus).toBe('ready'))
    await waitFor(() => expect(result.current.pageImage.status).toBe('ready'))
    expect(result.current.pageImage.url).toBe('blob:mock-1')
    expect(result.current.pageImage.failure).toBeNull()
    expect(createObjectURL).toHaveBeenCalledTimes(1)

    const page = callsTo(pageUrl(3))
    expect(page).toHaveLength(1)
    expect(page[0].params).toEqual({ document_id: 'doc_1', document_version: 'v3' })
    expect(page[0].responseType).toBe('blob')
    expect(pageCalls()).toHaveLength(1)
    // Bearer 只在 header；token 不进 URL/查询串（NORMATIVE 16）
    expect(page[0].headers?.Authorization).toBe('Bearer memory-token')
    expect(page[0].url).not.toMatch(/token|bearer|authorization/i)
    expect(JSON.stringify(page[0].params)).not.toMatch(/token|bearer/i)
  })

  it('wantPageImage=false / pageIdx 非法 / detail 未 ready → pageImage 保持 idle 且不发请求', async () => {
    responder = (config) => {
      if (config.url === DETAIL_URL) return { status: 200, data: makeDetail() }
      return { status: 200, data: new Blob(['jpeg'], { type: 'image/jpeg' }) }
    }
    const initialProps = inputOf(citationRequest(), { pageIdx: 3, wantPageImage: false })
    const { result, rerender } = renderHook(
      (props: UseSourceMediaInput) => useSourceMedia(props),
      { wrapper, initialProps },
    )
    await waitFor(() => expect(result.current.detailStatus).toBe('ready'))
    await wait()
    expect(pageCalls()).toHaveLength(0)
    expect(result.current.pageImage.status).toBe('idle')

    rerender({ ...initialProps, pageIdx: null, wantPageImage: true })
    await wait()
    expect(pageCalls()).toHaveLength(0)
    expect(result.current.pageImage.status).toBe('idle')

    rerender({ ...initialProps, pageIdx: -1, wantPageImage: true })
    await wait()
    expect(pageCalls()).toHaveLength(0)
    expect(result.current.pageImage.status).toBe('idle')

    act(() => result.current.retryPageImage())
    await wait()
    expect(pageCalls()).toHaveLength(0)
  })

  it('detail 读取失败时页图保持 idle（不伪造页图）', async () => {
    responder = (config) => {
      if (config.url === DETAIL_URL) return { status: 500, data: { detail: 'boom' } }
      return { status: 200, data: new Blob(['jpeg'], { type: 'image/jpeg' }) }
    }
    const { result } = renderHook(
      () =>
        useSourceMedia(inputOf(sourceRequest(), { pageIdx: 0, wantPageImage: true })),
      { wrapper },
    )
    await waitFor(() => expect(result.current.detailStatus).toBe('error'))
    await wait()
    expect(pageCalls()).toHaveLength(0)
    expect(result.current.pageImage.status).toBe('idle')
  })

  it('切页 → 回收旧 blob URL 并请求新页（只请求当前页）', async () => {
    responder = (config) => {
      if (config.url === DETAIL_URL) return { status: 200, data: makeDetail() }
      return { status: 200, data: new Blob(['jpeg'], { type: 'image/jpeg' }) }
    }
    const initialProps = inputOf(citationRequest(), { pageIdx: 0, wantPageImage: true })
    const { result, rerender } = renderHook(
      (props: UseSourceMediaInput) => useSourceMedia(props),
      { wrapper, initialProps },
    )
    await waitFor(() => expect(result.current.pageImage.status).toBe('ready'))
    expect(result.current.pageImage.url).toBe('blob:mock-1')

    rerender({ ...initialProps, pageIdx: 3 })
    await waitFor(() => expect(result.current.pageImage.url).toBe('blob:mock-2'))
    expect(result.current.pageImage.status).toBe('ready')
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:mock-1')
    expect(callsTo(pageUrl(0))).toHaveLength(1)
    expect(callsTo(pageUrl(3))).toHaveLength(1)
  })

  it('卸载 → 回收当前 blob URL；在途页图响应作废（不再创建 URL/写状态）', async () => {
    let resolvePage: ((outcome: Outcome) => void) | null = null
    responder = (config) => {
      if (config.url === DETAIL_URL) return { status: 200, data: makeDetail() }
      return new Promise<Outcome>((resolve) => {
        resolvePage = resolve
      })
    }
    const { result, unmount } = renderHook(
      () => useSourceMedia(inputOf(citationRequest(), { pageIdx: 3, wantPageImage: true })),
      { wrapper },
    )
    await waitFor(() => expect(result.current.detailStatus).toBe('ready'))
    await waitFor(() => expect(pageCalls()).toHaveLength(1))
    unmount()
    expect(resolvePage).not.toBeNull()
    ;(resolvePage as unknown as (outcome: Outcome) => void)({
      status: 200,
      data: new Blob(['jpeg'], { type: 'image/jpeg' }),
    })
    await wait()
    expect(createObjectURL).not.toHaveBeenCalled()
  })

  it('先成功再卸载 → 回收该 blob URL', async () => {
    responder = (config) => {
      if (config.url === DETAIL_URL) return { status: 200, data: makeDetail() }
      return { status: 200, data: new Blob(['jpeg'], { type: 'image/jpeg' }) }
    }
    const { result, unmount } = renderHook(
      () => useSourceMedia(inputOf(citationRequest(), { pageIdx: 3, wantPageImage: true })),
      { wrapper },
    )
    await waitFor(() => expect(result.current.pageImage.status).toBe('ready'))
    expect(result.current.pageImage.url).toBe('blob:mock-1')
    unmount()
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:mock-1')
  })

  it.each([
    ['410 envelope 撤权', 410, { detail: { code: 'source_access_restricted', message: 'revoked' } }, 'forbidden'],
    ['422 source_ref_mismatch', 422, { detail: { code: 'source_ref_mismatch', message: 'mismatch' } }, 'source_unavailable'],
    ['404 格式不支持', 404, { detail: 'Preview not supported for xlsx; open source file directly' }, 'unsupported'],
    ['404 Source not found', 404, { detail: 'Source not found' }, 'source_unavailable'],
    ['404 页不可用', 404, { detail: 'Source page is not available' }, 'unavailable'],
    ['500', 500, { detail: 'render failed' }, 'retryable'],
    ['503', 503, { detail: { code: 'session_store_unavailable', message: 'down' } }, 'retryable'],
    ['网络错误', 0, null, 'retryable'],
  ] as const)(
    '页图 %s → §2.10 分类 %s；失败后不自动循环',
    async (_label, status, data, expected) => {
      responder = (config) => {
        if (config.url === DETAIL_URL) return { status: 200, data: makeDetail() }
        return { status, data }
      }
      const { result } = renderHook(
        () => useSourceMedia(inputOf(citationRequest(), { pageIdx: 3, wantPageImage: true })),
        { wrapper },
      )
      await waitFor(() => expect(result.current.pageImage.status).toBe('error'))
      expect(result.current.pageImage.failure).toBe(expected)
      expect(result.current.pageImage.url).toBeNull()
      expect(pageCalls()).toHaveLength(1)
      await wait()
      expect(pageCalls()).toHaveLength(1)
      // 页图失败不改 detail 正文。
      expect(result.current.detailStatus).toBe('ready')
    },
  )

  it('retryPageImage 手动重试成功（失败后无自动重试）', async () => {
    let pageFail = true
    responder = (config) => {
      if (config.url === DETAIL_URL) return { status: 200, data: makeDetail() }
      if (pageFail) return { status: 500, data: { detail: 'boom' } }
      return { status: 200, data: new Blob(['jpeg'], { type: 'image/jpeg' }) }
    }
    const { result } = renderHook(
      () => useSourceMedia(inputOf(citationRequest(), { pageIdx: 3, wantPageImage: true })),
      { wrapper },
    )
    await waitFor(() => expect(result.current.pageImage.status).toBe('error'))
    expect(result.current.pageImage.failure).toBe('retryable')
    await wait()
    expect(pageCalls()).toHaveLength(1)

    pageFail = false
    act(() => result.current.retryPageImage())
    await waitFor(() => expect(result.current.pageImage.status).toBe('ready'))
    expect(result.current.pageImage.url).toBe('blob:mock-1')
    expect(pageCalls()).toHaveLength(2)
  })
})

describe('useSourceMedia — 原文件下载（blob + <a download>）', () => {
  function createdAnchors(): HTMLAnchorElement[] {
    const spy = vi.mocked(document.createElement)
    return spy.mock.results
      .map((entry) => entry.value as unknown)
      .filter(
        (value): value is HTMLAnchorElement =>
          typeof value === 'object' &&
          value !== null &&
          (value as HTMLElement).tagName === 'A',
      )
  }

  it('openFile → 成对版本 + Content-Disposition 文件名 + <a download>；不 window.open/新标签页', async () => {
    const createElementSpy = vi.spyOn(document, 'createElement')
    responder = (config) => {
      if (config.url === DETAIL_URL) return { status: 200, data: makeDetail() }
      if (config.url === FILE_URL) {
        return {
          status: 200,
          data: new Blob(['pdf-bytes'], { type: 'application/pdf' }),
          headers: {
            'content-disposition': 'attachment; filename="B05 paper.pdf"',
          },
        }
      }
      return { status: 500, data: { detail: 'unexpected' } }
    }
    const { result } = renderHook(() => useSourceMedia(inputOf(sourceRequest())), { wrapper })
    await waitFor(() => expect(result.current.detailStatus).toBe('ready'))
    // 未点击前不发下载请求
    expect(callsTo(FILE_URL)).toHaveLength(0)

    act(() => result.current.openFile())
    await waitFor(() => expect(anchorClick).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(result.current.file.status).toBe('idle'))

    const fileCalls = callsTo(FILE_URL)
    expect(fileCalls).toHaveLength(1)
    expect(fileCalls[0].params).toEqual({ document_id: 'doc_1', document_version: 'v3' })
    expect(fileCalls[0].responseType).toBe('blob')
    expect(fileCalls[0].headers?.Authorization).toBe('Bearer memory-token')
    expect(fileCalls[0].url).not.toMatch(/token|bearer|authorization/i)

    const anchors = createdAnchors()
    expect(anchors.length).toBeGreaterThanOrEqual(1)
    expect(anchors[0].getAttribute('download')).toBe('B05 paper.pdf')
    // PDF 也走 blob 下载：不 inline（无 target/_blank）、不 window.open
    expect(anchors[0].getAttribute('target')).toBeNull()
    expect(windowOpen).not.toHaveBeenCalled()
    // 下载 object URL 用后即回收
    expect(createObjectURL).toHaveBeenCalledTimes(1)
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:mock-1')
    createElementSpy.mockRestore()
  })

  it('Content-Disposition 缺失 → readerDownloadFileName 本地回退（title + 声明格式扩展名）', async () => {
    const createElementSpy = vi.spyOn(document, 'createElement')
    responder = (config) => {
      if (config.url === DETAIL_URL) return { status: 200, data: makeDetail() }
      return { status: 200, data: new Blob(['pdf-bytes'], { type: 'application/pdf' }) }
    }
    const { result } = renderHook(() => useSourceMedia(inputOf(sourceRequest())), { wrapper })
    await waitFor(() => expect(result.current.detailStatus).toBe('ready'))
    act(() => result.current.openFile())
    await waitFor(() => expect(anchorClick).toHaveBeenCalledTimes(1))
    expect(createdAnchors()[0].getAttribute('download')).toBe('Paper A.pdf')
    createElementSpy.mockRestore()
  })

  it('title 缺失 → 回退 document_id + 扩展名', async () => {
    const createElementSpy = vi.spyOn(document, 'createElement')
    responder = (config) => {
      if (config.url === DETAIL_URL) return { status: 200, data: makeDetail({ title: null }) }
      return { status: 200, data: new Blob(['pptx-bytes'], { type: 'application/octet-stream' }) }
    }
    const { result } = renderHook(() => useSourceMedia(inputOf(sourceRequest())), { wrapper })
    await waitFor(() => expect(result.current.detailStatus).toBe('ready'))
    act(() => result.current.openFile())
    await waitFor(() => expect(anchorClick).toHaveBeenCalledTimes(1))
    expect(createdAnchors()[0].getAttribute('download')).toBe('doc_1.pdf')
    createElementSpy.mockRestore()
  })

  it.each([
    ['410 envelope 撤权', 410, { detail: { code: 'source_access_restricted', message: 'revoked' } }, 'forbidden'],
    ['422 source_ref_mismatch', 422, { detail: { code: 'source_ref_mismatch', message: 'mismatch' } }, 'source_unavailable'],
    ['404 文件不可用', 404, { detail: 'Source file is not available' }, 'unavailable'],
    ['500', 500, { detail: 'boom' }, 'retryable'],
    ['网络错误', 0, null, 'retryable'],
  ] as const)(
    '下载失败 %s → §2.10 分类 %s；不改正文、无自动重试',
    async (_label, status, data, expected) => {
      responder = (config) => {
        if (config.url === DETAIL_URL) return { status: 200, data: makeDetail() }
        return { status, data }
      }
      const { result } = renderHook(() => useSourceMedia(inputOf(sourceRequest())), { wrapper })
      await waitFor(() => expect(result.current.detailStatus).toBe('ready'))
      act(() => result.current.openFile())
      await waitFor(() => expect(result.current.file.status).toBe('error'))
      expect(result.current.file.failure).toBe(expected)
      expect(anchorClick).not.toHaveBeenCalled()
      expect(windowOpen).not.toHaveBeenCalled()
      expect(result.current.detailStatus).toBe('ready')
      expect(callsTo(FILE_URL)).toHaveLength(1)
      await wait()
      expect(callsTo(FILE_URL)).toHaveLength(1)
    },
  )

  it('detail 未 ready 时 openFile 不发下载请求', async () => {
    let resolveDetail: ((outcome: Outcome) => void) | null = null
    responder = (config) => {
      if (config.url === DETAIL_URL) {
        return new Promise<Outcome>((resolve) => {
          resolveDetail = resolve
        })
      }
      return { status: 200, data: new Blob(['x']) }
    }
    const { result } = renderHook(() => useSourceMedia(inputOf(sourceRequest())), { wrapper })
    await wait()
    act(() => result.current.openFile())
    await wait()
    expect(callsTo(FILE_URL)).toHaveLength(0)
    expect(resolveDetail).not.toBeNull()
  })
})
