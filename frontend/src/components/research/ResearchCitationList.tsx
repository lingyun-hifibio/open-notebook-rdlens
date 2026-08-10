'use client'

import { useTranslation } from '@/lib/hooks/use-translation'
import type { ResearchCitation } from '@/lib/research/types'

/**
 * Citation 列表（UI-03，契约 §13.2）。页码按 `page_idx + 1` 展示
 * （page_idx 为 0-based，REQ-DATA-03）；claims 原文展示，不做跳转
 * （PDF 跳转/失效降级属 UI-02）。
 */
export function ResearchCitationList({ citations }: { citations: ResearchCitation[] }) {
  const { t } = useTranslation()
  if (citations.length === 0) {
    return null
  }
  return (
    <div className="mt-2 space-y-1.5 border-t pt-2" data-testid="research-citations">
      <p className="text-xs font-medium text-muted-foreground">{t('research.citations')}</p>
      <ol className="list-decimal space-y-1 pl-5 text-sm">
        {citations.map((citation) => (
          <li key={citation.citation_id} className="text-muted-foreground">
            <span className="text-foreground">{citation.claim}</span>
            <span className="ml-2 text-xs">
              {citation.doc_id} · {t('research.citationPage')}{' '}
              <span data-testid={`citation-page-${citation.citation_id}`}>
                {citation.page_idx + 1}
              </span>
              {citation.confidence ? ` · ${citation.confidence}` : ''}
            </span>
          </li>
        ))}
      </ol>
    </div>
  )
}
