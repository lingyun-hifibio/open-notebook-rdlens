'use client'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/lib/hooks/use-translation'
import { canJumpToCitation, displayPage, type JumpDenyReason } from './citation-utils'
import type { ResearchCitation, ResearchChunk, ResearchSource } from '@/lib/types/research'

/**
 * Citation 卡片（UI-02，REQ-DATA-03/04，设计 §5.3）。
 *
 * - 页码只展示 `page_idx + 1`（0-based 仅持久化，绝不展示/持久化
 *   page_number）；
 * - 原文（original_text）始终展示；旧文件/版本失效时禁用跳转并给出
 *   降级原因（原文保留，REQ-DATA-04）；
 * - 跳转回调由工作台提供：解析来源并定位到目标页 chunk。
 */

interface CitationCardProps {
  citation: ResearchCitation
  /** 该引用所属来源（按 document_id 解析）；缺失 = 文件不可用 */
  source?: ResearchSource | null
  /** 来源内容 chunks（已加载时用于页存在性检查）；undefined = 未验证 */
  chunks?: ResearchChunk[]
  onJump?: (citation: ResearchCitation) => void
}

const DEGRADED_REASON_KEYS: Record<JumpDenyReason, string | null> = {
  source_unavailable: 'research.citation.degradedSource',
  version_mismatch: 'research.citation.degradedVersion',
  no_page: null, // 无页码：不展示降级文案，仅无跳转入口
  page_missing: 'research.citation.degradedPage',
}

export function CitationCard({
  citation,
  source,
  chunks,
  onJump,
}: CitationCardProps) {
  const { t } = useTranslation()
  const page = displayPage(citation.page_idx)
  const evaluation = canJumpToCitation(citation, source, chunks)
  const degradedKey = evaluation.canJump
    ? null
    : DEGRADED_REASON_KEYS[evaluation.reason as JumpDenyReason]
  const displayName = citation.doc_display_name || citation.short_name || citation.doc_id

  return (
    <div className="rounded-md border p-3" data-testid="citation-card">
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-sm font-medium">{displayName}</span>
        {page !== null && (
          <Badge variant="secondary" className="shrink-0">
            {t('research.citation.page', { page })}
          </Badge>
        )}
      </div>
      <p className="mt-1 text-sm">{citation.claim}</p>
      <blockquote className="mt-2 border-l-2 pl-2 text-xs text-muted-foreground">
        {citation.original_text}
      </blockquote>
      <div className="mt-2 flex items-center gap-3">
        {evaluation.canJump && onJump !== undefined && (
          <Button size="sm" variant="outline" onClick={() => onJump(citation)}>
            {t('research.citation.jump')}
          </Button>
        )}
        {degradedKey !== null && (
          <span className="text-xs text-muted-foreground">
            {t(degradedKey, { reason: evaluation.reason })}
          </span>
        )}
      </div>
    </div>
  )
}
