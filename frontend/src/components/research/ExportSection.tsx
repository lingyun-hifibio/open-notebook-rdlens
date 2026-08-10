'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/lib/hooks/use-translation'
import { useToast } from '@/lib/hooks/use-toast'
import { useResearchWorkspace } from '@/lib/embedded/workspace-context'
import { useCreateResearchExport } from '@/lib/hooks/use-research'
import { downloadExport } from '@/lib/research/api'

/**
 * 研究产物导出（UI-02，REQ-SCOPE-04/REQ-API-01，契约 §7.4，设计 §4.4）。
 *
 * Owner/Admin 均可导出（均审计，后端承担）；创建导出任务后经 Gateway
 * 鉴权下载（download_url 来自服务端，不拼内部地址）；导出内容不含
 * Research Token / Provider Secret（REQ-MOD-02，后端保证）。
 */
export function ExportSection() {
  const { t } = useTranslation()
  const { toast } = useToast()
  const { projectId } = useResearchWorkspace()
  const createExportMutation = useCreateResearchExport(projectId)
  const [downloading, setDownloading] = useState(false)

  const handleExport = async () => {
    try {
      const exportResult = await createExportMutation.mutateAsync()
      setDownloading(true)
      toast({ title: t('research.workbench.exportDownloading') })
      try {
        const blob = await downloadExport(projectId, exportResult.download_url)
        const objectUrl = URL.createObjectURL(blob)
        const anchor = document.createElement('a')
        anchor.href = objectUrl
        anchor.download = `research-export-${exportResult.export_id}.json`
        anchor.click()
        URL.revokeObjectURL(objectUrl)
        toast({ title: t('research.workbench.exportCreated') })
      } finally {
        setDownloading(false)
      }
    } catch {
      toast({ title: t('research.workbench.exportFailed'), variant: 'destructive' })
    }
  }

  return (
    <Button
      size="sm"
      variant="outline"
      onClick={handleExport}
      disabled={createExportMutation.isPending || downloading}
    >
      {t('research.workbench.exportAll')}
    </Button>
  )
}
