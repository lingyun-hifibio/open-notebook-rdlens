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
import { useResearchGlobalModel, researchModelBlockedHint } from '@/lib/hooks/use-research-global-model'
import { useCreateResearchInsight, useResearchInsights } from '@/lib/hooks/use-research'
import { AdminReadOnlyBanner } from './AdminReadOnlyBanner'

/**
 * Insights 工作台（UI-02，REQ-SCOPE-04/REQ-API-01，契约 §7.2）。
 *
 * Owner：创建 manual（用户提供内容）或 ai（必须携带已批准 model_id，
 * REQ-MOD-01）Insight；Admin：只读列表。保存永不触发 Embedding
 * （REQ-DIS-01 语义延伸）。
 *
 * Issue #243 GMOD-FE-01 §6.5：
 * - AI Insight 不再有独立模型输入——AI 生成固定使用顶层 confirmed 全局
 *   模型（页面内唯一入口，不变量 1）；
 * - Manual Insight 保持人工内容流程：不要求模型，也不触发外发确认；
 * - 无 confirmed 模型时只阻止 AI 模式，不影响已有 Insight 浏览或
 *   Manual 创建；
 * - 外部模型的首次 AI 生成由根级 `runGuarded` 统一弹确认（不变量 9）。
 */
export function InsightsPanel() {
  const { t } = useTranslation()
  const { projectId, isAdminReadonly } = useResearchWorkspace()
  const { canExecute, runGuarded, blockedReason } = useResearchGlobalModel()
  const { data, isLoading, isError } = useResearchInsights(projectId)
  const createMutation = useCreateResearchInsight(projectId)

  const [showForm, setShowForm] = useState(false)
  const [title, setTitle] = useState('')
  const [content, setContent] = useState('')
  const [insightType, setInsightType] = useState<'ai' | 'manual'>('manual')

  const resetForm = () => {
    setTitle('')
    setContent('')
    setInsightType('manual')
    setShowForm(false)
  }

  const submitCreate = () => {
    if (!title.trim() || !content.trim()) return
    const titleSnapshot = title.trim()
    const contentSnapshot = content.trim()
    // §6.5：Manual 是人工内容流程——不要求模型，也不触发外发确认
    if (insightType === 'manual') {
      createMutation.mutate({
        title: titleSnapshot,
        content: contentSnapshot,
        insight_type: 'manual',
      })
      resetForm()
      return
    }
    // AI 生成：走根级 guard，模型来自 confirmed 全局模型快照
    void runGuarded(async (modelId) => {
      await createMutation.mutateAsync({
        title: titleSnapshot,
        content: contentSnapshot,
        insight_type: 'ai',
        model_id: modelId,
      })
      resetForm()
    })
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
              {/* §6.5：模型输入已移除——AI 生成使用顶层 confirmed 全局模型；
                  提示按 blockedReason 映射，admin 只读/保存中等场景不再误导为
                  「请先选择模型」 */}
              {insightType === 'ai' && !canExecute && (
                <p className="text-xs text-muted-foreground" data-testid="insight-model-blocked">
                  {researchModelBlockedHint(blockedReason, t)}
                </p>
              )}
            </div>
            <div className="flex gap-2">
              <Button
                size="sm"
                onClick={submitCreate}
                disabled={
                  createMutation.isPending ||
                  // 无可用模型时只阻止 AI 模式；Manual 不受影响
                  (insightType === 'ai' && !canExecute)
                }
                data-testid="insight-submit"
              >
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
