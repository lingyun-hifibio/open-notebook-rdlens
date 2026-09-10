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
import { useToast } from '@/lib/hooks/use-toast'
import { useResearchWorkspace } from '@/lib/embedded/workspace-context'
import { useResearchGlobalModel, researchModelBlockedHint } from '@/lib/hooks/use-research-global-model'
import { useCreateResearchInsight, useResearchInsights } from '@/lib/hooks/use-research'
import { useResearchScope } from '@/lib/research/scope'
import { formatScopeLabel } from '@/lib/research/scope'
import {
  detectResponseLanguage,
  EmptyEffectiveScopeError,
  resolveScopeSelection,
} from '@/lib/research/scope-utils'
import { useAiInsightSubmit, type AiInsightSubmitStatus } from '@/lib/research/ai-insight-submit'
import { useResearchJobsController } from './ResearchJobsProvider'
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
export function InsightsPanel({
  revealId = null,
}: {
  /** RWV2-23（AC3）：保存为 Insight 后的左栏高亮目标（行 ring） */
  revealId?: string | null
}) {
  const { t } = useTranslation()
  const { toast } = useToast()
  const { projectId, userId, isAdminReadonly } = useResearchWorkspace()
  const { canExecute, runGuarded, blockedReason, confirmedModelId, invalidateConsent } =
    useResearchGlobalModel()
  const { data, isLoading, isError } = useResearchInsights(projectId)
  const createMutation = useCreateResearchInsight(projectId)
  const { registerJob } = useResearchJobsController()
  const { getSnapshot, validate } = useResearchScope()

  const [showForm, setShowForm] = useState(false)
  const [title, setTitle] = useState('')
  const [content, setContent] = useState('')
  const [insightType, setInsightType] = useState<'ai' | 'manual'>('manual')
  /** S4：AI 派发的可见反馈（可重试/协议冲突/未知结果 + stale 计数） */
  const [aiNotice, setAiNotice] = useState<AiInsightSubmitStatus | null>(null)
  const [aiStaleCount, setAiStaleCount] = useState(0)
  const [aiErrorCode, setAiErrorCode] = useState<string | null>(null)
  const [isResolvingScope, setIsResolvingScope] = useState(false)

  const aiSubmit = useAiInsightSubmit({
    projectId,
    userId: userId ?? '',
    dispatch: runGuarded,
    onCreated: () => {
      // 真实 runGuarded 可能在 consent 确认后才执行 operation——成功后的表单
      // 重置必须由回调驱动（submitAi 的 await 早已返回，看不到最终状态）
      resetForm()
      toast({ title: t('common.success'), description: t('research.workbench.insightCreated') })
    },
    onQueued: (jobId) => {
      // 唯一 Jobs Provider 登记（不新增第二套 Job 状态，C-02/O-03）
      registerJob(jobId)
      // 202 只表示 queued：不宣称 Insight 已创建，指引去 Activity 查看并在完成后
      // 手动 Refresh Insights（O-03/O-04）；toast 因成功路径会关闭表单而必需
      toast({
        title: t('common.success'),
        description: t('research.insights.aiQueued'),
      })
    },
    onBlockedEmptyScope: () => {
      setAiNotice('blocked_empty_scope')
    },
    onOutcomeUnknown: () => {
      setAiNotice('outcome_unknown')
      toast({
        title: t('common.error'),
        description: t('research.insights.aiOutcomeUnknown'),
        variant: 'destructive',
      })
    },
    onProtocolConflict: () => {
      setAiNotice('protocol_conflict')
      toast({
        title: t('common.error'),
        description: t('research.insights.aiProtocolConflict'),
        variant: 'destructive',
      })
    },
    onFailed: (code) => {
      setAiErrorCode(code)
      setAiNotice('failed')
      // 确定性终态失败必须可见（此前只有内联提示且文案分支缺失 → 用户"点了没反应"）
      toast({
        title: t('common.error'),
        description: t('research.insights.aiFailed'),
        variant: 'destructive',
      })
    },
    onRefreshConsent: () => {
      // consent 失效：刷新服务端 consent，下一次派发重新走确认（新 key）
      invalidateConsent()
    },
    onStaleSourceCount: (count) => {
      setAiStaleCount(count)
    },
  })

  /**
   * S4：AI 派发——Scope 用 S2 唯一 resolver 解析（entire_project 分页枚举、
   * selected 冻结副本），语言按 content 检出并冻结，随后交给 S4 编排 hook
   * （consent 闸门 → key/marker → POST → disposition 状态机）。
   */
  const submitAi = async (titleSnapshot: string, contentSnapshot: string) => {
    const snapshot = getSnapshot()
    if (snapshot.mode === 'selected' && !validate(snapshot).valid) {
      setAiNotice('blocked_empty_scope')
      return
    }
    setIsResolvingScope(true)
    let resolved: { sourceIds: string[]; noteIds: string[]; staleSourceCount: number }
    try {
      resolved = await resolveScopeSelection(projectId, snapshot)
    } catch (error) {
      setAiErrorCode(error instanceof EmptyEffectiveScopeError ? null : t('research.workbench.actionFailed'))
      setAiNotice(error instanceof EmptyEffectiveScopeError ? 'blocked_empty_scope' : 'failed')
      return
    } finally {
      setIsResolvingScope(false)
    }
    // stale 计数由 hook 在真正派发时回传（consent 取消不留痕，L-2）
    void resolved.staleSourceCount
    // 模型在派发时刻冻结（consent 确认前后不再漂移，C-04）
    if (confirmedModelId === null) return
    await aiSubmit.submit({
      title: titleSnapshot,
      content: contentSnapshot,
      sourceIds: resolved.sourceIds,
      noteIds: resolved.noteIds,
      responseLanguage: detectResponseLanguage(contentSnapshot),
      modelId: confirmedModelId,
      staleSourceCount: resolved.staleSourceCount,
      scopeLabel: formatScopeLabel(snapshot, t),
    })
  }

  const resetForm = () => {
    setTitle('')
    setContent('')
    setInsightType('manual')
    setShowForm(false)
    setAiNotice(null)
    setAiStaleCount(0)
    setAiErrorCode(null)
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
    // AI 生成：S2 resolver 冻结 Scope → S4 编排（consent/幂等/marker/状态机）。
    // 此处不预清 aiNotice：提交前的 hook gate（未确认 marker）会在开表单时
    // 写入冲突态，预清会把唯一可见反馈抹掉；终态由 hook 回调改写。
    setAiErrorCode(null)
    void submitAi(titleSnapshot, contentSnapshot)
  }

  const aiNoticeMessage =
    aiNotice === 'blocked_empty_scope'
      ? t('research.insights.aiEmptyScopeBlocked')
      : aiNotice === 'queued'
        ? t('research.insights.aiQueued')
        : aiNotice === 'outcome_unknown'
          ? t('research.insights.aiOutcomeUnknown')
          : aiNotice === 'protocol_conflict'
            ? t('research.insights.aiProtocolConflict')
            : aiNotice === 'failed'
              ? t('research.insights.aiFailed')
              : null

  const items = data?.items ?? []

  return (
    <div className="space-y-3">
      {isAdminReadonly && <AdminReadOnlyBanner />}

      {!isAdminReadonly && (
        <div className="flex justify-end">
          <Button
            size="sm"
            onClick={() => {
              // 重新打开表单 = 新的提交意图：清掉上一笔的提示与计数
              setAiNotice(null)
              setAiStaleCount(0)
              setAiErrorCode(null)
              setShowForm((v) => !v)
            }}
          >
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
            {/* S4：stale Source 可派发但必须可见（C-03） */}
            {insightType === 'ai' && aiStaleCount > 0 && (
              <p className="text-xs text-muted-foreground" role="status" data-testid="insight-stale-warning">
                {t('research.insights.aiStaleSourcesWarning', { n: aiStaleCount })}
              </p>
            )}
            {insightType === 'ai' && aiNoticeMessage !== null && (
              <p
                className={
                  aiNotice === 'blocked_empty_scope' || aiNotice === 'failed'
                    ? 'text-xs font-medium text-destructive'
                    : 'text-xs text-muted-foreground'
                }
                role={aiNotice === 'blocked_empty_scope' || aiNotice === 'failed' ? 'alert' : 'status'}
                data-testid={`insight-ai-notice-${aiNotice}`}
              >
                {aiNoticeMessage}
                {aiNotice === 'failed' && aiErrorCode !== null ? ` (${aiErrorCode})` : ''}
              </p>
            )}
            {insightType === 'ai' && aiNotice === 'protocol_conflict' && aiSubmit.result.pendingMarker !== null && (
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => aiSubmit.result.confirmDuplicateRisk()}
                  data-testid="insight-confirm-duplicate-risk"
                >
                  {t('research.insights.aiConfirmDuplicateRisk')}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    aiSubmit.result.discardDuplicateRisk()
                    setAiNotice(null)
                  }}
                  data-testid="insight-discard-duplicate-risk"
                >
                  {t('research.insights.aiDiscardDuplicateRisk')}
                </Button>
              </div>
            )}
            <div className="flex gap-2">
              <Button
                size="sm"
                onClick={submitCreate}
                disabled={
                  createMutation.isPending ||
                  // AI 流程的在途状态只作用于 AI 分支——避免「AI 卡住 → Manual 陪绑」
                  // 这类隐性耦合（评审建议的纵深防御）
                  (insightType === 'ai' &&
                    (isResolvingScope || aiSubmit.isSubmitting || !canExecute))
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
          <Card
            key={item.insight_id}
            data-testid={`insight-row-${item.insight_id}`}
            className={item.insight_id === revealId ? 'ring-1 ring-primary' : undefined}
          >
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
