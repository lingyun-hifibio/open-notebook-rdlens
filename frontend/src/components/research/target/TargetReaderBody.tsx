'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactElement, ReactNode } from 'react'

import { Button } from '@/components/ui/button'
import { MarkdownRenderer } from '@/components/ui/markdown-renderer'
import { useTranslation } from '@/lib/hooks/use-translation'
import type { UseSourceMediaResult } from '@/lib/hooks/use-source-media'
import {
  chunkHasFigureMarker,
  readerBodyMode,
  readerLocatorKey,
  readerLocatorKind,
  readerNormalizedChunks,
  readerPageChunks,
} from '@/lib/research/reader'
import { buildSelectionContext } from '@/lib/research/selection-range'
import type { WireSelectionContext } from '@/lib/research/session-contract'
import type { ReaderMediaFailure } from '@/lib/hooks/use-source-media'
import type { ResearchPendingSelection } from '@/lib/research/types'
import type { ResearchChunk } from '@/lib/types/research'
import { readerPageNeighbor, type TargetReaderOpenRequest } from './target-reader-state'

/** 页图失败分类 → 用户可见文案（§2.9/§2.10；撤权/不支持/不可用分开解释）。 */
const PAGE_IMAGE_FAILURE_KEYS: Record<ReaderMediaFailure, string> = {
  forbidden: 'research.target.reader.restricted',
  unsupported: 'research.target.reader.pageUnavailable',
  source_unavailable: 'research.target.reader.pageUnavailable',
  unavailable: 'research.target.reader.pageUnavailable',
  retryable: 'research.target.reader.pageImageFailed',
  session_expired: 'research.target.reader.sessionExpired',
}

/** §2.10：500/503/网络错误与「页不可用」允许用户点击手动重试一次；撤权不重试。 */
function pageImageRetryable(failure: ReaderMediaFailure | null): boolean {
  return failure === 'retryable' || failure === 'unavailable'
}

/** 浮层「讨论选段」的定位与载荷（视口坐标；元素 fixed 定位）。 */
interface PendingSelectionAction {
  readonly selection: WireSelectionContext
  readonly chunk: ResearchChunk
  readonly chunkOrdinal: number
  readonly left: number
  readonly top: number
}

export interface TargetReaderBodyProps {
  request: TargetReaderOpenRequest
  media: UseSourceMediaResult
  /** 当前页（0-based；shell 由 `locateReaderPages`/`resolveReaderInitialPage` 解析） */
  pageIdx: number | null
  /** 可定位页集合（只在此集合内导航，不探测未知页） */
  pages: number[]
  onSelectPage: (pageIdx: number) => void
  onDiscussSelection: (pending: ResearchPendingSelection) => void
  onOpenFile: () => void
}

/**
 * 宽屏阅读器正文列（Issue #1077 W2；UI 规格 v1 §5.7；合并计划 §2.4/§2.5/
 * §2.9/§2.10-6/7/10）。
 *
 * 状态优先级（fail-closed，不伪造原文）：
 * 1. detail 加载中 → 加载文案；
 * 2. 版本不一致 → 版本失效说明，**不显示**任何正文/页图（不回退最新版）；
 * 3. 撤权 410 → 清空正文/页图，只显示受限说明（无自动重试）；
 * 4. detail 失败（404/422/500/503/网络）→ 可解释失败 + 按 §2.10 的手动重试；
 * 5. `source_type` 缺失（旧 host/能力缺失）→ 能力不可用（不伪造正文）；
 * 6. 正文按声明格式：PDF/PPT = 页图 + 同页规范化正文块（可选中）；其余 =
 *    规范化正文（常显「非原版式」标注）。
 *
 * 诚实边界：
 * - 页图 `<img>` 本身不可选中文本 → 同页无正文块时显示「该页无可选文本」；
 * - #1031 兜底 chunk 在 PDF/PPT 页模式**不渲染**（不作为第 1 页正文）；
 * - 图表 chunk 只显示「不可读/需人工核对」提示 + 下载入口，不推断内容；
 * - 页导航只在可定位页集合内移动（不伪造总页数、不探测未知页）；
 * - 选段只允许单个 chunk 内、且需要逐 chunk `content_hash`/`chunk_ordinal`
 *   才产生 #1013 的 11 键载荷（缺一 fail-closed 并显示可读原因）。
 */
export function TargetReaderBody({
  request,
  media,
  pageIdx,
  pages,
  onSelectPage,
  onDiscussSelection,
  onOpenFile,
}: TargetReaderBodyProps) {
  const { t } = useTranslation()
  const rootRef = useRef<HTMLDivElement | null>(null)
  const [pendingAction, setPendingAction] = useState<PendingSelectionAction | null>(null)
  const [selectionFailed, setSelectionFailed] = useState(false)

  const detail = media.detail
  const versionState = media.versionState
  const detailFailure = media.detailFailure
  const sourceType = media.sourceType
  const sourceTypeAvailable =
    typeof sourceType === 'string' && sourceType.trim().length > 0

  // #1013 选段：Range 必须完全落在单个 [data-chunk-id] 内；缺逐 chunk
  // content_hash / chunk_ordinal 时不产生载荷（fail-closed）。
  useEffect(() => {
    if (detail === null) {
      setPendingAction(null)
      setSelectionFailed(false)
      return
    }
    const root = rootRef.current
    if (root === null) return
    const clear = (): void => setPendingAction(null)
    const onSelectionChange = (): void => {
      const selection = window.getSelection()
      if (selection === null || selection.isCollapsed || selection.rangeCount === 0) {
        clear()
        return
      }
      const range = selection.getRangeAt(0)
      if (range.collapsed) {
        clear()
        return
      }
      const elementFor = (node: Node): HTMLElement | null =>
        node.nodeType === Node.ELEMENT_NODE
          ? (node as HTMLElement)
          : node.parentElement
      const chunkNode =
        elementFor(range.startContainer)?.closest<HTMLElement>('[data-chunk-id]') ?? null
      const endChunkNode =
        elementFor(range.endContainer)?.closest<HTMLElement>('[data-chunk-id]') ?? null
      if (
        chunkNode === null ||
        rootRef.current === null ||
        !rootRef.current.contains(chunkNode)
      ) {
        clear()
        return
      }
      // §5.4/v1：跨 chunk 选择一律拒绝（stable `cross_chunk` 语义，不猜多条载荷）。
      if (endChunkNode !== chunkNode) {
        clear()
        setSelectionFailed(true)
        return
      }
      const chunkId = chunkNode.dataset.chunkId ?? ''
      const chunk = detail.markdown_chunks.find(
        (candidate) => candidate.chunk_id === chunkId,
      )
      if (chunk === undefined) {
        clear()
        return
      }
      const chunkOrdinal =
        typeof chunk.chunk_ordinal === 'number' ? chunk.chunk_ordinal : null
      const contentHash =
        typeof chunk.content_hash === 'string' ? chunk.content_hash : null
      // 缺逐 chunk 身份（旧响应/测试替身）：不产生选段，给可读失败原因。
      if (chunkOrdinal === null || contentHash === null) {
        clear()
        setSelectionFailed(true)
        return
      }
      const result = buildSelectionContext({
        range,
        chunkRoot: chunkNode,
        chunk: {
          chunkId: chunk.chunk_id,
          chunkOrdinal,
          contentHash,
          pageIdx: chunk.page_idx,
          markdown: chunk.markdown,
        },
        source: {
          sourceId: request.sourceId,
          documentId: detail.document_id,
          documentVersion: detail.document_version,
        },
      })
      if (!result.ok) {
        clear()
        setSelectionFailed(true)
        return
      }
      // jsdom/受限宿主可能不实现 Range 几何：退化为 chunk 元素位置，仍可讨论。
      const rect =
        typeof range.getBoundingClientRect === 'function'
          ? range.getBoundingClientRect()
          : chunkNode.getBoundingClientRect()
      setSelectionFailed(false)
      setPendingAction({
        selection: result.selection,
        chunk,
        chunkOrdinal,
        left: rect.left + rect.width / 2,
        top: rect.top,
      })
    }
    document.addEventListener('selectionchange', onSelectionChange)
    document.addEventListener('mouseup', onSelectionChange)
    document.addEventListener('keyup', onSelectionChange)
    return () => {
      document.removeEventListener('selectionchange', onSelectionChange)
      document.removeEventListener('mouseup', onSelectionChange)
      document.removeEventListener('keyup', onSelectionChange)
    }
  }, [detail, request.sourceId])

  const discussPendingSelection = useCallback((): void => {
    if (pendingAction === null) return
    onDiscussSelection({
      selection: pendingAction.selection,
      sourceId: request.sourceId,
      sourceTitle: detail?.title ?? null,
      pageIdx: pendingAction.chunk.page_idx,
      chunkOrdinal: pendingAction.chunkOrdinal,
      target: 'global',
    })
    setPendingAction(null)
    setSelectionFailed(false)
    try {
      window.getSelection()?.removeAllRanges()
    } catch {
      // 忽略 Selection 不可用的宿主。
    }
  }, [detail?.title, onDiscussSelection, pendingAction, request.sourceId])

  // §2.4：仅 `file_available === true` 且详情就绪时才提供原文件下载（不伪造）。
  const downloadAvailable =
    media.detailStatus === 'ready' && media.detail?.file_available === true
  const downloadDisabled = !downloadAvailable || media.file.status === 'loading'
  const downloadFailed = media.file.status === 'error'
  const downloadButton = (testId: string): ReactElement => (
    <Button
      type="button"
      size="sm"
      variant="outline"
      data-testid={testId}
      disabled={downloadDisabled}
      title={downloadAvailable ? undefined : t('research.target.reader.downloadUnavailable')}
      onClick={() => {
        if (downloadAvailable) onOpenFile()
      }}
    >
      {t('research.target.reader.download')}
    </Button>
  )

  const renderSelectionAction = (): ReactElement | null => {
    if (pendingAction === null) return null
    return (
      <div
        key="discuss-selection"
        className="fixed z-50 -translate-x-1/2 -translate-y-full pb-1"
        style={{ left: pendingAction.left, top: pendingAction.top }}
      >
        <Button
          type="button"
          size="sm"
          data-testid="rdlens-target-reader-discuss-selection"
          onClick={discussPendingSelection}
        >
          {t('research.selection.discuss')}
        </Button>
      </div>
    )
  }

  const renderChunk = (input: {
    chunk: ResearchChunk
    ordinal: number
    locator: string | null
    fallback: boolean
  }): ReactElement => {
    const { chunk, ordinal, locator, fallback } = input
    return (
      <section
        key={`${chunk.chunk_id}-${ordinal}`}
        data-testid="rdlens-target-reader-chunk"
        data-chunk-id={chunk.chunk_id}
        data-chunk-ordinal={ordinal}
        data-chunk-page={chunk.page_idx}
        className="space-y-2 rounded-md border p-3"
        style={{ borderColor: 'var(--rdlens-line)', background: 'var(--rdlens-surface)' }}
      >
        {locator !== null && (
          <p
            className="text-xs font-medium"
            style={{ color: 'var(--rdlens-ink-muted)' }}
            data-testid="rdlens-target-reader-chunk-locator"
          >
            {locator}
          </p>
        )}
        {fallback && (
          <p
            className="text-[11px]"
            style={{ color: 'var(--rdlens-ink-muted)' }}
            data-testid="rdlens-target-reader-fallback-note"
          >
            {t('research.target.reader.fallbackPositionNote')}
          </p>
        )}
        <MarkdownRenderer>{chunk.markdown}</MarkdownRenderer>
        {chunkHasFigureMarker(chunk.markdown) && (
          <div
            className="space-y-2 rounded-md border border-dashed p-2"
            data-testid="rdlens-target-reader-figure-note"
          >
            <p
              className="text-xs"
              role="status"
              style={{ color: 'var(--rdlens-warning)' }}
            >
              {t('research.target.reader.figureUnavailable')}
            </p>
            {downloadButton('rdlens-target-reader-figure-download')}
            {downloadFailed && (
              <p
                className="text-xs"
                role="status"
                style={{ color: 'var(--rdlens-warning)' }}
                data-testid="rdlens-target-reader-download-failed"
              >
                {media.file.failure === 'session_expired'
                  ? t('research.target.reader.sessionExpired')
                  : t('research.target.reader.downloadFailed')}
              </p>
            )}
          </div>
        )}
      </section>
    )
  }

  const bodyRoot = (children: ReactNode): ReactElement => (
    <div
      ref={rootRef}
      data-testid="rdlens-target-reader-body"
      className="space-y-4"
    >
      {children}
    </div>
  )

  // 1) detail 加载中（idle 视为未就绪：reader 打开即发起 detail 请求）
  if (media.detailStatus === 'idle' || media.detailStatus === 'loading') {
    return bodyRoot(
      <p
        className="text-sm"
        role="status"
        aria-busy="true"
        style={{ color: 'var(--rdlens-ink-muted)' }}
        data-testid="rdlens-target-reader-loading"
      >
        {t('research.target.reader.loadingDetail')}
      </p>,
    )
  }

  // 2) 版本护栏不一致：不显示任何正文/页图（不回退最新版）。
  if (versionState.kind === 'mismatch') {
    return bodyRoot(
      <p
        className="text-sm"
        role="status"
        style={{ color: 'var(--rdlens-warning)' }}
        data-testid="rdlens-target-reader-version-mismatch"
      >
        {t('research.target.reader.versionMismatch')}
      </p>,
    )
  }

  // 2b) 会话失效（401）：清空正文/页图、结束重试（§2.9；不无限 Retry）。
  if (media.detailFailure === 'session_expired') {
    return bodyRoot(
      <p
        className="text-sm"
        role="status"
        style={{ color: 'var(--rdlens-warning)' }}
        data-testid="rdlens-target-reader-session-expired"
      >
        {t('research.target.reader.sessionExpired')}
      </p>,
    )
  }

  // 3) 撤权（410 envelope）：清空正文/页图，只给受限说明 + 下载入口（若可用）。
  if (detailFailure === 'forbidden') {
    return bodyRoot(
      <div className="space-y-3" data-testid="rdlens-target-reader-restricted">
        <p className="text-sm" role="status" style={{ color: 'var(--rdlens-warning)' }}>
          {t('research.target.reader.restricted')}
        </p>
        {downloadButton('rdlens-target-reader-restricted-download')}
        {downloadFailed && (
          <p
            className="text-xs"
            role="status"
            style={{ color: 'var(--rdlens-warning)' }}
            data-testid="rdlens-target-reader-download-failed"
          >
            {media.file.failure === 'session_expired'
              ? t('research.target.reader.sessionExpired')
              : t('research.target.reader.downloadFailed')}
          </p>
        )}
      </div>,
    )
  }

  // 4) detail 失败：可解释失败 + §2.10 手动重试（不自动循环）。
  if (media.detailStatus === 'error' || detail === null) {
    return bodyRoot(
      <div className="space-y-3" data-testid="rdlens-target-reader-detail-failed">
        <p className="text-sm" role="status" style={{ color: 'var(--rdlens-warning)' }}>
          {t('research.target.reader.detailFailed')}
        </p>
        {detailFailure === 'retryable' && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            data-testid="rdlens-target-reader-retry"
            onClick={() => media.retryDetail()}
          >
            {t('research.target.reader.retry')}
          </Button>
        )}
      </div>,
    )
  }

  // 5) 能力缺失（旧 host 无 source_type）：fail-closed，不伪造正文。
  if (!sourceTypeAvailable) {
    return bodyRoot(
      <p
        className="text-sm"
        role="status"
        style={{ color: 'var(--rdlens-ink-muted)' }}
        data-testid="rdlens-target-reader-capability-unavailable"
      >
        {t('research.target.reader.capabilityUnavailable')}
      </p>,
    )
  }

  const notices: ReactNode[] = []
  if (versionState.kind === 'unverifiable' && request.citation !== null) {
    // §2.4 版本护栏：cit 不可核对时正文按当前可用版本读取，必须显式标注。
    notices.push(
      <p
        key="version-unverifiable"
        className="text-xs"
        role="status"
        style={{ color: 'var(--rdlens-warning)' }}
        data-testid="rdlens-target-reader-current-version-note"
      >
        {t('research.target.reader.currentVersionNote')}
      </p>,
    )
  }

  const mode = readerBodyMode(sourceType)
  const chunks = detail.markdown_chunks

  if (mode === 'page-image') {
    const locatorKey = readerLocatorKey(sourceType)
    const prevPage =
      pageIdx === null ? null : readerPageNeighbor(pages, pageIdx, -1)
    const nextPage =
      pageIdx === null ? null : readerPageNeighbor(pages, pageIdx, 1)
    const pageChunks = pageIdx === null ? [] : readerPageChunks(chunks, pageIdx)
    const pageLabel =
      locatorKey === null || pageIdx === null
        ? null
        : t(locatorKey, { page: pageIdx + 1 })
    const pageImage = media.pageImage

    return bodyRoot([
      ...notices,
      pages.length > 0 && pageIdx !== null && (
        <nav
          key="page-nav"
          className="flex items-center justify-between gap-2"
          data-testid="rdlens-target-reader-page-nav"
        >
          <Button
            type="button"
            size="sm"
            variant="outline"
            data-testid="rdlens-target-reader-prev-page"
            aria-label={t('research.target.reader.previousPage')}
            disabled={prevPage === null}
            onClick={() => {
              if (prevPage !== null) onSelectPage(prevPage)
            }}
          >
            {t('research.target.reader.previousPage')}
          </Button>
          <p
            className="rdlens-mono text-sm"
            style={{ color: 'var(--rdlens-ink-muted)' }}
            data-testid="rdlens-target-reader-page-label"
          >
            {pageLabel ?? t('research.target.reader.locatorUnavailable')}
          </p>
          <Button
            type="button"
            size="sm"
            variant="outline"
            data-testid="rdlens-target-reader-next-page"
            aria-label={t('research.target.reader.nextPage')}
            disabled={nextPage === null}
            onClick={() => {
              if (nextPage !== null) onSelectPage(nextPage)
            }}
          >
            {t('research.target.reader.nextPage')}
          </Button>
        </nav>
      ),
      pageIdx === null ? (
        <p
          key="page-unavailable"
          className="text-sm"
          role="status"
          style={{ color: 'var(--rdlens-warning)' }}
          data-testid="rdlens-target-reader-page-unavailable"
        >
          {t('research.target.reader.pageUnavailable')}
        </p>
      ) : (
        <PageImageFigure key="page-image" media={media} pageImage={pageImage} pageLabel={pageLabel} />
      ),
      ...pageChunks.map((chunk, index) =>
        renderChunk({
          chunk,
          ordinal: chunk.chunk_ordinal ?? index,
          locator: null,
          fallback: false,
        }),
      ),
      pageIdx !== null && pageChunks.length === 0 && (
        <p
          key="no-selectable-text"
          className="text-sm"
          role="status"
          style={{ color: 'var(--rdlens-ink-muted)' }}
          data-testid="rdlens-target-reader-no-selectable-text"
        >
          {t('research.target.reader.noSelectableText')}
        </p>
      ),
      renderSelectionAction(),
      selectionFailed && (
        <p
          key="selection-failed"
          className="text-sm"
          role="status"
          style={{ color: 'var(--rdlens-warning)' }}
          data-testid="rdlens-target-reader-selection-failed"
        >
          {t('research.selection.captureFailed')}
        </p>
      ),
    ])
  }

  // normalized-text：xlsx 每条 Sheet N 定位 + 全局 sheet 排序说明；其余无定位。
  const normalizedLocatorKey = readerLocatorKey(sourceType)
  const showSheetOrderNote = readerLocatorKind(sourceType) === 'sheet'
  return bodyRoot([
    ...notices,
    <p
      key="normalized-notice"
      className="text-xs"
      role="status"
      style={{ color: 'var(--rdlens-ink-muted)' }}
      data-testid="rdlens-target-reader-normalized-notice"
    >
      {t('research.target.reader.normalizedNotice')}
    </p>,
    showSheetOrderNote && (
      <p
        key="sheet-order-note"
        className="text-[11px]"
        style={{ color: 'var(--rdlens-ink-muted)' }}
        data-testid="rdlens-target-reader-sheet-order-note"
      >
        {t('research.target.reader.sheetOrderNote')}
      </p>
    ),
    ...readerNormalizedChunks(chunks).map(({ chunk, fallback }, index) =>
      renderChunk({
        chunk,
        ordinal: chunk.chunk_ordinal ?? index,
        locator:
          normalizedLocatorKey === null
            ? null
            : t(normalizedLocatorKey, { page: chunk.page_idx + 1 }),
        fallback,
      }),
    ),
    renderSelectionAction(),
    selectionFailed && (
      <p
        key="selection-failed"
        className="text-sm"
        role="status"
        style={{ color: 'var(--rdlens-warning)' }}
        data-testid="rdlens-target-reader-selection-failed"
      >
        {t('research.selection.captureFailed')}
      </p>
    ),
  ])
}

/** §2.4/§2.10-6：页图（加载/就绪/失败；失败按分类给文案 + 手动重试/下载）。 */
function PageImageFigure({
  media,
  pageImage,
  pageLabel,
}: {
  media: UseSourceMediaResult
  pageImage: UseSourceMediaResult['pageImage']
  pageLabel: string | null
}): ReactElement | null {
  const { t } = useTranslation()
  // §2.4：原文件下载仅在 `file_available === true` 且详情就绪时可用。
  const downloadAvailable =
    media.detailStatus === 'ready' && media.detail?.file_available === true
  const downloadDisabled = !downloadAvailable || media.file.status === 'loading'
  // idle = 尚未请求（detail 未就绪或版本护栏阻止）：不绘制空占位/假页图。
  if (pageImage.status === 'idle') return null
  const failed = pageImage.status === 'error'
  return (
    <section
      className="space-y-2 rounded-md border p-3"
      style={{ borderColor: 'var(--rdlens-line)', background: 'var(--rdlens-surface)' }}
      data-testid="rdlens-target-reader-page-image-section"
    >
      {pageImage.status === 'loading' && (
        <p
          className="text-sm"
          role="status"
          aria-busy="true"
          style={{ color: 'var(--rdlens-ink-muted)' }}
          data-testid="rdlens-target-reader-page-image-loading"
        >
          {t('research.target.reader.pageImageLoading')}
        </p>
      )}
      {pageImage.status === 'ready' && pageImage.url !== null && (
        // 页图是经 Bearer 获取的 blob: URL（不直连端点、token 不进 URL），
        // next/image 无法优化 blob 对象 URL。
        // eslint-disable-next-line @next/next/no-img-element
        <img
          data-testid="rdlens-target-reader-page-image"
          src={pageImage.url}
          alt={pageLabel ?? t('research.target.reader.locatorUnavailable')}
          className="max-h-[720px] w-full object-contain"
        />
      )}
      {failed && (
        <div className="space-y-2" data-testid="rdlens-target-reader-page-image-error">
          <p
            className="text-sm"
            role="status"
            style={{ color: 'var(--rdlens-warning)' }}
            data-testid="rdlens-target-reader-page-image-error-message"
          >
            {t(PAGE_IMAGE_FAILURE_KEYS[pageImage.failure ?? 'retryable'])}
          </p>
          {pageImageRetryable(pageImage.failure) && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              data-testid="rdlens-target-reader-retry"
              onClick={() => media.retryPageImage()}
            >
              {t('research.target.reader.retry')}
            </Button>
          )}
          {pageImage.failure !== 'forbidden' && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              data-testid="rdlens-target-reader-page-image-download"
              disabled={downloadDisabled}
              title={downloadAvailable ? undefined : t('research.target.reader.downloadUnavailable')}
              onClick={() => {
                if (downloadAvailable) media.openFile()
              }}
            >
              {t('research.target.reader.download')}
            </Button>
          )}
        </div>
      )}
    </section>
  )
}
