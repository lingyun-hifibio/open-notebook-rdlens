'use client'

import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/lib/hooks/use-translation'
import { useToast } from '@/lib/hooks/use-toast'
import { useResearchWorkspace } from '@/lib/embedded/workspace-context'
import { useResearchScope } from '@/lib/research/scope'
import { formatScopeLabel } from '@/lib/research/scope'
import { resolveScopeSelection } from '@/lib/research/scope-utils'
import { newIdempotencyKey } from '@/lib/research/api'
import { useResearchGlobalModel, researchModelBlockedHint } from '@/lib/hooks/use-research-global-model'
import { useRunResearchTransformation } from '@/lib/hooks/use-research'
import { formatResearchTimestamp, researchLanguageLabelKey } from '@/lib/research/format'
import type { ResearchCitation, ResearchSource, TransformationResultRecord } from '@/lib/types/research'
import { normalizePersistedCitations } from './citation-utils'
import { CitationCard } from './CitationCard'
import { resolveCitationSource } from './citation-utils'
import { ResultActions } from './ResultActions'

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
 *   - 生命周期守卫（评审 Medium-3）：详情关闭/卸载后，仍在途的 scope
 *     解析或外部模型 consent 不再派发（令牌在 unmount 时失效）；
 *   - 降级响应（评审 Medium-2）：`requires_job: true` 成功时 `result_id`
 *     为 null（job 化），给可见的 degraded/job 消息而不是静默；
 *   - 成功 UX（Medium-12）：关闭前由父层在列表高亮新行（本组件回调
 *     `onRerunSuccess(result_id)`）；"无新行"= 非 200 reject（High-4）。
 */
export function TransformationRunDetail({
  record,
  sources,
  showRerun,
  onCitationJump,
  onRerunSuccess,
  onViewInsight,
  onViewNote,
  onContinueResearch,
}: {
  record: TransformationResultRecord
  sources?: readonly ResearchSource[] | undefined
  /** Owner 可重跑；Admin 为 false（W7） */
  showRerun?: boolean
  /** Citation 跳转回调（工作台提供，左栏契约） */
  onCitationJump?: (citation: ResearchCitation) => void
  /** Rerun 成功回调（父层据此关闭详情并高亮新行，Medium-12） */
  onRerunSuccess?: (newResultId: string) => void
  /** RWV2-23（AC3）：保存成功后跳转 Results/Insights 或 Materials/Notes */
  onViewInsight?: (insightId: string) => void
  onViewNote?: (noteId: string) => void
  /** RWV2-23（AC4）：Continue research —— 关闭详情并预填 Chat */
  onContinueResearch?: () => void
}) {
  const { t } = useTranslation()
  const { toast } = useToast()
  const { projectId } = useResearchWorkspace()
  const { canExecute, blockedReason, runGuarded } = useResearchGlobalModel()
  const { getSnapshot, validate } = useResearchScope()
  const runMutation = useRunResearchTransformation(projectId)
  const [isResolvingRerun, setIsResolvingRerun] = useState(false)
  /** 降级任务提示（评审 Medium-2：requires_job job 化的可见反馈） */
  const [rerunDegraded, setRerunDegraded] = useState<string | null>(null)
  // 生命周期守卫（评审 Medium-3，同 TransformationsPanel B1/B2 令牌语义）：
  // 详情关闭/组件卸载后，仍在途的 scope 解析与外部模型 consent 确认都不得
  // 继续派发。卸载 cleanup 使令牌失效；rerun 捕获起始值，在解析返回后与
  // runGuarded op 内（mutateAsync 前）各校验一次。
  const rerunAliveRef = useRef(true)
  useEffect(() => {
    rerunAliveRef.current = true
    return () => {
      rerunAliveRef.current = false
    }
  }, [])

  const citations = normalizePersistedCitations(record.citations)
  const rerunnable = showRerun === true && record.transformation_id !== null
  const blockedHint = researchModelBlockedHint(blockedReason, t)
  // RWV2-43：语言 en/zh → 英文标签；未知非 null → 原码；null → '—'（F4/C-M1）
  const languageKey = researchLanguageLabelKey(record.response_language)
  const languageText = languageKey === null
    ? '—'
    : languageKey.startsWith('research.transformations.')
      ? t(languageKey)
      : languageKey
  const createdText = formatResearchTimestamp(record.created_at) ?? '—'

  const rerun = async () => {
    if (!record.transformation_id) return
    const snapshot = getSnapshot()
    if (snapshot.mode === 'selected' && !validate(snapshot).valid) return
    setIsResolvingRerun(true)
    setRerunDegraded(null)
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
      // 只有组件仍存活才复位解析标志（卸载后不触碰状态）
      if (rerunAliveRef.current) {
        setIsResolvingRerun(false)
      }
    }
    // 评审 Medium-3：scope 解析返回时详情已关闭/卸载 → 不再派发
    if (!rerunAliveRef.current) return
    const { sourceIds, noteIds } = resolved
    if (snapshot.mode === 'entire_project' && sourceIds.length + noteIds.length === 0) {
      toast({ title: t('common.error'), description: t('research.transformations.emptyProjectBlocked'), variant: 'destructive' })
      return
    }
    try {
      await runGuarded(
        async (modelId) => {
          // 评审 Medium-3：外部模型 consent 确认期间详情已关闭/卸载 →
          // op 内（mutateAsync 前）再校验，零派发（与既有 run dialog B2 同构）
          if (!rerunAliveRef.current) return
          const result = await runMutation.mutateAsync({
            transformationId: record.transformation_id as string,
            sourceIds,
            noteIds,
            modelId,
            // 新建派发：必须新幂等键（复用旧 key → 后端幂等重放/409）
            idempotencyKey: newIdempotencyKey(),
          })
          // High-4：非 job 化 200 必有 result_id；job 化（requires_job）成功
          // 响应 result_id 为 null——评审 Medium-2 指出旧代码在此静默：既不给
          // 确认也不提示 job。与既有 run flow 的 degraded 处理对齐：可见的
          // job/降级消息（新结果将由持久任务异步产出，历史列表随后出现）。
          if (result.requires_job) {
            setRerunDegraded(result.degradation_reason ?? 'requires_job')
            return true
          }
          if (result.result_id) {
            onRerunSuccess?.(result.result_id)
            toast({
              title: t('common.success'),
              description: t('research.transformations.rerunSuccess'),
            })
          }
          return true
        },
        // RWV2-42：rerun 按当前 Scope 重新派发（resolve 前 getSnapshot() 冻结）；
        // consent Scope 行必须与该快照一致，而非历史 run 输入（评审 H6）
        { scopeLabel: formatScopeLabel(snapshot, t) },
      )
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
          <dd data-testid="detail-language">{languageText}</dd>
          <dt>{t('research.transformations.inputs')}</dt>
          <dd data-testid="detail-inputs-summary">
            {t('research.transformations.sourceNoteCount', {
              sources: record.source_ids.length,
              notes: record.note_ids.length,
            })}
          </dd>
          <dt>{t('research.transformations.createdAt')}</dt>
          <dd data-testid="detail-created">{createdText}</dd>
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

      {/* RWV2-23：Transformation Result 动作条——origin 恒为 server detail 的
          generation_id（AC6，不消费 dialog 局部输出）。legacy 行
          （generation_id=null）不提供写动作，只保留 Copy。 */}
      <ResultActions
        originKind="transformation"
        originId={record.generation_id}
        content={record.output ?? ''}
        citations={citations}
        onContinueResearch={onContinueResearch}
        onViewInsight={onViewInsight}
        onViewNote={onViewNote}
      />

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
          {rerunDegraded !== null && (
            <p className="text-xs font-medium text-muted-foreground" data-testid="rerun-degraded" role="status">
              {t('research.transformations.degraded', { reason: rerunDegraded })}
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
