'use client'

import { useCallback, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useTranslation } from '@/lib/hooks/use-translation'
import { useToast } from '@/lib/hooks/use-toast'
import { useResearchWorkspace } from '@/lib/embedded/workspace-context'
import { useResearchGlobalModel } from '@/lib/hooks/use-research-global-model'
import { useResearchScope, type ResearchScopeSnapshot } from '@/lib/research/scope'
import { formatScopeLabel } from '@/lib/research/scope'
import {
  detectResponseLanguage,
  EmptyEffectiveScopeError,
  resolveScopeSelection,
} from '@/lib/research/scope-utils'
import {
  useCreateResearchTransformation,
  useResearchSources,
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
 * 契约 §7.3，设计 §8/§12；RWV2-12 Issue #33 迁移共享 Scope）。
 *
 * RWV2-12（RFC §3 唯一 Scope 契约）：
 * - 模板仅 prompt-only：name/prompt_template/model_id/scope 四字段，无
 *   code/tool/url（REQ-DIS-03，后端 extra="forbid" 422 双保险）；
 * - **运行不再维护第三套 Sources/Notes 选择**：运行对话框只读展示当前
 *   Research Scope 摘要（Entire project / Selected: N sources, M notes）
 *   + `Edit scope` 入口（关闭对话框回到**左栏唯一编辑面**——RWV2-13
 *   Issue #34 已把模式与 Sources/Notes 复选框迁入左栏，右栏仅留紧凑
 *   Scope Summary）。Scope 权威只来自根级 ResearchScopeProvider。
 * - **派发冻结**：点击 Confirm 时一次性把 Scope 快照解析为显式 id 全集
 *   （entire_project 分页枚举；selected 透传）并冻结；confirmed 全局模型
 *   由 runGuarded 在调用时刻捕获；response language 按模板单 Prompt 在
 *   派发时刻检测并固定（RFC §4.2；请求字段由 RWV2-M3 接线）。派发后
 *   修改 Scope/模型不影响在途运行（不变量 5/6）。
 * - 外部 consent 统一由根级 runGuarded 处理（§6.8，不变量 9）：取消
 *   零副作用，runSnapshot 不设置、摘要仍为 live。
 * - 结果展示 output + Citation（CitationCard，失效降级保留原文）；
 *   requires_job 降级提示（输出超预算 → 持久化任务，UI-03 查看）。
 * - 空范围引导：selected 空态（provider 不变量下防御性）与
 *   entire_project 空项目（解析后可达）均英文阻断，不派发。
 * - S2（Issue #54）：唯一解析器在派发前完成过滤——pending/failed Source
 *   不进入载荷，stale Source 进入载荷但派发时显示警告，Note-only 为合法
 *   范围；解析结果为空有效范围时抛 typed `EmptyEffectiveScopeError`，
 *   同一阻断面呈现（不降级到 entire project）。
 */
export function TransformationsPanel({
  onCitationJump,
  onEditScope,
}: {
  /** Citation 跳转回调（工作台提供：解析来源并定位目标页） */
  onCitationJump?: (citation: ResearchCitation) => void
  /**
   * RWV2-40：运行对话框的 `Edit scope`——先关闭 Dialog，再由组合根退出
   * Source focus/最大化、显示左栏编辑面并递增聚焦请求（R8-3 冻结链）。
   * 缺省（旧接线）只关闭对话框。
   */
  onEditScope?: () => void
}) {
  const { t } = useTranslation()
  const { toast } = useToast()
  const { projectId, isAdminReadonly } = useResearchWorkspace()
  const { confirmedModelId, canExecute, runGuarded } = useResearchGlobalModel()
  const { mode, selectedSourceIds, selectedNoteIds, validate, getSnapshot } = useResearchScope()
  const { data, isLoading, isError } = useResearchTransformations(projectId)
  const createMutation = useCreateResearchTransformation(projectId)
  const runMutation = useRunResearchTransformation(projectId)

  const [showForm, setShowForm] = useState(false)
  const [name, setName] = useState('')
  const [prompt, setPrompt] = useState('')

  /** RWV2-35：双语 admin 模板的 Run 变体语言（选择器；默认 en） */
  const [runVariant, setRunVariant] = useState<'zh' | 'en'>('en')

  // 运行对话框状态（Scope 权威在 provider；本面板只读，不再维护局部选择）
  const [runTarget, setRunTarget] = useState<ResearchTransformation | null>(null)
  const runTargetRef = useRef<ResearchTransformation | null>(null)
  /** 派发生命周期令牌：openRun/closeRunDialog 各 +1；executeRun 捕获起始
   *  值，解析返回后与 op 体内（mutateAsync 前）校验——对话框已关闭/重开
   *  同一模板时旧执行流必须废弃（对象同一性比较会被「重开同一模板」击穿，
   *  令牌不依赖对象身份；consent 注册后对话框关闭的路径由 op 内校验拦截） */
  const runGenerationRef = useRef(0)
  const [runResult, setRunResult] = useState<TransformationRunResult | null>(null)
  /** 本次运行实际采用的模型快照（展示用；模板历史模型只是 provenance） */
  const [runModelId, setRunModelId] = useState<string | null>(null)
  /** 派发确实发生后的 Scope/语言快照（展示用；本地与 consent 确认路径
   *  均在 operation 体内设置；取消/未派发不设置） */
  const [runSnapshot, setRunSnapshot] = useState<ResearchScopeSnapshot | null>(null)
  const [runLanguage, setRunLanguage] = useState<'zh' | 'en' | null>(null)
  /** 解析中（entire_project 分页枚举），防止重复派发 */
  const [isResolvingRun, setIsResolvingRun] = useState(false)
  /** 可达阻断：空有效范围（entire_project 空项目或枚举后全被过滤；
   *  selected 空态用渲染期条件） */
  const [blockedReason, setBlockedReason] = useState<'empty_project' | null>(null)
  /** S2：本次解析结果中的 stale Source 数（>0 时提交前展示警告） */
  const [staleSourceCount, setStaleSourceCount] = useState(0)

  const { data: sourcesData } = useResearchSources(projectId)

  const submitCreate = () => {
    if (!name.trim() || !prompt.trim() || confirmedModelId === null) return
    createMutation.mutate({
      name: name.trim(),
      prompt_template: prompt.trim(),
      model_id: confirmedModelId,
      scope: 'project_private',
    })
    setName('')
    setPrompt('')
    setShowForm(false)
  }

  const closeRunDialog = useCallback(() => {
    runGenerationRef.current += 1
    setRunTarget(null)
    runTargetRef.current = null
  }, [])

  const openRun = (template: ResearchTransformation) => {
    runGenerationRef.current += 1
    setIsResolvingRun(false)
    runTargetRef.current = template
    setRunTarget(template)
    setRunResult(null)
    setRunModelId(null)
    setRunSnapshot(null)
    setRunLanguage(null)
    setRunVariant('en')
    setBlockedReason(null)
    setStaleSourceCount(0)
  }

  /**
   * RWV2-12 派发：Confirm 时刻一次性解析并冻结 Scope（RFC §3 不变量 5/6）。
   *
   * - selected：快照 ids 透传；entire_project：分页枚举全部授权 id。
   * - 解析在 runGuarded 之前完成：外部模型 consent 确认前后不再二次
   *   解析（快照不漂移）；entire_project 空项目在入闸门前阻断。
   * - runSnapshot/runLanguage 在 operation 体内设置——operation 只在
   *   真正派发时执行（本地立即路径与 consent 确认路径均覆盖），consent
   *   取消则不设置（零副作用证据）。
   */
  const executeRun = async () => {
    const target = runTargetRef.current
    if (!target) return
    const generation = runGenerationRef.current
    const snapshot = getSnapshot()
    if (snapshot.mode === 'selected' && !validate(snapshot).valid) return
    setIsResolvingRun(true)
    setBlockedReason(null)
    setStaleSourceCount(0)
    let resolved: { sourceIds: string[]; noteIds: string[]; staleSourceCount: number } | null = null
    try {
      resolved = await resolveScopeSelection(projectId, snapshot)
    } catch (error) {
      // 陈旧代际（对话框已关闭/重开）不得写入新一代码对话框状态或弹 toast
      // （成功路径在下方有同款守卫）
      if (runGenerationRef.current !== generation) return
      // S2：空有效范围是 typed、可预期的阻断（不派发、不引导降级到
      // entire project）。分页失败仍是网关错误 → 通用失败 toast。
      if (error instanceof EmptyEffectiveScopeError) {
        setBlockedReason('empty_project')
      } else {
        toast({
          title: t('common.error'),
          description: t('research.workbench.actionFailed'),
          variant: 'destructive',
        })
      }
      return
    } finally {
      // 只有当前代执行流才允许复位解析标志（陈旧流不得清掉新流的标志）
      if (runGenerationRef.current === generation) {
        setIsResolvingRun(false)
      }
    }
    if (resolved === null) return
    // 对话框已关闭/重开同一模板：令牌失效 → 放弃派发（对象同一性比较可被
    // 重开击穿，令牌不依赖对象身份）
    if (runGenerationRef.current !== generation) return
    const { sourceIds, noteIds, staleSourceCount: resolvedStaleCount } = resolved
    // RWV2-35：双语 admin 模板按选择器变体语言（Confirm 时刻冻结）；
    // 单 prompt（project/legacy）按 content 检测（R3-D 语义）。
    const bilingual = target.bilingual === true
    const lang = bilingual ? runVariant : detectResponseLanguage(target.prompt_template)
    try {
      await runGuarded(
        async (modelId) => {
          // consent 注册/确认前置路径：对话框已关闭则零派发（B2 结构与
          // 实现双保险——即使外部模型 consent 已登记，此处令牌失效即中止）
          if (runGenerationRef.current !== generation) return
          setRunSnapshot(snapshot)
          setRunLanguage(lang)
          // S2：stale Source 可派发，但必须在真正派发时可见（后端用最后
          // 同步版本）。与 runSnapshot/runLanguage 同处设置——consent
          // 取消/未派发不留下警告。
          setStaleSourceCount(resolvedStaleCount)
          const result = await runMutation.mutateAsync({
            transformationId: target.transformation_id,
            sourceIds,
            noteIds,
            modelId,
            // RWV2-35：仅双语模板发送显式变体语言；单 prompt 不发
            // （服务端按 content 检测，legacy 语义不变）
            ...(bilingual ? { responseLanguage: runVariant } : {}),
          })
          setRunResult(result)
          setRunModelId(modelId)
          return true
        },
        // RWV2-42：consent 弹窗 Scope 行 = 本笔派发冻结快照（resolve 前
        // getSnapshot() 同一对象），与最终请求同源（K11）
        { scopeLabel: formatScopeLabel(snapshot, t) },
      )
    } catch {
      // run 失败已由 mutation onError toast；此处静默吸收避免双弹
    }
  }

  const items = data?.items ?? []

  // 对话框 Scope 摘要：派发后展示派发时快照；未派发展示 live 上下文
  const summarySnapshot = runSnapshot ?? {
    mode,
    sourceIds: selectedSourceIds,
    noteIds: selectedNoteIds,
  }
  const scopeInvalidSelected =
    mode === 'selected' && selectedSourceIds.length + selectedNoteIds.length === 0

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
            <div className="flex gap-2">
              <Button
                size="sm"
                onClick={submitCreate}
                disabled={createMutation.isPending || confirmedModelId === null}
                data-testid="transformation-create-submit"
              >
                {t('research.transformations.save')}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setShowForm(false)}>
                {t('research.notes.cancel')}
              </Button>
            </div>
            {/* RWV2-42：无 confirmed 模型时创建被禁用——显式原因（不静默禁用） */}
            {confirmedModelId === null && (
              <p
                className="text-xs text-muted-foreground"
                data-testid="transformation-create-requires-model"
              >
                {t('research.transformations.createRequiresModel')}
              </p>
            )}
          </CardContent>
        </Card>
      )}

      {isLoading && <p className="text-sm text-muted-foreground">{t('common.loading')}</p>}
      {isError && <p className="text-sm text-destructive">{t('research.workbench.loadFailed')}</p>}

      {!isLoading && !isError && items.length === 0 && (
        <p className="text-sm text-muted-foreground">{t('research.workbench.empty')}</p>
      )}

      <div className="space-y-2">
        {items.map((item) => {
          // RWV2-35：门控键 = bilingual（与 run 对话框/executeRun 一致）；
          // 现契约下双语行必为 admin_template，去掉 scope 合取防未来漂移
          const isBilingualTemplate = item.bilingual === true
          const scopeLabel = t(
            item.scope === 'admin_template'
              ? 'research.transformations.scopeAdmin'
              : 'research.transformations.scopePrivate',
          )
          return (
            <Card key={item.transformation_id}>
              <CardContent className="flex items-center justify-between gap-3 p-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-medium">{item.name}</p>
                    {isBilingualTemplate && (
                      <Badge variant="outline" className="shrink-0 text-[10px]">
                        {t('research.transformations.bilingual')}
                      </Badge>
                    )}
                  </div>
                  {isBilingualTemplate ? (
                    <>
                      <p className="mt-1 line-clamp-2 text-xs text-muted-foreground" data-testid="template-variant-zh">
                        <span className="mr-1 font-semibold">
                          {t('research.transformations.variantZh')}
                        </span>
                        <span>{item.prompt_template_zh}</span>
                      </p>
                      <p className="line-clamp-2 text-xs text-muted-foreground" data-testid="template-variant-en">
                        <span className="mr-1 font-semibold">
                          {t('research.transformations.variantEn')}
                        </span>
                        <span>{item.prompt_template_en ?? item.prompt_template}</span>
                      </p>
                    </>
                  ) : (
                    <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                      {item.prompt_template}
                    </p>
                  )}
                  <p className="mt-1 text-xs text-muted-foreground">
                    {isBilingualTemplate
                      ? `${t('research.transformations.createdWith', {
                          model: item.model_id ?? '—',
                        })} · ${scopeLabel}`
                      : `${item.model_id ?? '—'} · ${scopeLabel}`}
                  </p>
                </div>
                {!isAdminReadonly && (
                  <Button size="sm" variant="outline" onClick={() => openRun(item)}>
                    {t('research.transformations.run')}
                  </Button>
                )}
              </CardContent>
            </Card>
          )
        })}
      </div>

      {/* 运行对话框：只读 Scope 摘要 + Edit scope + 数据外发提示（根级） + 结果 */}
      <Dialog
        open={runTarget !== null}
        onOpenChange={(open) => {
          if (!open) closeRunDialog()
        }}
      >
        <DialogContent className="max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{t('research.transformations.run')}: {runTarget?.name}</DialogTitle>
            <DialogDescription>{t('research.transformations.runDescription')}</DialogDescription>
          </DialogHeader>

          {/* RWV2-12：只读 Scope 摘要（权威在 provider；本面板不写 Scope） */}
          <div className="space-y-1">
            <p className="text-xs font-medium text-muted-foreground">
              {t('research.transformations.scopeSummary')}
            </p>
            <p className="text-sm" data-testid="run-scope-summary">
              {summarySnapshot.mode === 'entire_project'
                ? t('research.layout.scope.entireProject')
                : t('research.layout.scope.selectedSummary', {
                    sources: summarySnapshot.sourceIds.length,
                    notes: summarySnapshot.noteIds.length,
                  })}
            </p>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                closeRunDialog()
                onEditScope?.()
              }}
              data-testid="run-edit-scope"
            >
              {t('research.transformations.editScope')}
            </Button>
          </div>

          {/* §6.6：本次运行模型由顶层 confirmed 全局模型决定；外部模型的外发
              确认由根级统一弹窗处理，本面板不再维护局部确认状态 */}
          <p className="text-xs text-muted-foreground" data-testid="run-model">
            {t('research.globalModel.label')}:{' '}
            {runModelId ?? confirmedModelId ?? '—'}
          </p>

          {/* RFC §4.2 / RWV2-35：双语 admin 模板 → 语言/变体选择器（默认
              en，Confirm 时刻随 runVariant 冻结并发送 response_language）；
              单 prompt（project/legacy）无选择器 → 派发时按 content 检测
              （R3-D：键 = bilingual，legacy admin 单 prompt 行同此路径） */}
          {runTarget?.bilingual === true ? (
            <div className="space-y-1">
              <div className="flex items-center gap-2" data-testid="run-language-select">
                <p className="text-xs font-medium text-muted-foreground">
                  {t('research.transformations.runLanguage')}
                </p>
                <Select
                  value={runVariant}
                  onValueChange={(value) => setRunVariant(value as 'zh' | 'en')}
                  // LOW-3：Scope 解析在途/派发中禁用选择器——派发语言在
                  // Confirm 时刻冻结，解析窗口内切换只改显示不改在途载荷
                  disabled={isResolvingRun || runMutation.isPending}
                >
                  <SelectTrigger aria-label="run-language-variant" className="h-8 w-36">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="en">{t('research.transformations.variantEn')}</SelectItem>
                    <SelectItem value="zh">{t('research.transformations.variantZh')}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {/* LOW-3：派发后回读实际冻结语言（双语分支——单 prompt 走下方
                  detect 行）；Consent 取消不派发则不显示 */}
              {runLanguage && (
                <p className="text-xs text-muted-foreground" data-testid="run-language-frozen">
                  {t('research.transformations.language')}: {runLanguage}
                </p>
              )}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground" data-testid="run-language">
              {t('research.transformations.language')}:{' '}
              {runLanguage ?? detectResponseLanguage(runTarget?.prompt_template ?? '')}
            </p>
          )}

          {staleSourceCount > 0 && (
            <p
              className="text-xs text-muted-foreground"
              role="status"
              data-testid="run-stale-sources-warning"
            >
              {t('research.transformations.staleSourcesWarning', { n: staleSourceCount })}
            </p>
          )}
          {blockedReason === 'empty_project' && (
            <p
              className="text-xs font-medium text-destructive"
              role="alert"
              data-testid="run-empty-project-blocked"
            >
              {t('research.transformations.emptyProjectBlocked')}
            </p>
          )}
          {scopeInvalidSelected && (
            <p
              className="text-xs font-medium text-destructive"
              role="alert"
              data-testid="run-empty-scope-blocked"
            >
              {t('research.transformations.emptyScopeBlocked')}
            </p>
          )}

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
            <Button size="sm" variant="outline" onClick={closeRunDialog}>
              {t('research.notes.cancel')}
            </Button>
            <Button
              size="sm"
              onClick={() => void executeRun()}
              disabled={
                !canExecute ||
                runMutation.isPending ||
                isResolvingRun ||
                scopeInvalidSelected ||
                blockedReason !== null
              }
              data-testid="transformation-run-confirm"
            >
              {t('research.transformations.confirmRun')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
