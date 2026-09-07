'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/lib/hooks/use-translation'
import { useToast } from '@/lib/hooks/use-toast'
import { useResearchWorkspace } from '@/lib/embedded/workspace-context'
import { useResearchScope } from '@/lib/research/scope'
import { resolveScopeSelection } from '@/lib/research/scope-utils'
import { newIdempotencyKey } from '@/lib/research/api'
import { useResearchGlobalModel, researchModelBlockedHint } from '@/lib/hooks/use-research-global-model'
import { useRunResearchTransformation } from '@/lib/hooks/use-research'
import type { ResearchCitation, ResearchSource, TransformationResultRecord } from '@/lib/types/research'
import { normalizePersistedCitations } from './citation-utils'
import { CitationCard } from './CitationCard'
import { resolveCitationSource } from './citation-utils'

/**
 * Transformation Result 只读详情（RWV2-21 / Issue #42）。
 *
 * - 数据来自选中 result 的不可变行对象（list/detail 同构），不反映当前
 *   UI 的 Scope/模型/language 态（AC-3/AC-5）。
 * - 冻结元数据：provenance（transformation_id/template_config_ref/
 *   generation_id）、model、status、response_language（可 null）、时间、
 *   输入 id 计数、output、Citations。
 * - Citation 经 `normalizePersistedCitations` 归一化（High-2：持久快照
 *   无 citation_id/富字段）并复用 CitationCard + onCitationJump（High-5）。
 * - Rerun（Owner-only；Admin 由父层 `showRerun=false` 隐藏）：
 *   - 新建派发：新 `newIdempotencyKey()` + v1 契约头（仿 createCompare）；
 *   - 前置守卫（Medium-9）：legacy `transformation_id=null` → 禁用；
 *   - 可用性守卫（Medium-11）：`!canExecute` → 禁用 + 提示；
 *   - 成功 UX（Medium-12）：关闭前由父层在列表高亮新行（本组件回调
 *     `onRerunSuccess(result_id)`）；"无新行"= 非 200 reject（High-4）。
 */
export function TransformationRunDetail({
  record,
  sources,
  showRerun,
  onCitationJump,
  onRerunSuccess,
}: {
  record: TransformationResultRecord
  sources?: readonly ResearchSource[] | undefined
  /** Owner 可重跑；Admin 为 false（W7） */
  showRerun?: boolean
  /** Citation 跳转回调（工作台提供，左栏契约） */
  onCitationJump?: (citation: ResearchCitation) => void
  /** Rerun 成功回调（父层据此关闭详情并高亮新行，Medium-12） */
  onRerunSuccess?: (newResultId: string) => void
}) {
  const { t } = useTranslation()
  const { toast } = useToast()
  const { projectId } = useResearchWorkspace()
  const { canExecute, blockedReason, runGuarded } = useResearchGlobalModel()
  const { getSnapshot, validate } = useResearchScope()
  const runMutation = useRunResearchTransformation(projectId)
  const [isResolvingRerun, setIsResolvingRerun] = useState(false)

  const citations = normalizePersistedCitations(record.citations)
  const rerunnable = showRerun === true && record.transformation_id !== null
  const blockedHint = researchModelBlockedHint(blockedReason, t)

  const rerun = async () => {
    if (!record.transformation_id) return
    const snapshot = getSnapshot()
    if (snapshot.mode === 'selected' && !validate(snapshot).valid) return
    setIsResolvingRerun(true)
    let resolved: { sourceIds: string[]; noteIds: string[] }
    try {
      resolved = await resolveScopeSelection(projectId, snapshot)
    } catch {
      // Scope resolution is before the mutation, so use the same visible
      // failure treatment as the established Transformation run dialog.
      toast({
        title: t('common.error'),
        description: t('research.workbench.actionFailed'),
        variant: 'destructive',
      })
      return
    } finally {
      setIsResolvingRerun(false)
    }
    const { sourceIds, noteIds } = resolved
    if (snapshot.mode === 'entire_project' && sourceIds.length + noteIds.length === 0) {
      toast({ title: t('common.error'), description: t('research.transformations.emptyProjectBlocked'), variant: 'destructive' })
      return
    }
    try {
      await runGuarded(async (modelId) => {
        const result = await runMutation.mutateAsync({
          transformationId: record.transformation_id as string,
          sourceIds,
          noteIds,
          modelId,
          // 新建派发：必须新幂等键（复用旧 key → 后端幂等重放/409）
          idempotencyKey: newIdempotencyKey(),
        })
        // High-4：200 必有 result_id；此处只可能在成功分支
        if (result.result_id) {
          onRerunSuccess?.(result.result_id)
          toast({
            title: t('common.success'),
            description: t('research.transformations.rerunSuccess'),
          })
        }
        return true
      })
    } catch {
      // 非 200（422/403/404/409）已由 mutation onError toast；此处静默吸收
    }
  }

  return (
    <div className="space-y-3" data-testid="run-detail">
      <p className="text-xs text-muted-foreground">{record.project_id} · {record.result_id}</p>

      <div className="space-y-1 text-sm">
        <p className="font-medium">{record.title ?? '—'}</p>
        <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <dt>{t('research.transformations.templateLabel')}</dt>
          <dd data-testid="detail-transformation-id">{record.transformation_id ?? '—'}</dd>
          <dt>{t('research.transformations.templateConfigRef')}</dt>
          <dd className="truncate" data-testid="detail-config-ref">{record.template_config_ref ?? '—'}</dd>
          <dt>{t('research.transformations.generationId')}</dt>
          <dd className="truncate">{record.generation_id ?? '—'}</dd>
          <dt>{t('research.globalModel.label')}</dt>
          <dd data-testid="detail-model">{record.model_id ?? '—'}</dd>
          <dt>{t('research.transformations.status')}</dt>
          <dd data-testid="detail-status">{record.status ?? '—'}</dd>
          <dt>{t('research.transformations.language')}</dt>
          <dd data-testid="detail-language">{record.response_language ?? '—'}</dd>
          <dt>{t('research.transformations.inputs')}</dt>
          <dd>{record.source_ids.length} sources · {record.note_ids.length} notes</dd>
          <dt>{t('research.transformations.createdAt')}</dt>
          <dd>{record.created_at ?? '—'}</dd>
        </dl>
      </div>

      {record.output !== null && record.output !== '' && (
        <div>
          <p className="text-xs font-medium text-muted-foreground">{t('research.transformations.runResult')}</p>
          <p className="whitespace-pre-wrap text-sm" data-testid="detail-output">{record.output}</p>
        </div>
      )}

      {citations.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs font-medium text-muted-foreground">{t('research.transformations.citations')}</p>
          {citations.map((citation) => {
            const richCitation: ResearchCitation = {
              citation_id: citation.citation_id,
              claim: citation.claim,
              chunk_id: citation.chunk_id,
              doc_id: citation.doc_id,
              doc_version: citation.doc_version,
              page_idx: citation.page_idx,
              section: null,
              original_text: citation.original_text,
              citation_type: null,
              confidence: null,
              doc_display_name: citation.doc_display_name,
              short_name: citation.short_name,
              doc_type: null,
              project_id: record.project_id,
              vlm_bboxes: null,
              minio_uri: null,
              source_path: null,
            }
            return (
              <CitationCard
                key={citation.key}
                citation={richCitation}
                source={resolveCitationSource(sources, richCitation)}
                onJump={onCitationJump}
              />
            )
          })}
        </div>
      )}

      {showRerun === true && (
        <div className="space-y-2">
          {record.transformation_id === null && (
            <p className="text-xs text-muted-foreground" data-testid="rerun-unavailable" role="alert">
              {t('research.transformations.rerunUnavailable')}
            </p>
          )}
          {rerunnable && blockedHint !== '' && (
            <p className="text-xs font-medium text-destructive" data-testid="rerun-blocked-hint" role="alert">
              {blockedHint}
            </p>
          )}
          <Button
            size="sm"
            onClick={() => void rerun()}
            disabled={
              !canExecute ||
              runMutation.isPending ||
              isResolvingRerun ||
              record.transformation_id === null
            }
            data-testid="rerun-btn"
          >
            {t('research.transformations.rerun')}
          </Button>
        </div>
      )}
    </div>
  )
}
