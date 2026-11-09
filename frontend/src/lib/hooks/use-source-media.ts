'use client'

/**
 * 目标壳宽屏阅读器数据层（Issue #1077 W2；合并计划 §2.3/§2.4/§2.8/§2.10）。
 *
 * 唯一职责：把「阅读器打开请求」变成 UI 可直接消费的媒体读状态——
 * - 来源详情（`getSource`，citation 入口带**成对**版本参数）；
 * - 版本护栏（match / mismatch / unverifiable / latest；mismatch 不回退最新）；
 * - 可定位页集合（`locateReaderPages`）；
 * - 页图状态机（按需单页请求、blob URL 创建/回收、手动重试、§2.10 失败分类）；
 * - 原文件下载（`getSourceFile` → blob + `<a download>`，含 PDF，绝不
 *   `window.open`/`target=_blank`，文件名优先 Content-Disposition 再回退）。
 *
 * 边界（计划 §2.8/NORMATIVE 16/18）：
 * - 所有请求经既有 `@/lib/research/api`（`apiClient`，Bearer 来自内存 Token），
 *   **token 绝不进入 URL/查询串**；本模块不建立第二套 axios 实例；
 * - 组件不做 fetch：页图/文件失败只改媒体状态，不改正文，也无自动重试
 *   循环（只有用户点击 `retryDetail`/`retryPageImage`/`openFile` 才发新请求）；
 * - 页图只在 `wantPageImage && pageIdx >= 0 && versionState !== 'mismatch'`
 *   且 detail 提供成对版本时请求（detail 未 ready → `pageImage.status='idle'`），
 *   切页/新请求/卸载/失败一律 `URL.revokeObjectURL` 旧地址；
 * - 旧 host（`source_type` 缺失）不伪造页图：detail 照常返回，由组件
 *   fail-closed 显示能力不可用。
 */

import { useQuery } from '@tanstack/react-query'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  getSource,
  getSourceFile,
  getSourcePageImage,
  isResearchMediaError,
  type SourceDocumentRef,
} from '@/lib/research/api'
import { readerDownloadFileName } from '@/lib/research/reader'
import {
  classifySourceMediaFailure,
  type SourceMediaFailureInput,
  type SourceMediaFailureKind,
} from '@/lib/research/source-media'
import {
  locateReaderPages,
  resolveReaderVersionState,
  type TargetReaderOpenRequest,
  type TargetReaderVersionState,
} from '@/components/research/target/target-reader-state'
import type { ResearchSourceDetail } from '@/lib/types/research'

export interface UseSourceMediaInput {
  projectId: string
  /** null = 阅读器未打开（不发任何请求） */
  request: TargetReaderOpenRequest | null
  /** 当前页（0-based，由 shell 用纯逻辑解析；null/非法 = 无当前页） */
  pageIdx: number | null
  /** pdf/ppt 且为页模式（shell 用 `readerBodyMode` 计算） */
  wantPageImage: boolean
}

export type ReaderMediaStatus = 'idle' | 'loading' | 'ready' | 'error'

/**
 * 阅读器媒体失败分类：§2.10 五类 + `session_expired`（401）。
 *
 * `source-media.ts` 的 `classifySourceMediaFailure` 是 #1011 冻结分类器（本单
 * 不改它）；阅读器在调用后补一层 §2.9 的 401 语义：会话失效**结束重试**、
 * 显示「会话已失效」，不把 401 混进可重试/撤权文案。
 */
export type ReaderMediaFailure = SourceMediaFailureKind | 'session_expired'

function classifyReaderMediaFailure(failure: SourceMediaFailureInput): ReaderMediaFailure {
  if (failure.status === 401) return 'session_expired'
  return classifySourceMediaFailure(failure)
}

export interface ReaderPageImageState {
  status: ReaderMediaStatus
  /** blob URL（`status==='ready'` 时可用；创建失败为 null，不伪造） */
  url: string | null
  failure: ReaderMediaFailure | null
}

export interface ReaderFileState {
  status: 'idle' | 'loading' | 'error'
  failure: ReaderMediaFailure | null
}

export interface UseSourceMediaResult {
  detail: ResearchSourceDetail | null
  /** idle = 未打开；loading = 首次读取中；ready/error 为终态 */
  detailStatus: ReaderMediaStatus
  detailFailure: ReaderMediaFailure | null
  /** 手动重试（无自动循环）；仅 request 非 null 时有动作 */
  retryDetail: () => void
  versionState: TargetReaderVersionState
  /** `detail.source_type`（只为字符串时取值；缺失 = 旧 host → 能力不可用） */
  sourceType: string | null
  /** 可定位页集合（0-based 升序；citation 页仅在版本 match 时并入） */
  pages: number[]
  /**
   * §2.9/NORMATIVE 14：任一媒体子请求收到 410 envelope 撤权 → 清空正文/摘录。
   * 页图/下载的 410 与详情 410 同义（不把撤权伪装成「页不可用」）。
   */
  restricted: boolean
  pageImage: ReaderPageImageState
  retryPageImage: () => void
  file: ReaderFileState
  /** blob + `<a download>`；失败只写 `file.failure`，不改正文 */
  openFile: () => void
}

const IDLE_PAGE_IMAGE: ReaderPageImageState = Object.freeze({
  status: 'idle',
  url: null,
  failure: null,
})

const IDLE_FILE: ReaderFileState = Object.freeze({
  status: 'idle',
  failure: null,
})

const CODE_SOURCE_REF_MISMATCH = 'source_ref_mismatch'

/**
 * 媒体读错误 → `classifySourceMediaFailure` 的分类输入（§2.10）。
 *
 * 结构化读取（不依赖具体 error 类）：`ResearchMediaError` 暴露
 * `status/code/detail`；axios 错误回落到 `response.status` + envelope
 * `detail.code`/纯 detail 文案；网络错误三字段全 null（按可重试处理）。
 */
function extractSourceMediaFailure(error: unknown): SourceMediaFailureInput {
  if (isResearchMediaError(error)) {
    return { status: error.status, code: error.code, detail: error.detail }
  }
  if (error === null || typeof error !== 'object') {
    return { status: null, code: null, detail: null }
  }
  const record = error as {
    status?: unknown
    code?: unknown
    detail?: unknown
    response?: { status?: unknown; data?: unknown }
  }
  const response = record.response
  const status =
    typeof record.status === 'number'
      ? record.status
      : typeof response?.status === 'number'
        ? response.status
        : null

  // ⚠ 真实 axios 错误在**顶层** `code` 放传输层码（如 `ERR_BAD_REQUEST`），
  // 服务端 envelope 码在 `response.data.detail.code`。分类唯一判据必须是
  // 服务端 envelope（或纯 detail 文案），不能拿传输层 code 当 envelope 码
  // ——否则 detail 读的 410/422 永远落到 `retryable`（撤权/版本失效 UI 不可达）。
  let code: string | null = null
  let detail: string | null = null
  if (response !== undefined && response !== null) {
    const payload = response.data
    if (typeof payload === 'string') {
      // 纯 detail 响应体（如 404 `Preview not supported ...`）。
      detail = payload.length > 0 ? payload : null
    } else if (payload !== null && typeof payload === 'object' && !Array.isArray(payload)) {
      const envelopeDetail = (payload as { detail?: unknown }).detail
      if (typeof envelopeDetail === 'string') {
        detail = envelopeDetail.length > 0 ? envelopeDetail : null
      } else if (
        envelopeDetail !== null &&
        typeof envelopeDetail === 'object' &&
        !Array.isArray(envelopeDetail)
      ) {
        const envelopeCode = (envelopeDetail as { code?: unknown }).code
        code =
          typeof envelopeCode === 'string' && envelopeCode.length > 0 ? envelopeCode : null
      }
    }
  }
  if (code === null && detail === null) {
    // 注入/归一后的错误对象（非 axios 形状）：只接受显式服务端字段，忽略
    // axios 传输层 `code`（`ERR_*`）。
    const injectedDetail = typeof record.detail === 'string' ? record.detail : null
    detail = injectedDetail !== null && injectedDetail.length > 0 ? injectedDetail : null
    const injectedCode = typeof record.code === 'string' ? record.code : null
    code =
      injectedCode !== null && injectedCode.length > 0 && !/^ERR_/i.test(injectedCode)
        ? injectedCode
        : null
  }
  return { status, code, detail }
}

/** detail 是否提供成对版本（页图/原文件 query 参数；缺一 = 不可请求）。 */
function pairedDocumentRef(detail: ResearchSourceDetail | null): SourceDocumentRef | null {
  if (detail === null) return null
  const documentId = typeof detail.document_id === 'string' ? detail.document_id : ''
  const documentVersion =
    typeof detail.document_version === 'string' ? detail.document_version : ''
  if (documentId.length === 0 || documentVersion.length === 0) return null
  return { documentId, documentVersion }
}

/**
 * blob → 浏览器下载（`<a download>`）。所有格式（含 PDF）一律下载：
 * fork 运行在 host iframe 内（sandbox 无 allow-popups），**不**调用
 * `window.open`/`target=_blank`（§2.6/NORMATIVE 16）。
 */
function triggerBlobDownload(blob: Blob, filename: string): void {
  if (typeof URL.createObjectURL !== 'function') return
  const objectUrl = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = objectUrl
  anchor.download = filename
  anchor.rel = 'noopener'
  anchor.style.display = 'none'
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  if (typeof URL.revokeObjectURL === 'function') URL.revokeObjectURL(objectUrl)
}

/**
 * 宽屏阅读器媒体读状态 hook（数据拉取只在 hook，组件不 fetch）。
 *
 * query key 明确包含成对版本：无 ref（source 入口 / citation 缺版本）时为
 * `['research', projectId, 'sources', sourceId, '', '']`，与「最新版读取」
 * 一致；citation 入口为成对 document_id/document_version。
 */
export function useSourceMedia(input: UseSourceMediaInput): UseSourceMediaResult {
  const { projectId, request, pageIdx, wantPageImage } = input
  const sourceId = request?.sourceId ?? null
  const requestRef = request?.documentRef ?? null
  const hasRequest = request !== null

  const {
    data: queriedDetail,
    error: queryError,
    refetch,
  } = useQuery({
    queryKey: [
      'research',
      projectId,
      'sources',
      sourceId ?? '',
      requestRef?.documentId ?? '',
      requestRef?.documentVersion ?? '',
    ] as const,
    queryFn: () => {
      if (sourceId === null) throw new Error('source id is required')
      return requestRef === null
        ? getSource(projectId, sourceId)
        : getSource(projectId, sourceId, requestRef)
    },
    enabled: hasRequest && sourceId !== null,
    // 手动重试 only：失败不自动循环（含 401/网络错误）。
    retry: false,
  })

  const rawDetail = hasRequest ? (queriedDetail ?? null) : null
  const mediaFailureInput = queryError === undefined || queryError === null
    ? null
    : extractSourceMediaFailure(queryError)

  // 服务端 422 source_ref_mismatch = 被引版本已失效：显式 mismatch（不回退最新）。
  const serverVersionMismatch =
    rawDetail === null &&
    request !== null &&
    request.documentRef !== null &&
    mediaFailureInput !== null &&
    mediaFailureInput.status === 422 &&
    mediaFailureInput.code === CODE_SOURCE_REF_MISMATCH

  const baseVersionState: TargetReaderVersionState = request === null
    ? { kind: 'latest' }
    : resolveReaderVersionState(request, rawDetail)
  const versionState: TargetReaderVersionState = serverVersionMismatch
    ? { kind: 'mismatch' }
    : baseVersionState

  const clientVersionMismatch = versionState.kind === 'mismatch' && !serverVersionMismatch
  // mismatch 一律不提供正文（不回退最新版内容）。
  const detail = versionState.kind === 'mismatch' ? null : rawDetail

  const detailFailure: ReaderMediaFailure | null = request === null
    ? null
    : mediaFailureInput !== null
      ? classifyReaderMediaFailure(mediaFailureInput)
      : clientVersionMismatch
        ? 'source_unavailable'
        : null

  const detailStatus: ReaderMediaStatus = request === null
    ? 'idle'
    : detailFailure !== null
      ? 'error'
      : detail !== null
        ? 'ready'
        : 'loading'

  const pages = detail === null
    ? []
    : locateReaderPages({
        chunks: Array.isArray(detail.markdown_chunks) ? detail.markdown_chunks : [],
        citationPageIdx: request?.citation?.page_idx ?? null,
        versionState,
      })

  const sourceType = typeof detail?.source_type === 'string' ? detail.source_type : null


  const detailDocumentRef = pairedDocumentRef(detail)
  const detailDocumentId = detailDocumentRef?.documentId ?? null
  const detailDocumentVersion = detailDocumentRef?.documentVersion ?? null

  const pageImageTarget =
    wantPageImage &&
    detailStatus === 'ready' &&
    versionState.kind !== 'mismatch' &&
    detailDocumentRef !== null &&
    typeof pageIdx === 'number' &&
    Number.isInteger(pageIdx) &&
    pageIdx >= 0
      ? pageIdx
      : null

  const [pageImage, setPageImage] = useState<ReaderPageImageState>(IDLE_PAGE_IMAGE)
  const [file, setFile] = useState<ReaderFileState>(IDLE_FILE)

  // §2.9/NORMATIVE 14：任一媒体子请求收到 410 envelope 撤权 → 清空正文/摘录。
  // 页图/下载的 410 与来源详情 410 同义（不把撤权伪装成「页不可用」）。
  const restricted =
    detailFailure === 'forbidden' ||
    pageImage.failure === 'forbidden' ||
    file.failure === 'forbidden'

  // 请求代际：切页/重置/卸载时 bump，旧响应回来不写状态、不建 blob URL。
  const pageImageRequestRef = useRef(0)
  const pageImageObjectUrlRef = useRef<string | null>(null)
  const fileLoadingRef = useRef(false)

  const revokePageImageObjectUrl = useCallback((): void => {
    const current = pageImageObjectUrlRef.current
    if (current === null) return
    pageImageObjectUrlRef.current = null
    if (typeof URL.revokeObjectURL === 'function') URL.revokeObjectURL(current)
  }, [])

  const loadPageImage = useCallback(
    async (targetPageIdx: number, ref: SourceDocumentRef): Promise<void> => {
      if (sourceId === null) return
      const requestId = pageImageRequestRef.current + 1
      pageImageRequestRef.current = requestId
      revokePageImageObjectUrl()
      setPageImage({ status: 'loading', url: null, failure: null })
      try {
        const blob = await getSourcePageImage(projectId, sourceId, targetPageIdx, ref)
        if (pageImageRequestRef.current !== requestId) return
        const url =
          typeof URL.createObjectURL === 'function' ? URL.createObjectURL(blob) : null
        if (url !== null) pageImageObjectUrlRef.current = url
        setPageImage({ status: 'ready', url, failure: null })
      } catch (error) {
        if (pageImageRequestRef.current !== requestId) return
        setPageImage({
          status: 'error',
          url: null,
          failure: classifyReaderMediaFailure(extractSourceMediaFailure(error)),
        })
      }
    },
    [projectId, revokePageImageObjectUrl, sourceId],
  )

  // 页图自动请求：仅当前页（单页按需，不预取）；条件不满足 → idle 并回收旧地址。
  useEffect(() => {
    if (
      pageImageTarget === null ||
      detailDocumentId === null ||
      detailDocumentVersion === null
    ) {
      pageImageRequestRef.current += 1
      revokePageImageObjectUrl()
      setPageImage((current) =>
        current.status === 'idle' && current.url === null && current.failure === null
          ? current
          : IDLE_PAGE_IMAGE,
      )
      return
    }
    void loadPageImage(pageImageTarget, {
      documentId: detailDocumentId,
      documentVersion: detailDocumentVersion,
    })
  }, [
    detailDocumentId,
    detailDocumentVersion,
    loadPageImage,
    pageImageTarget,
    revokePageImageObjectUrl,
  ])

  // 卸载：bump 代际（在途响应作废）并回收当前 blob URL。
  useEffect(
    () => () => {
      pageImageRequestRef.current += 1
      revokePageImageObjectUrl()
    },
    [revokePageImageObjectUrl],
  )

  const retryPageImage = useCallback((): void => {
    if (
      pageImageTarget === null ||
      detailDocumentId === null ||
      detailDocumentVersion === null
    ) {
      return
    }
    void loadPageImage(pageImageTarget, {
      documentId: detailDocumentId,
      documentVersion: detailDocumentVersion,
    })
  }, [detailDocumentId, detailDocumentVersion, loadPageImage, pageImageTarget])

  const retryDetail = useCallback((): void => {
    if (!hasRequest) return
    void refetch()
  }, [hasRequest, refetch])

  // 换来源/换版本：文件状态复位（旧失败提示不带到新来源）。
  useEffect(() => {
    fileLoadingRef.current = false
    setFile((current) =>
      current.status === 'idle' && current.failure === null ? current : IDLE_FILE,
    )
  }, [detailDocumentId, detailDocumentVersion, sourceId])

  const openFile = useCallback((): void => {
    if (detail === null || sourceId === null || fileLoadingRef.current) return
    const ref = pairedDocumentRef(detail)
    if (ref === null) return
    fileLoadingRef.current = true
    setFile({ status: 'loading', failure: null })
    void (async () => {
      try {
        const { blob, filename } = await getSourceFile(projectId, sourceId, ref)
        // Content-Disposition 可用时优先；跨域读不到时按声明格式本地回退（#1080）。
        const fallbackName = readerDownloadFileName(
          detail.title,
          detail.document_id,
          sourceType,
        )
        triggerBlobDownload(blob, filename ?? fallbackName)
        setFile(IDLE_FILE)
      } catch (error) {
        // §2.10：下载失败只体现在 file.failure，不改正文。
        setFile({
          status: 'error',
          failure: classifyReaderMediaFailure(extractSourceMediaFailure(error)),
        })
      } finally {
        fileLoadingRef.current = false
      }
    })()
  }, [detail, projectId, sourceId, sourceType])

  return {
    detail,
    detailStatus,
    detailFailure,
    retryDetail,
    versionState,
    sourceType,
    restricted,
    pages,
    pageImage,
    retryPageImage,
    file,
    openFile,
  }
}
