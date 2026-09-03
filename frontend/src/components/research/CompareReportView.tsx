'use client'

import { useState } from 'react'
import { useTranslation } from '@/lib/hooks/use-translation'
import { Button } from '@/components/ui/button'
import { MarkdownRenderer } from '@/components/ui/markdown-renderer'
import { ResearchCitationList } from './ResearchCitationList'
import { toDisplayItem } from './CoverageJobDetails'
import { useCompareReport } from '@/lib/hooks/use-compare-report'
import type { ResearchCitationDisplayItem, ResearchJob } from '@/lib/research/types'

/**
 * #307：deep_compare Job 完成后的报告查看入口。
 *
 * completed + result_ref 才渲染「查看报告」按钮；展开后一次性读取
 * GET /jobs/{id}/report（#307 后端 compare 分支），渲染 markdown
 * 正文 + 规范化 Citation（409 report_unavailable 以错误呈现，不重试）。
 */
export function CompareReportView({
  job,
  onCitationJump,
}: {
  job: ResearchJob
  onCitationJump?: (citation: ResearchCitationDisplayItem) => void
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const enabled = open && job.status === 'completed' && !!job.result_ref
  const { report, error, loading } = useCompareReport(
    job.project_id,
    job.job_id,
    enabled,
  )

  if (job.status !== 'completed' || !job.result_ref) {
    return null
  }

  return (
    <div className="space-y-2 border-t pt-2" data-testid="compare-report">
      <Button
        variant="outline"
        size="sm"
        data-testid={`compare-report-toggle-${job.job_id}`}
        onClick={() => setOpen(!open)}
      >
        {open ? t('research.compareReportHide') : t('research.compareReportView')}
      </Button>
      {open && loading && (
        <p className="text-xs text-muted-foreground">{t('research.compareReportLoading')}</p>
      )}
      {open && error && (
        <p className="text-xs text-destructive">{t('research.compareReportError')}</p>
      )}
      {open && report && (
        <div className="space-y-2" data-testid="compare-report-content">
          <MarkdownRenderer>{report.report.markdown}</MarkdownRenderer>
          <ResearchCitationList
            citations={report.citations.map(toDisplayItem)}
            onCitationClick={onCitationJump}
          />
        </div>
      )}
    </div>
  )
}
