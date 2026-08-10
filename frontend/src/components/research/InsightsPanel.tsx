'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useTranslation } from '@/lib/hooks/use-translation'
import { useResearchWorkspace } from '@/lib/embedded/workspace-context'
import { useCreateResearchInsight, useResearchInsights } from '@/lib/hooks/use-research'
import { AdminReadOnlyBanner } from './AdminReadOnlyBanner'

/**
 * Insights 工作台（UI-02，REQ-SCOPE-04/REQ-API-01，契约 §7.2）。
 *
 * Owner：创建 manual（用户提供内容）或 ai（必须携带已批准 model_id，
 * REQ-MOD-01）Insight；Admin：只读列表。保存永不触发 Embedding
 * （REQ-DIS-01 语义延伸）。
 */
export function InsightsPanel() {
  const { t } = useTranslation()
  const { projectId, isAdminReadonly } = useResearchWorkspace()
  const { data, isLoading, isError } = useResearchInsights(projectId)
  const createMutation = useCreateResearchInsight(projectId)

  const [showForm, setShowForm] = useState(false)
  const [title, setTitle] = useState('')
  const [content, setContent] = useState('')
  const [insightType, setInsightType] = useState<'ai' | 'manual'>('manual')
  const [modelId, setModelId] = useState('')

  const submitCreate = () => {
    if (!title.trim() || !content.trim()) return
    if (insightType === 'ai' && !modelId.trim()) return
    createMutation.mutate({
      title: title.trim(),
      content: content.trim(),
      insight_type: insightType,
      model_id: insightType === 'ai' ? modelId.trim() : undefined,
    })
    setTitle('')
    setContent('')
    setModelId('')
    setInsightType('manual')
    setShowForm(false)
  }

  const items = data?.items ?? []

  return (
    <div className="space-y-3">
      {isAdminReadonly && <AdminReadOnlyBanner />}

      {!isAdminReadonly && (
        <div className="flex justify-end">
          <Button size="sm" onClick={() => setShowForm((v) => !v)}>
            {t('research.insights.newInsight')}
          </Button>
        </div>
      )}

      {showForm && !isAdminReadonly && (
        <Card>
          <CardContent className="space-y-3 p-3">
            <div className="space-y-1">
              <Label htmlFor="insight-title">{t('research.notes.titleLabel')}</Label>
              <Input
                id="insight-title"
                value={title}
                onChange={(event) => setTitle(event.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="insight-content">{t('research.notes.contentLabel')}</Label>
              <Textarea
                id="insight-content"
                value={content}
                onChange={(event) => setContent(event.target.value)}
                rows={4}
              />
            </div>
            <div className="flex flex-wrap items-end gap-3">
              <div className="space-y-1">
                <Label htmlFor="insight-type">{t('research.insights.typeLabel')}</Label>
                <Select
                  value={insightType}
                  onValueChange={(value) => setInsightType(value as 'ai' | 'manual')}
                >
                  <SelectTrigger id="insight-type" className="w-40" aria-label="insight-type">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="manual">{t('research.insights.typeManual')}</SelectItem>
                    <SelectItem value="ai">{t('research.insights.typeAi')}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {insightType === 'ai' && (
                <div className="space-y-1">
                  <Label htmlFor="insight-model">{t('research.insights.modelLabel')}</Label>
                  <Input
                    id="insight-model"
                    value={modelId}
                    onChange={(event) => setModelId(event.target.value)}
                    placeholder="qwen3.6-35b-a3b-fp8"
                    className="w-56"
                  />
                </div>
              )}
            </div>
            <div className="flex gap-2">
              <Button size="sm" onClick={submitCreate} disabled={createMutation.isPending}>
                {t('research.notes.save')}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setShowForm(false)}>
                {t('research.notes.cancel')}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {isLoading && <p className="text-sm text-muted-foreground">{t('common.loading')}</p>}
      {isError && <p className="text-sm text-destructive">{t('research.workbench.loadFailed')}</p>}

      {!isLoading && !isError && items.length === 0 && (
        <p className="text-sm text-muted-foreground">{t('research.insights.empty')}</p>
      )}

      <div className="space-y-2">
        {items.map((item) => (
          <Card key={item.insight_id}>
            <CardContent className="p-3">
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm font-medium">{item.title}</p>
                <span className="text-xs text-muted-foreground">
                  {item.insight_type === 'ai' ? t('research.insights.typeAi') : t('research.insights.typeManual')}
                </span>
              </div>
              <p className="mt-1 whitespace-pre-wrap text-sm text-muted-foreground">
                {item.content}
              </p>
              {item.citations && item.citations.length > 0 && (
                <p className="mt-2 text-xs text-muted-foreground">
                  {t('research.transformations.citations')}: {item.citations.length}
                </p>
              )}
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  )
}
