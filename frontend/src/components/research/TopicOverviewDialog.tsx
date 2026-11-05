'use client'

/**
 * Issue #1016（D1-G）§2.9：主题概览 Dialog（生成 / 回访 / 更新 / 引用 / 继续讨论）。
 *
 * 设计事实（与 WIRE_CONTRACT §4 冻结接缝一致）：
 * - 生成与更新都经既有根级 `runGuarded`（与原 Chat/Search 同一执行守卫；
 *   外部模型在 C-05 概览路径不可达，故 `confirmedModelIsExternal` 时禁用，
 *   不派发、不弹外发确认）。
 * - scope 唯一真源 = `useResearchScope().getSnapshot()`；请求由
 *   `useGenerateTopicOverview`（lib）经 `buildTopicOverviewRequest` 组装
 *   （含 `focus`、`source_scope`、`note_ids: []`，**不含** `query`）。
 * - 空 selected fail-closed（提示先选择资料），绝不扩大为 `all`；Note 不参与
 *   （`note_ids: []`）。
 * - 就绪态：四段（缺失 → 整篇 Markdown + 结构不完整提示）、声明范围 vs
 *   实际纳入证据、固定限制（按 `limitations` 码映射，未知码不崩溃）、
 *   canonical 引用（claim/身份/页；跳转复用 `resolveCitationSource` /
 *   `canJumpToCitation` / `onCitationJump` 既有链，禁用时用既有降级文案）。
 * - 受限 `visibility === "restricted"`：不渲染正文/引用/来源身份，不显示
 *   「无命中」式空态。
 * - 「继续讨论」只经既有 `editorHandle.setDraftText` 写当前会话草稿，不新增
 *   Chat/session wire；无 editorHandle 时不显示。
 * - 只提供生成/更新/关闭/打开来源/继续讨论；不提供保存/导出/重跑。
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { MarkdownRenderer } from '@/components/ui/markdown-renderer'
import { Textarea } from '@/components/ui/textarea'
import { useTranslation } from '@/lib/hooks/use-translation'
import { useResearchGlobalModel } from '@/lib/hooks/use-research-global-model'
import { useResearchSources } from '@/lib/hooks/use-research'
import {
  useGenerateTopicOverview,
  useResearchTopicOverview,
} from '@/lib/hooks/use-research-topic-overview'
import { formatScopeLabel, useResearchScope } from '@/lib/research/scope'
import type { C05RequestScope } from '@/lib/research/c05-request'
import {
  topicOverviewDiscussionText,
  topicOverviewSourceChanges,
} from '@/lib/research/topic-overview'
import type {
  TopicOverviewCitation,
  TopicOverviewWire,
} from '@/lib/research/topic-overview'
import { extractResearchErrorCode, userErrorMessageKey } from '@/lib/research/errors'
import { formatResearchTimestamp } from '@/lib/research/format'
import type { ResearchCitation, ResearchSource } from '@/lib/types/research'
import {
  canJumpToCitation,
  displayPage,
  resolveCitationCandidate,
  resolveCitationSource,
  type JumpDenyReason,
} from './citation-utils'

export interface TopicOverviewDialogProps {
  projectId: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onCitationJump: (sourceId: string, pageIdx: number | null) => void
  editorHandle?: { setDraftText: (text: string) => void } | null
  canExecute: boolean
  blockedHint?: string | null
  isAdminReadonly: boolean
  confirmedModelIsExternal: boolean
}

/** wire scope.mode → 模式标签（未知/缺失回落通用 Scope，不臆造）。 */
const SCOPE_MODE_KEYS: Record<string, string> = {
  all: 'research.topicOverview.scopeMode.all',
  selected: 'research.topicOverview.scopeMode.selected',
  single: 'research.topicOverview.scopeMode.single',
}

function scopeModeLabelKey(mode: string | null | undefined): string {
  if (mode === null || mode === undefined) return 'research.topicOverview.scopeMode.unknown'
  return SCOPE_MODE_KEYS[mode] ?? 'research.topicOverview.scopeMode.unknown'
}

/** wire `limitations` 码 → 固定文案（未知码不崩溃，回落带码的兜底行）。 */
const LIMITATION_KEYS: Record<string, string> = {
  full_text_not_read: 'research.topicOverview.limitations.fullTextNotRead',
  section_citation_mapping_not_verified:
    'research.topicOverview.limitations.sectionCitationMappingNotVerified',
  body_chunks_only: 'research.topicOverview.limitations.bodyChunksOnly',
  figures_not_interpreted: 'research.topicOverview.limitations.figuresNotInterpreted',
  supplementary_not_interpreted:
    'research.topicOverview.limitations.supplementaryNotInterpreted',
  table_evidence_included: 'research.topicOverview.limitations.tableEvidenceIncluded',
  figure_evidence_included: 'research.topicOverview.limitations.figureEvidenceIncluded',
  scope_bounded_retrieval: 'research.topicOverview.limitations.scopeBoundedRetrieval',
  source_coverage_partial: 'research.topicOverview.limitations.sourceCoveragePartial',
  scope_refs_truncated: 'research.topicOverview.limitations.scopeRefsTruncated',
  sections_incomplete: 'research.topicOverview.limitations.sectionsIncomplete',
  citations_degraded: 'research.topicOverview.limitations.citationsDegraded',
  content_restricted: 'research.topicOverview.limitations.contentRestricted',
}

const LIMITATION_UNKNOWN_KEY = 'research.topicOverview.limitations.unknown'

/** 引用跳转禁用原因 → **既有**降级文案（NORMATIVE 22；不新增措辞）。 */
const CITATION_DEGRADED_KEYS: Record<JumpDenyReason, string> = {
  source_unavailable: 'research.citation.degradedSource',
  version_mismatch: 'research.citation.degradedVersion',
  no_page: 'research.citation.degradedPage',
  page_missing: 'research.citation.degradedPage',
}

interface CitationJumpEvaluation {
  canJump: boolean
  sourceId: string | null
  pageIdx: number | null
  reason: JumpDenyReason | null
}

/**
 * 概览 wire citation → 跳转判定（四闸：来源可用/版本一致/有页码/页面存在）。
 *
 * 复用既有 `resolveCitationSource`/`canJumpToCitation` 链（NORMATIVE 22）。
 * wire 的 `source_id === null` 是服务端权威的「不可用/无镜像」结论——即便前端
 * 能猜测 mirror 也不得跳转；此时直接按 `source_unavailable` 禁用。
 */
function evaluateCitationJump(
  citation: TopicOverviewCitation,
  sources: readonly ResearchSource[] | undefined,
): CitationJumpEvaluation {
  if (citation.source_id === null) {
    return { canJump: false, sourceId: null, pageIdx: citation.page_idx, reason: 'source_unavailable' }
  }
  const asCitation = {
    ...citation,
    claim: citation.claim ?? '',
    doc_version: citation.doc_version.length > 0 ? citation.doc_version : null,
    chunk_id: citation.chunk_id.length > 0 ? citation.chunk_id : null,
  } as unknown as ResearchCitation
  const candidate = resolveCitationCandidate(sources, asCitation)
  const evaluation = canJumpToCitation(asCitation, candidate, undefined)
  if (!evaluation.canJump) {
    return {
      canJump: false,
      sourceId: null,
      pageIdx: citation.page_idx,
      reason: evaluation.reason,
    }
  }
  // 跳转目标解析必须用版本感知的 `resolveCitationSource`（不得用文档级候选）。
  const resolved = resolveCitationSource(sources, asCitation)
  const sourceId = resolved?.source_id ?? citation.source_id
  if (sourceId === null) {
    return { canJump: false, sourceId: null, pageIdx: citation.page_idx, reason: 'source_unavailable' }
  }
  return { canJump: true, sourceId, pageIdx: citation.page_idx, reason: null }
}

/** 409 同码重放提示：后端要求**换新键**重试（不自动重试）。 */
function retryWithOriginalIdempotencyKey(error: unknown): boolean {
  if (error === null || typeof error !== 'object') return false
  const detail = (error as { response?: { data?: { detail?: unknown } } }).response?.data?.detail
  if (detail === null || typeof detail !== 'object' || Array.isArray(detail)) return false
  return (
    (detail as { retry_with_original_idempotency_key?: unknown })
      .retry_with_original_idempotency_key === true
  )
}

function readCoverageCount(coverage: unknown, key: 'trimmed' | 'missing'): number | null {
  if (coverage === null || typeof coverage !== 'object') return null
  const value = (coverage as Record<string, unknown>)[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

interface SubmitError {
  code: string | null
  retryWithNewKey: boolean
  phase: 'generate' | 'update'
}

export function TopicOverviewDialog({
  projectId,
  open,
  onOpenChange,
  onCitationJump,
  editorHandle = null,
  canExecute,
  blockedHint = null,
  isAdminReadonly,
  confirmedModelIsExternal,
}: TopicOverviewDialogProps) {
  const { t } = useTranslation()
  // 执行守卫与模型/scope 的唯一来源（与 Chat/Search 同一条链）。
  const { confirmedModelId, runGuarded } = useResearchGlobalModel()
  const { getSnapshot } = useResearchScope()
  const overviewQuery = useResearchTopicOverview(projectId, {
    enabled: open && projectId.length > 0,
  })
  const generate = useGenerateTopicOverview(projectId)
  const sourcesQuery = useResearchSources(projectId)
  const sources = sourcesQuery.data?.items

  const [focus, setFocus] = useState('')
  const [showFocusForm, setShowFocusForm] = useState(false)
  const [submitError, setSubmitError] = useState<SubmitError | null>(null)
  const [staleNotice, setStaleNotice] = useState(false)

  const resetGenerate = generate.reset
  useEffect(() => {
    if (open) return
    // 关闭即复原为「读面」语义：下次打开先看服务端当前概览。
    setFocus('')
    setShowFocusForm(false)
    setSubmitError(null)
    setStaleNotice(false)
    resetGenerate()
  }, [open, resetGenerate])

  // 展示源（LOW-A2）：**GET 权威优先**——生成成功后若来源被撤权/其他标签页
  // 更新，读面（含现行权限投影）必须覆盖本次 POST 结果，不能继续显示旧
  // ready 正文；仅当读面尚无数据（如刚生成、GET 尚未回）时回退本次结果。
  const wire: TopicOverviewWire | null =
    overviewQuery.data ?? generate.data ?? null
  const snapshot = getSnapshot()
  // Note 不参与概览；selected 下没有 source 即 fail-closed（不扩大为 all）。
  const emptySelected = snapshot.mode === 'selected' && snapshot.sourceIds.length === 0

  /** 禁用原因（按钮禁用 + 内联说明；后端 403/422 仍是最终权威）。 */
  const blockedReasonText = useMemo<string | null>(() => {
    if (isAdminReadonly) {
      return blockedHint !== null && blockedHint.length > 0
        ? blockedHint
        : t('research.topicOverview.dialog.adminReadonly')
    }
    if (!canExecute) {
      return blockedHint !== null && blockedHint.length > 0
        ? blockedHint
        : t('research.topicOverview.dialog.blocked')
    }
    if (confirmedModelIsExternal) {
      return t('research.topicOverview.dialog.externalModelBlocked')
    }
    if (emptySelected) return t('research.topicOverview.dialog.emptyScope')
    return null
  }, [
    blockedHint,
    canExecute,
    confirmedModelIsExternal,
    emptySelected,
    isAdminReadonly,
    t,
  ])

  const submit = useCallback(
    async (phase: 'generate' | 'update'): Promise<void> => {
      if (blockedReasonText !== null || confirmedModelId === null) return
      const current = getSnapshot()
      if (current.mode === 'selected' && current.sourceIds.length === 0) {
        // fail-closed：空 selected 不发请求、不扩大为 all。
        setSubmitError({ code: null, retryWithNewKey: false, phase })
        return
      }
      const scope: C05RequestScope = {
        mode: current.mode,
        sourceIds: [...current.sourceIds],
        // Note 不参与概览（NORMATIVE 3）：note_ids 固定 []，由 lib builder 写入。
        noteIds: [],
        singleSourceId: current.singleSourceId,
      }
      setSubmitError(null)
      setStaleNotice(false)
      try {
        const result = await runGuarded(
          (modelId) => generate.mutateAsync({ focus: focus.trim(), modelId, scope }),
          { scopeLabel: formatScopeLabel(current, t) },
        )
        // undefined = 守卫未放行（consent 登记/取消/无模型）：不当作失败。
        if (result === undefined) return
        setStaleNotice(result.warnings.includes('stale_generation_ignored'))
        setShowFocusForm(false)
        setFocus('')
      } catch (error) {
        setSubmitError({
          code: extractResearchErrorCode(error),
          retryWithNewKey: retryWithOriginalIdempotencyKey(error),
          phase,
        })
      }
    },
    [blockedReasonText, confirmedModelId, focus, generate, getSnapshot, runGuarded, t],
  )

  const submitErrorText =
    submitError === null ? null : t(userErrorMessageKey(submitError.code))
  const showSubmitForm = !isAdminReadonly && (wire === null || showFocusForm)
  const submitDisabled = blockedReasonText !== null || generate.isPending
  const overviewErrorText = overviewQuery.isError
    ? t(userErrorMessageKey(extractResearchErrorCode(overviewQuery.error)))
    : null

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="flex max-h-[85vh] w-full max-w-3xl flex-col gap-0 p-0"
        data-testid="topic-overview-dialog"
      >
        <DialogHeader className="border-b px-4 py-3">
          <DialogTitle>{t('research.topicOverview.dialog.title')}</DialogTitle>
          <DialogDescription>
            {t('research.topicOverview.dialog.description')}
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3">
          {overviewQuery.isLoading && wire === null && (
            <p className="text-sm text-muted-foreground" data-testid="topic-overview-loading">
              {t('common.loading')}
            </p>
          )}

          {overviewErrorText !== null && wire === null && (
            <div className="space-y-2" data-testid="topic-overview-error">
              <Alert variant="destructive">
                <AlertDescription>{overviewErrorText}</AlertDescription>
              </Alert>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => void overviewQuery.refetch()}
                data-testid="topic-overview-error-retry"
              >
                {t('research.retry')}
              </Button>
            </div>
          )}

          {wire === null && !overviewQuery.isLoading && !overviewQuery.isError && (
            <p className="text-sm text-muted-foreground" data-testid="topic-overview-empty">
              {t('research.topicOverview.dialog.empty')}
            </p>
          )}

          {wire !== null && (
            <TopicOverviewBody
              wire={wire}
              sources={sources}
              sourcesReady={sourcesQuery.isSuccess}
              onCitationJump={onCitationJump}
              discussion={
                editorHandle !== null
                  ? () =>
                      editorHandle.setDraftText(
                        topicOverviewDiscussionText(
                          wire,
                          t('research.topicOverview.dialog.continueDraft'),
                        ),
                      )
                  : null
              }
            />
          )}

          {showSubmitForm && (
            <section className="space-y-2 border-t pt-3" data-testid="topic-overview-form">
              <div className="space-y-1">
                <Label htmlFor="topic-overview-focus">
                  {t('research.topicOverview.dialog.focusLabel')}
                </Label>
                <Textarea
                  id="topic-overview-focus"
                  data-testid="topic-overview-focus"
                  value={focus}
                  placeholder={t('research.topicOverview.dialog.focusPlaceholder')}
                  rows={2}
                  onChange={(event) => setFocus(event.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  {t('research.topicOverview.dialog.focusHint')}
                </p>
              </div>
              {blockedReasonText !== null && (
                <p
                  className="text-xs text-muted-foreground"
                  role="alert"
                  data-testid="topic-overview-blocked"
                >
                  {blockedReasonText}
                </p>
              )}
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  size="sm"
                  disabled={submitDisabled}
                  onClick={() => void submit(wire === null ? 'generate' : 'update')}
                  data-testid="topic-overview-submit"
                >
                  {generate.isPending
                    ? t('research.topicOverview.dialog.generating')
                    : wire === null
                      ? t('research.topicOverview.dialog.generate')
                      : t('research.topicOverview.dialog.update')}
                </Button>
                {wire !== null && (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setShowFocusForm(false)
                      setFocus('')
                    }}
                    data-testid="topic-overview-cancel-update"
                  >
                    {t('common.cancel')}
                  </Button>
                )}
              </div>
            </section>
          )}

          {isAdminReadonly && (
            <p
              className="text-xs text-muted-foreground"
              data-testid="topic-overview-admin-readonly"
            >
              {blockedReasonText ?? t('research.topicOverview.dialog.adminReadonly')}
            </p>
          )}

          {submitError !== null && submitErrorText !== null && (
            <div className="space-y-2" data-testid="topic-overview-submit-error" role="alert">
              <Alert variant="destructive">
                <AlertDescription>{submitErrorText}</AlertDescription>
              </Alert>
              {submitError.phase === 'update' &&
                submitError.code === 'topic_overview_store_unavailable' && (
                  <p className="text-xs text-muted-foreground" data-testid="topic-overview-write-after-hint">
                    {t('research.topicOverview.dialog.refreshToConfirm')}
                  </p>
                )}
              {submitError.retryWithNewKey && (
                <p className="text-xs text-muted-foreground" data-testid="topic-overview-new-key-hint">
                  {t('research.topicOverview.dialog.retryWithNewKey')}
                </p>
              )}
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => void submit(submitError.phase)}
                data-testid="topic-overview-submit-retry"
              >
                {t('research.retry')}
              </Button>
            </div>
          )}

          {staleNotice && (
            <p
              className="text-xs text-muted-foreground"
              role="status"
              data-testid="topic-overview-stale-notice"
            >
              {t('research.topicOverview.dialog.staleGenerationIgnored')}
            </p>
          )}

          {wire !== null && !isAdminReadonly && !showFocusForm && (
            <div className="flex flex-wrap gap-2 border-t pt-3">
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => setShowFocusForm(true)}
                data-testid="topic-overview-update"
              >
                {t('research.topicOverview.dialog.update')}
              </Button>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

/** 概览正文（四段 / 降级 Markdown / 范围与覆盖 / 限制 / 引用）。 */
function TopicOverviewBody({
  wire,
  sources,
  sourcesReady,
  onCitationJump,
  discussion,
}: {
  wire: TopicOverviewWire
  sources: readonly ResearchSource[] | undefined
  /** 当前资料查询是否成功（MEDIUM-A2：loading/error 不做变化比较）。 */
  sourcesReady: boolean
  onCitationJump: (sourceId: string, pageIdx: number | null) => void
  discussion: (() => void) | null
}) {
  const { t } = useTranslation()
  const restricted = wire.visibility === 'restricted'
  const generatedAt =
    wire.generated_at === null
      ? null
      : formatResearchTimestamp(wire.generated_at) ?? wire.generated_at
  const capturedAt =
    wire.generation_created_at === null
      ? null
      : formatResearchTimestamp(wire.generation_created_at) ??
        wire.generation_created_at
  const scope = wire.scope
  const processing = wire.processing
  const includedSources = processing?.included_sources ?? []
  const includedChunkCount = includedSources.reduce(
    (total, source) => total + source.chunk_count,
    0,
  )
  const coverageTrimmed = readCoverageCount(processing?.coverage ?? null, 'trimmed')
  const coverageMissing = readCoverageCount(processing?.coverage ?? null, 'missing')
  const resolvedMode = processing?.resolved_mode ?? null
  const modelId = wire.model?.model_id ?? null

  // MEDIUM-1（计划 §2.9 :491）：Dialog 就绪态与入口一致地提示「资料变化」。
  // 规则：仅 `visibility==='ready'` 且有可比较的范围来源时计算/渲染；restricted
  // 的 `scope.sources=[]` 按设计不参与比较（否则当前全部资料会被误算成 added）。
  const sourceChanges = useMemo(() => {
    if (wire.visibility !== 'ready') return null
    const scope = wire.scope
    if (scope === null) return null
    // MEDIUM-A2：loading/error/无数据时不比较（否则 scope 来源会被误算 retired）。
    if (!sourcesReady) return null
    // 成功但列表为空同样不比较（空列表不能证明范围来源全部退役）。
    if ((sources ?? []).length === 0) return null
    // LOW-A1：refs_truncated 时 scope.sources 是截断子集，比较会误报 added。
    if (scope.refs_truncated) return null
    const scopeSources = scope.sources
    if (scopeSources.length === 0) return null
    return topicOverviewSourceChanges(
      scopeSources.map((item) => ({
        document_id: item.document_id,
        document_version: item.document_version,
      })),
      (sources ?? []).map((item) => ({
        document_id: item.document_id,
        document_version: item.document_version,
      })),
    )
  }, [sources, sourcesReady, wire])
  const hasSourceChanges =
    sourceChanges !== null &&
    sourceChanges.added + sourceChanges.versionChanged + sourceChanges.retired > 0

  if (restricted) {
    return (
      <div className="space-y-3">
        <OverviewMeta generatedAt={generatedAt} capturedAt={capturedAt} />
        <div
          className="space-y-1 rounded-md border border-border/60 bg-muted/20 px-3 py-2"
          data-testid="topic-overview-restricted"
        >
          <h4 className="text-sm font-medium">
            {t('research.topicOverview.restricted.title')}
          </h4>
          <p className="text-xs text-muted-foreground">
            {t('research.topicOverview.restricted.description')}
          </p>
        </div>
        <ModelLine modelId={modelId} />
        {discussion !== null && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={discussion}
            data-testid="topic-overview-discuss"
          >
            {t('research.topicOverview.dialog.discuss')}
          </Button>
        )}
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <OverviewMeta generatedAt={generatedAt} capturedAt={capturedAt} />
      {hasSourceChanges && sourceChanges !== null && (
        <p
          className="text-xs text-muted-foreground"
          role="status"
          data-testid="topic-overview-dialog-changes"
        >
          {t('research.topicOverview.dialog.changesNotice', {
            date: capturedAt ?? t('research.searchHistory.notRecorded'),
            added: sourceChanges.added,
            versionChanged: sourceChanges.versionChanged,
            retired: sourceChanges.retired,
          })}
        </p>
      )}
      {wire.focus !== null && wire.focus.length > 0 && (
        <p className="text-xs text-muted-foreground" data-testid="topic-overview-focus-value">
          {t('research.topicOverview.dialog.focusValue', { focus: wire.focus })}
        </p>
      )}

      {wire.sections === null ? (
        wire.content_markdown !== null && (
          <div className="space-y-2" data-testid="topic-overview-markdown">
            <Alert>
              <AlertDescription>
                {t('research.topicOverview.sections.incomplete')}
              </AlertDescription>
            </Alert>
            <MarkdownRenderer>{wire.content_markdown}</MarkdownRenderer>
          </div>
        )
      ) : (
        <div className="space-y-3" data-testid="topic-overview-sections">
          {wire.sections.main_questions !== null && (
            <section data-testid="topic-overview-section-main-questions">
              <h4 className="text-sm font-medium">
                {t('research.topicOverview.sections.mainQuestions')}
              </h4>
              <MarkdownRenderer>{wire.sections.main_questions}</MarkdownRenderer>
            </section>
          )}
          {wire.sections.findings !== null && (
            <section data-testid="topic-overview-section-findings">
              <h4 className="text-sm font-medium">
                {t('research.topicOverview.sections.findings')}
              </h4>
              <MarkdownRenderer>{wire.sections.findings}</MarkdownRenderer>
            </section>
          )}
          {wire.sections.disagreements !== null && (
            <section data-testid="topic-overview-section-disagreements">
              <h4 className="text-sm font-medium">
                {t('research.topicOverview.sections.disagreements')}
              </h4>
              <MarkdownRenderer>{wire.sections.disagreements}</MarkdownRenderer>
            </section>
          )}
          {wire.sections.reading_priorities !== null && (
            <section data-testid="topic-overview-section-reading-priorities">
              <h4 className="text-sm font-medium">
                {t('research.topicOverview.sections.readingPriorities')}
              </h4>
              <MarkdownRenderer>{wire.sections.reading_priorities}</MarkdownRenderer>
            </section>
          )}
        </div>
      )}

      {scope !== null && (
        <section className="space-y-1" data-testid="topic-overview-scope">
          <h4 className="text-sm font-medium">
            {t('research.topicOverview.scope.heading')}
          </h4>
          <p className="text-xs text-muted-foreground" data-testid="topic-overview-scope-declared">
            {t('research.topicOverview.scope.declared', {
              mode: t(scopeModeLabelKey(scope.mode)),
              count: scope.source_count,
            })}
          </p>
          <p className="text-xs text-muted-foreground" data-testid="topic-overview-scope-actual">
            {t('research.topicOverview.scope.actual', {
              sources: includedSources.length,
              chunks: includedChunkCount,
            })}
          </p>
          {resolvedMode !== null && (
            <p className="text-xs text-muted-foreground" data-testid="topic-overview-scope-resolved">
              {t('research.topicOverview.scope.resolvedMode', {
                mode: resolvedMode,
              })}
            </p>
          )}
          {coverageTrimmed !== null && coverageMissing !== null && (
            <p className="text-xs text-muted-foreground" data-testid="topic-overview-scope-coverage">
              {t('research.topicOverview.scope.coverage', {
                trimmed: coverageTrimmed,
                missing: coverageMissing,
              })}
            </p>
          )}
          <p className="text-xs text-muted-foreground" data-testid="topic-overview-scope-honesty">
            {t('research.topicOverview.scope.notAllRead')}
          </p>
        </section>
      )}

      {wire.limitations.length > 0 && (
        <section data-testid="topic-overview-limitations">
          <h4 className="text-sm font-medium">
            {t('research.topicOverview.limitations.heading')}
          </h4>
          <ul className="list-disc space-y-1 pl-5 text-xs text-muted-foreground">
            {wire.limitations.map((code) => (
              <li key={code} data-testid={`topic-overview-limitation-${code}`}>
                {LIMITATION_KEYS[code] !== undefined
                  ? t(LIMITATION_KEYS[code])
                  : t(LIMITATION_UNKNOWN_KEY, { code })}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="space-y-2" data-testid="topic-overview-citations">
        <h4 className="text-sm font-medium">
          {t('research.topicOverview.citations.heading')}
        </h4>
        {wire.citations.length === 0 ? (
          <p className="text-xs text-muted-foreground" data-testid="topic-overview-citations-empty">
            {t('research.topicOverview.citations.empty')}
          </p>
        ) : (
          <ul className="space-y-2">
            {wire.citations.map((citation, index) => (
              <CitationRow
                key={`${citation.citation_id ?? 'x'}:${index}`}
                citation={citation}
                index={index}
                sources={sources}
                onCitationJump={onCitationJump}
              />
            ))}
          </ul>
        )}
      </section>

      <ModelLine modelId={modelId} />

      {discussion !== null && (
        <div className="border-t pt-3">
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={discussion}
            data-testid="topic-overview-discuss"
          >
            {t('research.topicOverview.dialog.discuss')}
          </Button>
        </div>
      )}
    </div>
  )
}

function OverviewMeta({
  generatedAt,
  capturedAt,
}: {
  generatedAt: string | null
  capturedAt: string | null
}) {
  const { t } = useTranslation()
  return (
    <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
      <span data-testid="topic-overview-generated">
        {t('research.topicOverview.generatedAt', {
          date: generatedAt ?? t('research.searchHistory.notRecorded'),
        })}
      </span>
      <span data-testid="topic-overview-captured">
        {t('research.topicOverview.capturedAt', {
          date: capturedAt ?? t('research.searchHistory.notRecorded'),
        })}
      </span>
    </div>
  )
}

function ModelLine({ modelId }: { modelId: string | null }) {
  const { t } = useTranslation()
  return (
    <p className="text-xs text-muted-foreground" data-testid="topic-overview-model">
      {modelId !== null && modelId.length > 0
        ? t('research.topicOverview.model', { model: modelId })
        : t('research.topicOverview.modelNotRecorded')}
    </p>
  )
}

function CitationRow({
  citation,
  index,
  sources,
  onCitationJump,
}: {
  citation: TopicOverviewCitation
  index: number
  sources: readonly ResearchSource[] | undefined
  onCitationJump: (sourceId: string, pageIdx: number | null) => void
}) {
  const { t } = useTranslation()
  const evaluation = evaluateCitationJump(citation, sources)
  const page = displayPage(citation.page_idx)
  return (
    <li
      className="space-y-1 rounded-md border border-border/60 px-3 py-2"
      data-testid={`topic-overview-citation-${index}`}
    >
      {citation.claim !== null && <p className="text-sm">{citation.claim}</p>}
      <p className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
        <span data-testid={`topic-overview-citation-doc-${index}`}>
          {citation.doc_id}
        </span>
        <span data-testid={`topic-overview-citation-version-${index}`}>
          {citation.doc_version.length > 0
            ? t('research.topicOverview.citations.version', {
                version: citation.doc_version,
              })
            : t('research.topicOverview.citations.versionUnknown')}
        </span>
        {page !== null && (
          <span data-testid={`topic-overview-citation-page-${index}`}>
            {t('research.citation.page', { page })}
          </span>
        )}
      </p>
      {evaluation.canJump && evaluation.sourceId !== null ? (
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() =>
            onCitationJump(evaluation.sourceId as string, citation.page_idx)
          }
          data-testid={`topic-overview-citation-jump-${index}`}
        >
          {t('research.citation.jump')}
        </Button>
      ) : (
        <p
          className="text-xs text-muted-foreground"
          data-testid={`topic-overview-citation-degraded-${index}`}
        >
          {t(
            CITATION_DEGRADED_KEYS[evaluation.reason ?? 'source_unavailable'],
          )}
        </p>
      )}
    </li>
  )
}
