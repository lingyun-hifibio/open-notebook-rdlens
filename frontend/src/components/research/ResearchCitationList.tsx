'use client'

import { useTranslation } from '@/lib/hooks/use-translation'
import type { ResearchCitationDisplayItem } from '@/lib/research/types'

/**
 * Citation 列表（UI-03，契约 §13.2；Issue #182 扩展）。页码按
 * `page_idx + 1` 展示（page_idx 为 0-based，REQ-DATA-03）；claims 原文展示。
 *
 * Issue #182：prop 放宽为展示最小结构（兼容 SSE 9 字段与持久化 17 字段
 * 快照，page_idx 可空则不显示页码）；传入 `onCitationClick` 时带页码的
 * citation 渲染为点击入口（Source Chat 面板联动高亮），不传保持纯文本
 * （全局 Chat 行为不变）。
 */
export function ResearchCitationList({
  citations,
  onCitationClick,
}: {
  citations: ResearchCitationDisplayItem[]
  onCitationClick?: (citation: ResearchCitationDisplayItem) => void
}) {
  const { t } = useTranslation()
  if (citations.length === 0) {
    return null
  }
  return (
    <div className="mt-2 space-y-1.5 border-t pt-2" data-testid="research-citations">
      <p className="text-xs font-medium text-muted-foreground">{t('research.citations')}</p>
      <ol className="list-decimal space-y-1 pl-5 text-sm">
        {citations.map((citation) => {
          const hasPage = typeof citation.page_idx === 'number'
          const clickable = Boolean(onCitationClick) && hasPage
          const content = (
            <>
              <span className="text-foreground">{citation.claim}</span>
              <span className="ml-2 text-xs">
                {citation.doc_id}
                {hasPage && (
                  <>
                    {' · '}
                    {t('research.citationPage')}{' '}
                    <span data-testid={`citation-page-${citation.citation_id}`}>
                      {(citation.page_idx as number) + 1}
                    </span>
                  </>
                )}
                {citation.confidence ? ` · ${String(citation.confidence)}` : ''}
              </span>
            </>
          )
          return (
            <li key={citation.citation_id} className="text-muted-foreground">
              {clickable ? (
                <button
                  type="button"
                  className="text-left underline-offset-2 hover:underline"
                  data-testid={`research-citation-click-${citation.citation_id}`}
                  onClick={() => onCitationClick?.(citation)}
                >
                  {content}
                </button>
              ) : (
                content
              )}
            </li>
          )
        })}
      </ol>
    </div>
  )
}
