'use client'

import { useEffect, useRef } from 'react'
import { Badge } from '@/components/ui/badge'
import { useTranslation } from '@/lib/hooks/use-translation'
import { useResearchWorkspace } from '@/lib/embedded/workspace-context'
import { useResearchSource } from '@/lib/hooks/use-research'
import { MarkdownRenderer } from '@/components/ui/markdown-renderer'
import { displayPage } from './citation-utils'
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
  const headingRef = useRef<HTMLHeadingElement>(null)
  const handledFocusRequestIdRef = useRef<number | null>(null)

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

  if (isLoading) {
    return <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
  }
  if (isError || !data) {
    return <p className="text-sm text-destructive">{t('research.workbench.loadFailed')}</p>
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <h2 ref={headingRef} tabIndex={-1} className="text-base font-semibold">
          {data.title || data.document_id}
        </h2>
        <Badge variant="secondary">{data.document_version}</Badge>
      </div>
      {data.markdown_chunks.length === 0 && (
        <p className="text-sm text-muted-foreground">{t('research.sources.empty')}</p>
      )}
      {data.markdown_chunks.map((chunk) => {
        const page = displayPage(chunk.page_idx)
        const highlighted = highlightPageIdx !== undefined && highlightPageIdx !== null
          && chunk.page_idx === highlightPageIdx
        return (
          <section
            key={chunk.chunk_id}
            data-testid={highlighted ? 'chunk-highlight' : undefined}
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
