'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { Checkbox } from '@/components/ui/checkbox'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useTranslation } from '@/lib/hooks/use-translation'
import { useResearchWorkspace } from '@/lib/embedded/workspace-context'
import {
  useCreateResearchTransformation,
  useResearchSources,
  useResearchNotes,
  useResearchTransformations,
  useRunResearchTransformation,
} from '@/lib/hooks/use-research'
import type {
  ResearchCitation,
  ResearchTransformation,
  TransformationRunResult,
} from '@/lib/types/research'
import { AdminReadOnlyBanner } from './AdminReadOnlyBanner'
import { CitationCard } from './CitationCard'
import { resolveCitationSource } from './citation-utils'

/**
 * Transformations 工作台（UI-02，REQ-SCOPE-04/REQ-DIS-02/03/REQ-API-01，
 * 契约 §7.3，设计 §8/§12）。
 *
 * - 模板仅 prompt-only：name/prompt_template/model_id/scope 四字段，无
 *   code/tool/url（REQ-DIS-03，后端 extra="forbid" 422 双保险）；
 * - 运行：输入 Source/Note 服务端授权；运行前数据外发提示（外部模型，
 *   §12）为硬门槛（未确认不可运行）；运行只走 Gateway run 端点
 *   （REQ-DIS-02，无上游 Provider）；
 * - 结果展示 output + Citation（CitationCard，失效降级保留原文）；
 * - requires_job 降级提示（输出超预算 → 持久化任务，UI-03 查看）。
 */
export function TransformationsPanel({
  onCitationJump,
}: {
  /** Citation 跳转回调（工作台提供：解析来源并定位目标页） */
  onCitationJump?: (citation: ResearchCitation) => void
}) {
  const { t } = useTranslation()
  const { projectId, isAdminReadonly } = useResearchWorkspace()
  const { data, isLoading, isError } = useResearchTransformations(projectId)
  const createMutation = useCreateResearchTransformation(projectId)
  const runMutation = useRunResearchTransformation(projectId)

  const [showForm, setShowForm] = useState(false)
  const [name, setName] = useState('')
  const [prompt, setPrompt] = useState('')
  const [modelId, setModelId] = useState('')

  // 运行对话框状态
  const [runTarget, setRunTarget] = useState<ResearchTransformation | null>(null)
  const [selectedSourceIds, setSelectedSourceIds] = useState<string[]>([])
  const [selectedNoteIds, setSelectedNoteIds] = useState<string[]>([])
  const [egressAcknowledged, setEgressAcknowledged] = useState(false)
  const [runResult, setRunResult] = useState<TransformationRunResult | null>(null)

  const { data: sourcesData } = useResearchSources(runTarget ? projectId : '')
  const { data: notesData } = useResearchNotes(runTarget ? projectId : '', '')

  const submitCreate = () => {
    if (!name.trim() || !prompt.trim() || !modelId.trim()) return
    createMutation.mutate({
      name: name.trim(),
      prompt_template: prompt.trim(),
      model_id: modelId.trim(),
      scope: 'project_private',
    })
    setName('')
    setPrompt('')
    setModelId('')
    setShowForm(false)
  }

  const openRun = (template: ResearchTransformation) => {
    setRunTarget(template)
    setSelectedSourceIds([])
    setSelectedNoteIds([])
    setEgressAcknowledged(false)
    setRunResult(null)
  }

  const toggle = (list: string[], id: string): string[] =>
    list.includes(id) ? list.filter((x) => x !== id) : [...list, id]

  const executeRun = () => {
    if (!runTarget) return
    runMutation.mutate(
      {
        transformationId: runTarget.transformation_id,
        sourceIds: selectedSourceIds,
        noteIds: selectedNoteIds,
      },
      { onSuccess: setRunResult },
    )
  }

  const items = data?.items ?? []

  return (
    <div className="space-y-3">
      {isAdminReadonly && <AdminReadOnlyBanner />}

      {!isAdminReadonly && (
        <div className="flex justify-end">
          <Button size="sm" onClick={() => setShowForm((v) => !v)}>
            {t('research.transformations.newTemplate')}
          </Button>
        </div>
      )}

      {showForm && !isAdminReadonly && (
        <Card>
          <CardContent className="space-y-3 p-3">
            <div className="space-y-1">
              <Label htmlFor="trans-name">{t('research.transformations.nameLabel')}</Label>
              <Input id="trans-name" value={name} onChange={(event) => setName(event.target.value)} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="trans-prompt">{t('research.transformations.promptLabel')}</Label>
              <Textarea
                id="trans-prompt"
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                rows={4}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="trans-model">{t('research.transformations.modelLabel')}</Label>
              <Input
                id="trans-model"
                value={modelId}
                onChange={(event) => setModelId(event.target.value)}
                placeholder="qwen3.6-35b-a3b-fp8"
                className="max-w-sm"
              />
            </div>
            <div className="flex gap-2">
              <Button size="sm" onClick={submitCreate} disabled={createMutation.isPending}>
                {t('research.transformations.save')}
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
        <p className="text-sm text-muted-foreground">{t('research.workbench.empty')}</p>
      )}

      <div className="space-y-2">
        {items.map((item) => (
          <Card key={item.transformation_id}>
            <CardContent className="flex items-center justify-between gap-3 p-3">
              <div className="min-w-0">
                <p className="text-sm font-medium">{item.name}</p>
                <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                  {item.prompt_template}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {item.model_id ?? '—'} ·{' '}
                  {item.scope === 'admin_template'
                    ? t('research.transformations.scopeAdmin')
                    : t('research.transformations.scopePrivate')}
                </p>
              </div>
              {!isAdminReadonly && (
                <Button size="sm" variant="outline" onClick={() => openRun(item)}>
                  {t('research.transformations.run')}
                </Button>
              )}
            </CardContent>
          </Card>
        ))}
      </div>

      {/* 运行对话框：输入选择 + 数据外发提示（首次硬门槛）+ 结果 */}
      <Dialog open={runTarget !== null} onOpenChange={(open) => !open && setRunTarget(null)}>
        <DialogContent className="max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{t('research.transformations.run')}: {runTarget?.name}</DialogTitle>
            <DialogDescription>{t('research.transformations.selectInputs')}</DialogDescription>
          </DialogHeader>

          {!egressAcknowledged && (
            <Alert variant="default" data-testid="egress-notice">
              <AlertTitle>{t('research.transformations.egressTitle')}</AlertTitle>
              <AlertDescription>{t('research.transformations.egressMessage')}</AlertDescription>
            </Alert>
          )}

          <div className="space-y-1">
            <p className="text-xs font-medium text-muted-foreground">
              {t('research.transformations.sourceIds')}
            </p>
            {(sourcesData?.items ?? []).map((sourceItem) => (
              <label key={sourceItem.source_id} className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={selectedSourceIds.includes(sourceItem.source_id)}
                  onCheckedChange={() =>
                    setSelectedSourceIds((prev) => toggle(prev, sourceItem.source_id))
                  }
                />
                {sourceItem.document_id}
              </label>
            ))}
          </div>

          <div className="space-y-1">
            <p className="text-xs font-medium text-muted-foreground">
              {t('research.transformations.noteIds')}
            </p>
            {(notesData?.items ?? []).map((noteItem) => (
              <label key={noteItem.note_id} className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={selectedNoteIds.includes(noteItem.note_id)}
                  onCheckedChange={() =>
                    setSelectedNoteIds((prev) => toggle(prev, noteItem.note_id))
                  }
                />
                {noteItem.title}
              </label>
            ))}
          </div>

          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={egressAcknowledged}
              onCheckedChange={(checked) => setEgressAcknowledged(checked === true)}
            />
            {t('research.transformations.egressMessage')}
          </label>

          {runResult && (
            <div className="space-y-2 rounded-md border p-3">
              {runResult.requires_job && (
                <p className="text-xs text-muted-foreground">
                  {t('research.transformations.degraded', {
                    reason: runResult.degradation_reason ?? 'requires_job',
                  })}
                </p>
              )}
              <p className="text-sm font-medium">{t('research.transformations.runResult')}</p>
              {runResult.output !== null && (
                <p className="whitespace-pre-wrap text-sm">{runResult.output}</p>
              )}
              {runResult.citations.length > 0 && (
                <div className="space-y-2">
                  <p className="text-xs font-medium text-muted-foreground">
                    {t('research.transformations.citations')}
                  </p>
                  {runResult.citations.map((citation) => (
                    <CitationCard
                      key={citation.citation_id}
                      citation={citation}
                      source={resolveCitationSource(sourcesData?.items, citation)}
                      onJump={onCitationJump}
                    />
                  ))}
                </div>
              )}
            </div>
          )}

          <DialogFooter>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setRunTarget(null)}
            >
              {t('research.notes.cancel')}
            </Button>
            <Button
              size="sm"
              onClick={executeRun}
              disabled={!egressAcknowledged || runMutation.isPending}
            >
              {t('research.transformations.confirmRun')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
