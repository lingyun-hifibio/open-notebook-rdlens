'use client'

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { useTranslation } from '@/lib/hooks/use-translation'
import { useResearchWorkspace } from '@/lib/embedded/workspace-context'
import { useResearchSource } from '@/lib/hooks/use-research'
import { MarkdownRenderer } from '@/components/ui/markdown-renderer'
import { Button } from '@/components/ui/button'
import { displayPage } from './citation-utils'
import { useResearchScope } from '@/lib/research/scope'
import { useResearchSessionRuntimeOptional } from '@/lib/hooks/research-session-runtime'
import { useResearchEditor } from '@/lib/hooks/use-research-editor'
import { useResearchD1e } from '@/lib/hooks/use-research-c05'
import { extractResearchErrorCode, userErrorMessageKey } from '@/lib/research/errors'
import {
  measureReaderAnchor,
  readerAnchorMatches,
  restoreScrollTop,
  shouldRestoreReaderAnchor,
  type ReaderAnchorIdentity,
  type ReaderChunkGeometry,
  type ReaderChunkIdentity,
} from '@/lib/research/reading-anchor'
import {
  buildSelectionContext,
  domRangeForSelection,
  selectionDisplayRange,
  type SelectionChunkSource,
} from '@/lib/research/selection-range'
import type {
  WireSelectionContext,
  WireSelectionProjection,
} from '@/lib/research/session-contract'
import { cn } from '@/lib/utils'

/**
 * 选段「讨论」载荷（组合根据此生成 pending chip 并接线到当前会话 surface）。
 *
 * Issue #1013（D1-E-2）§2.11：chip 必须显示来源身份（来源名/版本/page/
 * 1-based 位置/quote 摘要），因此随选段一起上送展示元信息。
 */
export interface SourceSelectionDiscussPayload {
  readonly selection: WireSelectionContext
  readonly sourceId: string
  readonly sourceTitle: string | null
  readonly pageIdx: number | null
  readonly chunkOrdinal: number
}

/** 浮动「讨论选段」动作的定位（视口坐标；元素 fixed 定位）。 */
interface PendingSelectionAction {
  readonly payload: SourceSelectionDiscussPayload
  readonly left: number
  readonly top: number
}

/**
 * 来源内容面板（UI-02，REQ-SRC-04/REQ-DATA-04，契约 §6）。
 *
 * 展示规范化 Markdown chunks（阅读顺序 + 页码标记 page_idx+1）；
 * `highlightPageIdx` 供 Citation 跳转定位（命中 chunk 高亮）。
 *
 * Issue #1013（D1-E-2）：
 * - **选段**：chunk 正文上的文本选择 → 浮层「讨论选段」
 *   （`data-testid="source-selection-discuss"`）；只有 d1e 能力就绪
 *   （`useResearchD1e`，fail-closed）才出现。选段偏移/quote/hash 见
 *   `selection-range.ts`；响应缺逐 chunk `content_hash` 时不产生选段。
 * - **往返位置修复**：reader_anchor 改用响应逐 `chunk_ordinal`/`content_hash`
 *   （不再用来源级 `content_hash` 与数组下标）；恢复按 `chunk_id →
 *   chunk_ordinal` 匹配。
 * - **返回原回答**：`returnTargetAvailable` 时头部显示按钮
 *   （`data-testid="source-return-to-answer"`）。
 * - **选段高亮**：`highlightSelection` + 递增请求序号把选段滚回视野；
 *   位置失效 → `position_unavailable` 提示（不伪造高亮）。
 * - **撤权状态**：410 `source_access_restricted` / 422 `source_ref_mismatch`
 *   / 404 分开展示（可解释错误，§2.9）。
 */
export function SourceDetailPanel({
  sourceId,
  highlightPageIdx,
  focusRequestId,
  highlightSelection,
  highlightSelectionRequestId,
  onDiscussSelection,
  returnTargetAvailable,
  returnUnavailable,
  onReturnToAnswer,
}: {
  sourceId: string
  highlightPageIdx?: number | null
  focusRequestId?: number
  /** 从 user turn 选段 chip 回跳的选段投影（含 visibility/reason_code）。 */
  highlightSelection?: WireSelectionProjection | null
  /** 选段回跳请求序号（同一选段重复点击也要重新高亮/滚动）。 */
  highlightSelectionRequestId?: number
  /** d1e 能力就绪时讨论选段（缺失 = 不提供选段 UI）。 */
  onDiscussSelection?: (payload: SourceSelectionDiscussPayload) => void
  /** 本次来源由 citation 打开且能推导出目标 durable message。 */
  returnTargetAvailable?: boolean
  /** 「返回原回答」目标无法定位（position_unavailable 文案，不跳最新）。 */
  returnUnavailable?: boolean
  /** 「返回原回答」：切回会话 surface 并滚动到目标 message。 */
  onReturnToAnswer?: () => void
}) {
  const { t } = useTranslation()
  const { projectId } = useResearchWorkspace()
  const { data, isLoading, isError, error } = useResearchSource(projectId, sourceId)
  // Issue #1013 §2.11：能力键 fail-closed（缺失/畸形/false → 选段 UI 全部不可用）。
  const d1e = useResearchD1e(projectId)
  const selectionEnabled = d1e.ready && onDiscussSelection !== undefined
  // PR5/R1-H4：「只问此来源」——会话级临时限定（D-04）。sessionId 未知时
  // 入待绑态（bindSession 在 Chat 首响应时绑定）。
  const { setSingle, mode, singlePin, clearSingle } = useResearchScope()
  const pinnedHere = mode === 'single' && singlePin?.sourceId === sourceId
  const headingRef = useRef<HTMLHeadingElement>(null)
  const handledFocusRequestIdRef = useRef<number | null>(null)
  // PR-4：来源正文锚点（DESIGN §5.7.2）——只在 active('source') 且 sourceId
  // 精确匹配的会话 editor 上读写；归属不确定时绝不写任何会话（Lead E3）。
  const rootRef = useRef<HTMLDivElement | null>(null)
  const scrollParentRef = useRef<HTMLElement | null>(null)
  const anchorTimerRef = useRef<number | null>(null)
  const measureFrameRef = useRef<number | null>(null)
  const restoringRef = useRef(false)
  const [positionUnavailable, setPositionUnavailable] = useState(false)
  // Issue #1013：选段采集/回跳的本地状态（不写任何会话/不伪造位置）。
  const [pendingAction, setPendingAction] = useState<PendingSelectionAction | null>(null)
  const [selectionNotice, setSelectionNotice] = useState<string | null>(null)
  const [selectionPositionUnavailable, setSelectionPositionUnavailable] = useState(false)
  const [highlightChunkId, setHighlightChunkId] = useState<string | null>(null)
  const handledSelectionRequestIdRef = useRef<number | null>(null)
  const sessionRuntime = useResearchSessionRuntimeOptional()
  const activeSourceRef = sessionRuntime?.active('source') ?? null
  const sourceEditorEnabled =
    sessionRuntime !== null && activeSourceRef !== null && activeSourceRef.sourceId === sourceId
  const sourceEditor = useResearchEditor({
    kind: 'source',
    sessionId: activeSourceRef?.sessionId ?? '',
    sourceId,
    enabled: sourceEditorEnabled,
  })
  // 滚动回调需稳定：用 ref 读取最新 identity/editor，避免每次渲染重新安装监听
  // 或在安装时意外排定保存（§5.7.2 恢复期间不写回）。
  const readerIdentityRef = useRef<ReaderAnchorIdentity | null>(null)
  const sourceEditorRef = useRef(sourceEditor)
  sourceEditorRef.current = sourceEditor
  const readerIdentity: ReaderAnchorIdentity | null =
    data !== undefined && data.source_id !== null
      ? {
          sourceId: data.source_id,
          documentId: data.document_id,
          documentVersion: data.document_version,
        }
      : null
  // issue #1013：选段/锚点都要求响应携带逐 chunk 身份（ordinal/hash）。
  const chunkSources = useMemo<SelectionChunkSource[]>(
    () =>
      (data?.markdown_chunks ?? []).map((chunk) => ({
        chunkId: chunk.chunk_id,
        chunkOrdinal: chunk.chunk_ordinal ?? -1,
        contentHash: chunk.content_hash ?? null,
        pageIdx: chunk.page_idx ?? null,
        markdown: chunk.markdown,
      })),
    [data?.markdown_chunks],
  )
  const chunkIdentities = useMemo<ReaderChunkIdentity[]>(
    () =>
      chunkSources.map((chunk) => ({
        chunkId: chunk.chunkId,
        chunkOrdinal: chunk.chunkOrdinal,
        contentHash: chunk.contentHash,
      })),
    [chunkSources],
  )
  // 切来源的瞬间 query 数据会短暂为空：保留上一份身份供 layout cleanup 测量旧来源 DOM；
  // 每次测量都校验身份归属，避免给新来源写入旧身份锚点。
  if (readerIdentity !== null) readerIdentityRef.current = readerIdentity
  const savedReaderAnchor = sourceEditorEnabled ? sourceEditor.snapshot?.readerAnchor ?? null : null
  // 服务端净化坏锚点后只会置 positionUnavailable；仍要可见说明（§5.7.2/§7.2）。
  const editorPositionUnavailable =
    sourceEditorEnabled && sourceEditor.snapshot?.positionUnavailable === true

  useEffect(() => {
    if (
      focusRequestId === undefined
      || handledFocusRequestIdRef.current === focusRequestId
      || !data
    ) {
      return
    }

    const heading = headingRef.current
    if (!heading) {
      return
    }

    heading.focus()
    handledFocusRequestIdRef.current = focusRequestId
  }, [data, focusRequestId])

  // 按当前几何测量一次 reader anchor（§5.7.2；定时器/离开前 flush 复用）。
  const measureReaderAnchorNow = useCallback((expectedSourceId: string = sourceId): void => {
    const identity = readerIdentityRef.current
    if (!sourceEditorEnabled || restoringRef.current || identity === null) return
    if (identity.sourceId !== expectedSourceId) return
    const parent = scrollParentRef.current
    const root = rootRef.current
    if (parent === null || root === null) return
    const parentRect = parent.getBoundingClientRect()
    const chunkNodes = Array.from(
      root.querySelectorAll<HTMLElement>('[data-chunk-id]'),
    )
    if (chunkNodes.length === 0) return
    const chunkAt = (node: HTMLElement): {
      geometry: ReaderChunkGeometry
      markdown: string
    } | null => {
      const chunkId = node.dataset.chunkId ?? null
      const source = chunkId === null
        ? undefined
        : chunkSources.find((candidate) => candidate.chunkId === chunkId)
      if (source === undefined) return null
      return {
        geometry: {
          chunkId: source.chunkId,
          chunkOrdinal: source.chunkOrdinal,
          contentHash: source.contentHash,
          top: node.getBoundingClientRect().top,
          pageIdx: source.pageIdx,
        },
        markdown: source.markdown,
      }
    }
    let target: ReturnType<typeof chunkAt> = null
    for (const node of chunkNodes) {
      const rect = node.getBoundingClientRect()
      if (rect.top <= parentRect.top) {
        target = chunkAt(node)
      }
    }
    if (target === null) {
      target = chunkAt(chunkNodes[0])
    }
    if (target === null) return
    const anchor = measureReaderAnchor({
      identity,
      container: {
        containerTop: parentRect.top,
        scrollTop: parent.scrollTop,
        clientHeight: parent.clientHeight,
        scrollHeight: parent.scrollHeight,
      },
      chunk: target.geometry,
    })
    if (anchor !== null) sourceEditorRef.current.setReaderAnchor(anchor)
  }, [chunkSources, sourceEditorEnabled, sourceId])

  // 滚动空闲 1000ms 记录一次来源正文锚点（§5.7.2）；保存失败只保留本机 pending。
  const scheduleReaderAnchor = useCallback(() => {
    const identity = readerIdentityRef.current
    if (!sourceEditorEnabled || restoringRef.current || identity === null) return
    // F3：下一帧先测量一次（16ms 节流），保证 <1000ms 切走时最新位置已在 editor 内；
    // 1000ms 空闲再合并保存，避免每次滚动都触发网络写。
    if (measureFrameRef.current !== null) window.clearTimeout(measureFrameRef.current)
    measureFrameRef.current = window.setTimeout(() => {
      measureFrameRef.current = null
      if (restoringRef.current) return
      measureReaderAnchorNow()
    }, 16)
    if (anchorTimerRef.current !== null) window.clearTimeout(anchorTimerRef.current)
    anchorTimerRef.current = window.setTimeout(() => {
      anchorTimerRef.current = null
      // 恢复期间/之后的新 anchor 尚未稳定：丢弃 pending 保存，避免覆盖恢复结果。
      if (restoringRef.current) return
      sourceEditorRef.current.flush('position')
    }, 1000)
  }, [measureReaderAnchorNow, sourceEditorEnabled])

  // N9/F3：切来源/卸载前尽力写回位置（flush('position')，不阻塞 UI）。
  // 用 layout effect cleanup：它先于 useResearchEditor 的 passive cleanup 执行，
  // 保证 flush 时 controller 尚未释放；<1000ms 的滚动位置在离开前同步测量一次。
  useLayoutEffect(() => {
    return () => {
      const pendingTimer = anchorTimerRef.current
      const pendingFrame = measureFrameRef.current
      const hadPending = pendingTimer !== null || pendingFrame !== null
      if (pendingTimer !== null) {
        window.clearTimeout(pendingTimer)
        anchorTimerRef.current = null
      }
      if (pendingFrame !== null) {
        window.clearTimeout(pendingFrame)
        measureFrameRef.current = null
      }
      if (!sourceEditorEnabled) return
      // 尽力测量（DOM 已切换时可能拿不到 chunk，改为依赖 rAF 内已写入的位置）。
      if (hadPending) measureReaderAnchorNow(sourceId)
      sourceEditorRef.current.flush('position')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 仅在来源切换/启用状态变化/卸载时结算
  }, [sourceId, sourceEditorEnabled])

  // 找到可滚动祖先（来源面板自身不是滚动容器；不改 Workbench/page）。
  useEffect(() => {
    const root = rootRef.current
    if (root === null) {
      scrollParentRef.current = null
      return
    }
    const parent = root.closest<HTMLElement>('.overflow-y-auto')
    scrollParentRef.current = parent
    if (parent === null) return
    parent.addEventListener('scroll', scheduleReaderAnchor, { passive: true })
    return () => {
      parent.removeEventListener('scroll', scheduleReaderAnchor)
      if (anchorTimerRef.current !== null) window.clearTimeout(anchorTimerRef.current)
    }
  }, [scheduleReaderAnchor, data])

  // 恢复来源正文锚点（§5.7.2）：版本/逐 chunk hash 不匹配/chunk 缺失 → position_unavailable。
  useEffect(() => {
    if (!sourceEditorEnabled || readerIdentity === null) return
    // §8.3：Citation 定位优先于旧阅读位置；已净化/已失效锚点不恢复。
    if (
      !shouldRestoreReaderAnchor({
        savedAnchor: savedReaderAnchor,
        citationFocusRequestId: focusRequestId,
        positionUnavailable: editorPositionUnavailable,
      })
    ) {
      return
    }
    if (anchorTimerRef.current !== null) {
      window.clearTimeout(anchorTimerRef.current)
      anchorTimerRef.current = null
    }
    const parent = scrollParentRef.current ?? rootRef.current?.closest<HTMLElement>('.overflow-y-auto') ?? null
    const root = rootRef.current
    if (parent === null || root === null) return
    restoringRef.current = true
    const restore = (): void => {
      const parentRect = parent.getBoundingClientRect()
      const container = {
        containerTop: parentRect.top,
        scrollTop: parent.scrollTop,
        clientHeight: parent.clientHeight,
        scrollHeight: parent.scrollHeight,
      }
      if (!readerAnchorMatches(readerIdentity, savedReaderAnchor, chunkIdentities)) {
        setPositionUnavailable(true)
        return
      }
      const nodes = Array.from(root.querySelectorAll<HTMLElement>('[data-chunk-id]'))
      const target =
        nodes.find(node => savedReaderAnchor.chunkId !== null && node.dataset.chunkId === savedReaderAnchor.chunkId)
        ?? nodes.find(node => Number(node.dataset.chunkOrdinal ?? '-1') === savedReaderAnchor.chunkOrdinal)
        ?? null
      const targetRect = target?.getBoundingClientRect() ?? null
      const result = restoreScrollTop({
        container,
        savedOffsetPx: savedReaderAnchor.offsetPx,
        currentTargetTop: targetRect !== null ? targetRect.top : null,
        targetHeightPx: targetRect !== null ? targetRect.height : undefined,
      })
      if (result.ok) {
        parent.scrollTop = result.scrollTop
        setPositionUnavailable(false)
      } else {
        setPositionUnavailable(true)
      }
    }
    restore()
    const timer = window.setTimeout(() => {
      restoringRef.current = false
    }, 0)
    return () => window.clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 仅在身份/锚点变化时恢复
  }, [
    sourceEditorEnabled,
    readerIdentity?.documentVersion,
    savedReaderAnchor?.chunkId,
    savedReaderAnchor?.offsetPx,
    data,
    focusRequestId,
    chunkIdentities,
  ])

  // Issue #1013 §2.10：选段回跳高亮（user turn chip / 本面板刚讨论的选段）。
  useEffect(() => {
    if (highlightSelection === undefined || highlightSelection === null) {
      setHighlightChunkId(null)
      setSelectionPositionUnavailable(false)
      return
    }
    if (
      highlightSelectionRequestId !== undefined
      && handledSelectionRequestIdRef.current === highlightSelectionRequestId
    ) {
      return
    }
    if (highlightSelection.visibility === 'restricted') {
      // 撤权摘录不得展示/高亮（§2.7 读投影）；不伪造高亮。
      setHighlightChunkId(null)
      setSelectionPositionUnavailable(false)
      return
    }
    if (highlightSelection.visibility === 'position_unavailable') {
      setHighlightChunkId(null)
      setSelectionPositionUnavailable(true)
      return
    }
    const root = rootRef.current
    if (root === null) return
    const chunk = chunkSources.find(
      candidate => candidate.chunkId === highlightSelection.chunkId,
    ) ?? chunkSources.find(
      candidate => candidate.chunkOrdinal === highlightSelection.chunkOrdinal,
    )
    if (
      chunk === undefined
      || chunk.contentHash === null
      || chunk.contentHash !== highlightSelection.contentHash
    ) {
      setHighlightChunkId(null)
      setSelectionPositionUnavailable(true)
      return
    }
    const node = Array.from(root.querySelectorAll<HTMLElement>('[data-chunk-id]')).find(
      candidate => candidate.dataset.chunkId === chunk.chunkId,
    ) ?? Array.from(root.querySelectorAll<HTMLElement>('[data-chunk-id]')).find(
      candidate => Number(candidate.dataset.chunkOrdinal ?? '-1') === chunk.chunkOrdinal,
    ) ?? null
    if (node === null) {
      setSelectionPositionUnavailable(true)
      return
    }
    handledSelectionRequestIdRef.current = highlightSelectionRequestId ?? null
    setHighlightChunkId(chunk.chunkId)
    setSelectionPositionUnavailable(false)
    // 高亮：原生 Selection 是浏览器里可见的高亮（不改 MarkdownRenderer DOM）。
    const range = domRangeForSelection({ chunkRoot: node, selection: highlightSelection })
    if (range !== null) {
      try {
        const selection = window.getSelection()
        selection?.removeAllRanges()
        selection?.addRange(range)
      } catch {
        // jsdom/受限宿主不支持 Selection 时只保留 chunk 级 ring 高亮。
      }
    }
    const scrollTarget: { scrollIntoView?: (options?: ScrollIntoViewOptions) => void } = node
    scrollTarget.scrollIntoView?.({ block: 'center' })
  }, [chunkSources, highlightSelection, highlightSelectionRequestId, data])

  // Issue #1013 §2.11：文本选择 → 浮层「讨论选段」。
  useEffect(() => {
    if (!selectionEnabled) {
      setPendingAction(null)
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
      const container = range.commonAncestorContainer
      const element = container.nodeType === Node.ELEMENT_NODE
        ? (container as HTMLElement)
        : container.parentElement
      const chunkNode = element?.closest<HTMLElement>('[data-chunk-id]') ?? null
      if (chunkNode === null || rootRef.current === null || !rootRef.current.contains(chunkNode)) {
        clear()
        return
      }
      const chunkId = chunkNode.dataset.chunkId ?? ''
      const chunk = chunkSources.find(candidate => candidate.chunkId === chunkId)
      if (chunk === undefined) {
        clear()
        return
      }
      const source = readerIdentityRef.current
      if (source === null) {
        clear()
        return
      }
      const result = buildSelectionContext({
        range,
        chunkRoot: chunkNode,
        chunk,
        source,
      })
      if (!result.ok) {
        setPendingAction(null)
        setSelectionNotice(result.reason)
        return
      }
      // jsdom/受限宿主可能不实现 Range 几何：退化为锚点元素位置，仍可讨论选段。
      const chunkRect = typeof range.getBoundingClientRect === 'function'
        ? range.getBoundingClientRect()
        : chunkNode.getBoundingClientRect()
      setSelectionNotice(null)
      setPendingAction({
        payload: {
          selection: result.selection,
          sourceId,
          sourceTitle: data?.title ?? null,
          pageIdx: chunk.pageIdx,
          chunkOrdinal: chunk.chunkOrdinal,
        },
        left: chunkRect.left + chunkRect.width / 2,
        top: chunkRect.top,
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
  }, [chunkSources, data?.title, selectionEnabled, sourceId])

  const discussPendingSelection = (): void => {
    if (pendingAction === null || onDiscussSelection === undefined) return
    onDiscussSelection(pendingAction.payload)
    setPendingAction(null)
    setSelectionNotice(null)
    try {
      window.getSelection()?.removeAllRanges()
    } catch {
      // 忽略 Selection 不可用的宿主。
    }
  }

  if (isLoading) {
    return <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
  }
  if (isError || !data) {
    // Issue #1013 §2.9：撤权/版本不一致必须是可解释错误（不被通用失败吞掉）。
    const code = extractResearchErrorCode(error)
    const reasonKey = code === null ? null : userErrorMessageKey(code)
    return (
      <div className="space-y-2" data-testid="source-detail-error">
        <p className="text-sm text-destructive">{t('research.workbench.loadFailed')}</p>
        {reasonKey !== null && reasonKey !== 'research.errors.generic' && (
          <p className="text-sm text-amber-700" role="status" data-testid={`source-detail-error-${code}`}>
            {t(reasonKey)}
          </p>
        )}
        {code === 'source_access_restricted' && (
          <p className="text-xs text-muted-foreground" data-testid="source-access-restricted">
            {t('research.errors.sourceAccessRestricted')}
          </p>
        )}
      </div>
    )
  }

  const returnAvailable = returnTargetAvailable === true && onReturnToAnswer !== undefined
  return (
    <div ref={rootRef} className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <h2 ref={headingRef} tabIndex={-1} className="text-base font-semibold">
          {data.title || data.document_id}
        </h2>
        <div className="flex shrink-0 items-center gap-2">
          <Badge variant="secondary">{data.document_version}</Badge>
          {returnAvailable && (
            <Button
              size="sm"
              variant="outline"
              data-testid="source-return-to-answer"
              onClick={onReturnToAnswer}
            >
              {t('research.source.returnToAnswer')}
            </Button>
          )}
          {/* PR5/R1-H4：「只问此来源」——会话级临时限定（D-04）；
              sessionId 未知时入待绑态（Chat 首响应 bindSession 绑定） */}
          <Button
            size="sm"
            variant={pinnedHere ? 'secondary' : 'outline'}
            data-testid="source-ask-only"
            onClick={() => (pinnedHere ? clearSingle() : setSingle(sourceId, null))}
          >
            {pinnedHere ? t('research.sources.stopAskOnly') : t('research.sources.askOnlyThis')}
          </Button>
        </div>
      </div>
      {(positionUnavailable || editorPositionUnavailable) && (
        <p className="text-sm text-amber-700" role="status" data-testid="source-anchor-unavailable">
          {t('research.editor.positionUnavailable')}
        </p>
      )}
      {selectionPositionUnavailable && (
        <p className="text-sm text-amber-700" role="status" data-testid="source-selection-unavailable">
          {t('research.selection.positionUnavailable')}
        </p>
      )}
      {returnUnavailable === true && (
        <p className="text-sm text-amber-700" role="status" data-testid="source-return-unavailable">
          {t('research.source.returnUnavailable')}
        </p>
      )}
      {selectionNotice !== null && (
        <p className="text-sm text-amber-700" role="status" data-testid="source-selection-capture-failed">
          {t('research.selection.captureFailed')}
        </p>
      )}
      {data.markdown_chunks.length === 0 && (
        <p className="text-sm text-muted-foreground">{t('research.sources.empty')}</p>
      )}
      {data.markdown_chunks.map((chunk, chunkIndex) => {
        const page = displayPage(chunk.page_idx)
        const highlighted = highlightPageIdx !== undefined && highlightPageIdx !== null
          && chunk.page_idx === highlightPageIdx
        // Issue #1013：服务端逐 chunk ordinal 优先；缺失（旧响应/测试替身）
        // 才回落到数组下标——选段/锚点路径会因缺 content_hash 而拒绝，不猜测。
        const chunkOrdinal = chunk.chunk_ordinal ?? chunkIndex
        const selectionHighlighted = highlightChunkId !== null && chunk.chunk_id === highlightChunkId
        return (
          <section
            key={chunk.chunk_id}
            data-testid={highlighted ? 'chunk-highlight' : selectionHighlighted ? 'selection-highlight' : undefined}
            data-chunk-id={chunk.chunk_id}
            data-chunk-ordinal={chunkOrdinal}
            data-chunk-page={chunk.page_idx}
            className={cn(
              'rounded-md border p-3',
              (highlighted || selectionHighlighted) && 'border-primary ring-1 ring-primary',
            )}
          >
            {page !== null && (
              <p className="mb-2 text-xs font-medium text-muted-foreground">
                {t('research.sources.chunkPage', { page })}
              </p>
            )}
            <MarkdownRenderer>{chunk.markdown}</MarkdownRenderer>
          </section>
        )
      })}
      {selectionEnabled && pendingAction !== null && (
        <div
          className="fixed z-50 -translate-x-1/2 -translate-y-full pb-1"
          style={{ left: pendingAction.left, top: pendingAction.top }}
        >
          <Button
            size="sm"
            data-testid="source-selection-discuss"
            title={selectionActionTitle(pendingAction, t)}
            onClick={discussPendingSelection}
          >
            {t('research.selection.discuss')}
          </Button>
        </div>
      )}
    </div>
  )
}

/** 浮层按钮 title：显示来源身份/版本/page/1-based 位置/quote 摘要（§2.11）。 */
function selectionActionTitle(
  action: PendingSelectionAction,
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  const { selection, pageIdx } = action.payload
  const range = selectionDisplayRange(selection)
  const summary = selection.quote.length > 40
    ? `${selection.quote.slice(0, 40)}…`
    : selection.quote
  return t('research.selection.summary', {
    page: pageIdx === null ? '-' : pageIdx + 1,
    start: range.start,
    end: range.end,
    quote: summary,
  })
}
