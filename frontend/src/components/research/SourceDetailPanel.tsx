'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
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
import {
  measureReaderAnchor,
  readerAnchorMatches,
  restoreScrollTop,
  shouldRestoreReaderAnchor,
  type ReaderChunkGeometry,
  type ReaderAnchorIdentity,
} from '@/lib/research/reading-anchor'
import { cn } from '@/lib/utils'

/**
 * 来源内容面板（UI-02，REQ-SRC-04/REQ-DATA-04，契约 §6）。
 *
 * 展示规范化 Markdown chunks（阅读顺序 + 页码标记 page_idx+1）；
 * `highlightPageIdx` 供 Citation 跳转定位（命中 chunk 高亮）。内容不可用
 * （404/同步失败）时展示降级态——Citation 原文由 CitationCard 保留。
 * `focusRequestId` 是 Citation 定位事件序号；数据渲染完成后，每个新序号
 * 都会把焦点移到真实来源标题（浏览器默认滚动行为确保标题进入视口）。
 */
export function SourceDetailPanel({
  sourceId,
  highlightPageIdx,
  focusRequestId,
}: {
  sourceId: string
  highlightPageIdx?: number | null
  focusRequestId?: number
}) {
  const { t } = useTranslation()
  const { projectId } = useResearchWorkspace()
  const { data, isLoading, isError } = useResearchSource(projectId, sourceId)
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
  const restoringRef = useRef(false)
  const [positionUnavailable, setPositionUnavailable] = useState(false)
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
          contentHash: data.content_hash ?? null,
        }
      : null
  readerIdentityRef.current = readerIdentity
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

  // 滚动空闲 1000ms 记录一次来源正文锚点（§5.7.2）；保存失败只保留本机 pending。
  const scheduleReaderAnchor = useCallback(() => {
    const identity = readerIdentityRef.current
    if (!sourceEditorEnabled || restoringRef.current || identity === null) return
    if (anchorTimerRef.current !== null) window.clearTimeout(anchorTimerRef.current)
    anchorTimerRef.current = window.setTimeout(() => {
      anchorTimerRef.current = null
      // 恢复期间/之后的新 anchor 尚未稳定：丢弃 pending 保存，避免覆盖恢复结果。
      if (restoringRef.current) return
      const parent = scrollParentRef.current
      const root = rootRef.current
      if (parent === null || root === null || identity.contentHash === null) return
      const parentRect = parent.getBoundingClientRect()
      const chunkNodes = Array.from(
        root.querySelectorAll<HTMLElement>('[data-chunk-id]'),
      )
      if (chunkNodes.length === 0) return
      let chunk: ReaderChunkGeometry | null = null
      for (const node of chunkNodes) {
        const rect = node.getBoundingClientRect()
        if (rect.top <= parentRect.top) {
          chunk = {
            chunkId: node.dataset.chunkId ?? null,
            chunkOrdinal: Number(node.dataset.chunkOrdinal ?? '0'),
            top: rect.top,
            pageIdx: node.dataset.chunkPage !== undefined ? Number(node.dataset.chunkPage) : null,
          }
        }
      }
      if (chunk === null) {
        const first = chunkNodes[0]
        const rect = first.getBoundingClientRect()
        chunk = {
          chunkId: first.dataset.chunkId ?? null,
          chunkOrdinal: Number(first.dataset.chunkOrdinal ?? '0'),
          top: rect.top,
          pageIdx: first.dataset.chunkPage !== undefined ? Number(first.dataset.chunkPage) : null,
        }
      }
      const anchor = measureReaderAnchor({
        identity,
        container: {
          containerTop: parentRect.top,
          scrollTop: parent.scrollTop,
          clientHeight: parent.clientHeight,
          scrollHeight: parent.scrollHeight,
        },
        chunk,
      })
      if (anchor !== null) sourceEditorRef.current.setReaderAnchor(anchor)
    }, 1000)
  }, [sourceEditorEnabled])

  // N9/F3：切来源/卸载前尽力写回位置（flush('position')，不阻塞 UI）。
  useEffect(() => {
    return () => {
      if (anchorTimerRef.current !== null) {
        window.clearTimeout(anchorTimerRef.current)
        anchorTimerRef.current = null
      }
      if (sourceEditorEnabled) sourceEditorRef.current.flush('position')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 仅在来源切换/卸载时 flush
  }, [sourceId])

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

  // 恢复来源正文锚点（§5.7.2）：版本/hash 不匹配/chunk 缺失 → position_unavailable。
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
      if (!readerAnchorMatches(readerIdentity, savedReaderAnchor)) {
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
  }, [sourceEditorEnabled, readerIdentity?.contentHash, savedReaderAnchor?.chunkId, savedReaderAnchor?.offsetPx, data, focusRequestId])

  if (isLoading) {
    return <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
  }
  if (isError || !data) {
    return <p className="text-sm text-destructive">{t('research.workbench.loadFailed')}</p>
  }

  return (
    <div ref={rootRef} className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <h2 ref={headingRef} tabIndex={-1} className="text-base font-semibold">
          {data.title || data.document_id}
        </h2>
        <div className="flex shrink-0 items-center gap-2">
          <Badge variant="secondary">{data.document_version}</Badge>
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
      {data.markdown_chunks.length === 0 && (
        <p className="text-sm text-muted-foreground">{t('research.sources.empty')}</p>
      )}
      {data.markdown_chunks.map((chunk, chunkIndex) => {
        const page = displayPage(chunk.page_idx)
        const highlighted = highlightPageIdx !== undefined && highlightPageIdx !== null
          && chunk.page_idx === highlightPageIdx
        return (
          <section
            key={chunk.chunk_id}
            data-testid={highlighted ? 'chunk-highlight' : undefined}
            data-chunk-id={chunk.chunk_id}
            data-chunk-ordinal={chunkIndex}
            data-chunk-page={chunk.page_idx}
            className={cn(
              'rounded-md border p-3',
              highlighted && 'border-primary ring-1 ring-primary',
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
    </div>
  )
}
