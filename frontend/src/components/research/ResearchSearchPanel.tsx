'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from '@/lib/hooks/use-translation'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { MarkdownRenderer } from '@/components/ui/markdown-renderer'
import { ResearchCitationList } from './ResearchCitationList'
import { ResultActions } from './ResultActions'
import {
  SearchContextSelector,
  CONTEXT_LEVELS,
} from './SearchContextSelector'
import { fetchContextPreview, newIdempotencyKey, searchV1 } from '@/lib/research/api'
import { researchModelBlockedHint, useResearchGlobalModel } from '@/lib/hooks/use-research-global-model'
import { formatScopeLabel, useResearchScope } from '@/lib/research/scope'
import { extractResearchErrorCode, userErrorMessageKey } from '@/lib/research/errors'
import type {
  ResearchContextLevel,
  ResearchContextPreview,
  ResearchSearchResponse,
} from '@/lib/research/types'

/**
 * Research Search 面板（UI-03，REQ-ENG-04，契约 §8.1；Issue #200 Phase 2b
 * §14.3 增强；Issue #243 GMOD-FE-01 §6.3 全局模型改造）：
 * - **不再是模型入口**：模型来自 Research 顶层 confirmed 全局模型，本面板
 *   只保留 Search 局部 `focused/document/workspace` 档位（不变量 1）；
 * - 局部档位初始值取自服务端 `default_context_level`，但用户可在本次搜索
 *   前使用尚未保存的档位（局部选择 = 显示什么就执行什么）；
 * - 保存档位只 PATCH `default_context_level`，不动顶层模型（不变量 8）；
 * - 当前模型的 `interactive_context_levels` 不支持已选档位时，本地切到
 *   `focused` 并明确提示，**不静默写回服务端**；
 * - Preview 与执行都通过顶层 `runGuarded`：发送 confirmed 模型快照 + 本次
 *   Search 档位快照；外部模型未经确认时不会发起搜索（不变量 9）；
 * - v1 按 HTTP status 分支 direct/background；后台受理展示排队卡片；
 * - 不实现 A/B、shadow call、自动 fallback 或 API Key 输入框。
 */

interface BackgroundNotice {
  generationId: string
  jobId: string | null
}

/** 后端在 dispatch 侧判定授权失效的错误码（§9.2 第 4 步）。 */
const CONSENT_ERROR_CODES = [
  'consent_required',
  'consent_revoked',
  'consent_scope_changed',
  'policy_denied',
]

export function ResearchSearchPanel({
  projectId,
  active = true,
  onContinueResearch,
  onViewInsight,
  onViewNote,
}: {
  projectId: string
  /**
   * RWV2-40：面板是否处于可见且激活的主动作。隐藏（Source focus / 切到
   * 其它动作）时停止 Context Preview 的 debounce 与新请求、清空临时
   * preview；重新激活后按当前输入重新计算。正式提交的 Search、Chat SSE
   * 与 Jobs 轮询不受影响（不变量：隐藏 ≠ 取消）。
   */
  active?: boolean
  /** RWV2-23（AC4）：Continue research —— 打开 Chat 并预填**派发时** query */
  onContinueResearch?: (text: string) => void
  /** RWV2-23（AC3）：保存成功后跳转 Results/Insights 或 Materials/Notes */
  onViewInsight?: (insightId: string) => void
  onViewNote?: (noteId: string) => void
}) {
  const { t } = useTranslation()
  const {
    confirmedModelId,
    confirmedModel,
    searchContextDefault,
    saveSearchContext,
    canExecute,
    blockedReason,
    needsConsent,
    isSavingModel,
    invalidateConsent,
    runGuarded,
  } = useResearchGlobalModel()
  // RWV2-11（K7）：Scope 真源唯一——本面板不再持有/接收独立选择状态
  const { mode, selectedSourceIds, selectedNoteIds, getSnapshot } = useResearchScope()

  const [query, setQuery] = useState('')
  const [result, setResult] = useState<ResearchSearchResponse | null>(null)
  const [background, setBackground] = useState<BackgroundNotice | null>(null)
  const [loading, setLoading] = useState(false)
  /** RWV2-42：结构化错误——code 驱动主文案映射（AC8），message 仅次级诊断 */
  interface SearchError {
    code: string | null
    message: string
    /** 来源：执行搜索（默认）vs 保存 context 档位（引导文案不适用） */
    phase?: 'search' | 'context'
  }
  const [error, setError] = useState<SearchError | null>(null)
  const [savingContext, setSavingContext] = useState(false)

  // 局部档位：初始取服务端默认值；用户手动改过之后不再被服务端值覆盖
  const [selectedLevel, setSelectedLevel] =
    useState<ResearchContextLevel>('focused')
  const [adjustedFrom, setAdjustedFrom] = useState<ResearchContextLevel | null>(null)
  const interactedRef = useRef(false)
  // RWV2-23（R3-4）：Continue research 预填**派发时** query 快照——用户在
  // 结果返回后可能已改写输入框，不得用当前 composer 文本预填。
  const lastExecutedQueryRef = useRef('')

  // Context Preview（§9.1 只读预判；发送前提示）
  const [preview, setPreview] = useState<ResearchContextPreview | null>(null)

  // §7.2 幂等键：同一逻辑提交（同输入、含网络层失败后的立即重试）复用同键
  // 防双跑；成功受理、服务端已给确定性结局、或输入变化时重置为新执行。
  const idempotencyKeyRef = useRef<string | null>(null)
  const keyInputsRef = useRef<string>('')

  // 稳定引用：作为多个 effect 的依赖，避免每次渲染都触发收敛逻辑
  const supportedLevels = useMemo(
    () => confirmedModel?.interactive_context_levels ?? [...CONTEXT_LEVELS],
    [confirmedModel],
  )

  // 服务端默认值到达后回显（用户未手动改选时）。项目上下文热切换时组件不
  // 重挂载，重置手选守卫允许新项目偏好回显（沿用 Issue #200 复审 R3）。
  useEffect(() => {
    interactedRef.current = false
  }, [projectId])

  useEffect(() => {
    if (interactedRef.current) return
    setSelectedLevel(searchContextDefault)
  }, [searchContextDefault])

  // 切换模型时清掉上一次的收敛提示（声明顺序在前：先清再判，避免把新
  // 模型的收敛提示误清掉）
  useEffect(() => {
    setAdjustedFrom(null)
  }, [confirmedModelId])

  // §6.3：模型能力不支持已选档位时本地收敛到 focused 并提示，不写回服务端
  useEffect(() => {
    if (confirmedModelId === null) return
    if (supportedLevels.includes(selectedLevel)) return
    const fallback = supportedLevels.includes('focused')
      ? 'focused'
      : (supportedLevels[0] ?? 'focused')
    setAdjustedFrom(selectedLevel)
    setSelectedLevel(fallback)
  }, [confirmedModelId, selectedLevel, supportedLevels])

  useEffect(() => {
    const trimmed = query.trim()
    // RWV2-40：inactive（隐藏/非主动作）时不发起 Context Preview——
    // 清除 debounce、清空临时 preview、不启动新请求；重新激活后再算。
    // 正式 Search 执行走 executeSearch（run 回调），不因隐藏而取消。
    if (!active || !trimmed || confirmedModelId === null) {
      setPreview(null)
      return
    }
    let cancelled = false
    const timer = setTimeout(() => {
      void fetchContextPreview(projectId, {
        context_level: selectedLevel,
        source_ids: selectedSourceIds,
        note_ids: selectedNoteIds,
        question: trimmed,
        // §6.7：新正式前端 required，始终传 confirmed 全局模型
        model_id: confirmedModelId,
      })
        .then((value) => {
          if (!cancelled) setPreview(value)
        })
        .catch(() => {
          if (!cancelled) setPreview(null)
        })
    }, 400)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [active, query, projectId, selectedLevel, selectedSourceIds, selectedNoteIds, confirmedModelId])

  const handleSaveContext = useCallback(
    async (level: ResearchContextLevel) => {
      setSavingContext(true)
      try {
        // 只 PATCH default_context_level——保存 Search 上下文不改顶层模型
        await saveSearchContext(level)
        interactedRef.current = false
        setError(null)
      } catch (err) {
        setError({
          code: null,
          message: err instanceof Error ? err.message : String(err),
          phase: 'context',
        })
      } finally {
        setSavingContext(false)
      }
    },
    [saveSearchContext],
  )

  const executeSearch = useCallback(
    async (
      trimmed: string,
      modelId: string,
      level: ResearchContextLevel,
      sourceIds: string[],
      noteIds: string[],
    ) => {
      setLoading(true)
      setError(null)
      setResult(null)
      setBackground(null)
      // 同一逻辑提交（同输入）复用幂等键；输入变化即视为新执行（§7.2：
      // 终态失败后需新 key 才能发起新执行）
      const signature = JSON.stringify([trimmed, modelId, level, sourceIds, noteIds])
      if (!idempotencyKeyRef.current || keyInputsRef.current !== signature) {
        idempotencyKeyRef.current = newIdempotencyKey()
        keyInputsRef.current = signature
      }
      try {
        const outcome = await searchV1(
          projectId,
          {
            query: trimmed,
            source_ids: sourceIds,
            note_ids: noteIds,
            mode: 'auto',
            model_id: modelId,
            context_level: level,
          },
          { idempotencyKey: idempotencyKeyRef.current },
        )
        idempotencyKeyRef.current = null
        keyInputsRef.current = ''
        if (outcome.kind === 'direct') {
          lastExecutedQueryRef.current = trimmed
          setResult(outcome.result)
        } else {
          setBackground({
            generationId: outcome.generation_id,
            jobId: outcome.job_id,
          })
        }
      } catch (err) {
        // 网络层错误（无 response，结果真未知）保留同键防双跑；
        // 服务端已给确定性结局（有 response）→ 重置允许新执行
        const hasServerResponse = !!(err as { response?: unknown } | null)?.response
        const detailCode = extractResearchErrorCode(err)
        if (hasServerResponse) {
          idempotencyKeyRef.current = null
          keyInputsRef.current = ''
          // 后端 dispatch gate 判定授权失效 → 让 consent 重新生效判定，
          // 下一次执行由根级 guard 重新弹确认；不在此处自行重试或改模型。
          if (detailCode !== null && CONSENT_ERROR_CODES.includes(detailCode)) {
            invalidateConsent()
          }
        }
        // RWV2-42（AC8）：raw code/消息不作主消息——code 驱动映射主文案，
        // 原文仅次级诊断行
        setError({
          code: detailCode,
          message: err instanceof Error ? err.message : String(err),
        })
      } finally {
        setLoading(false)
      }
    },
    [invalidateConsent, projectId],
  )

  const run = useCallback(() => {
    const trimmed = query.trim()
    if (!trimmed || loading) return
    // RWV2-11（K1/K11）：派发时刻冻结不可变 Scope 快照——模型/档位/Scope
    // 三快照一并进入 runGuarded 登记与最终请求；确认被推迟时不得采用
    // 确认后的新值（不变量 4），consent 弹窗摘要与最终请求同源（K5）。
    const scopeSnapshot = getSnapshot()
    const levelSnapshot = selectedLevel
    const sourceSnapshot = [...scopeSnapshot.sourceIds]
    const noteSnapshot = [...scopeSnapshot.noteIds]
    void runGuarded(
      (modelId) =>
        executeSearch(trimmed, modelId, levelSnapshot, sourceSnapshot, noteSnapshot),
      { scopeLabel: formatScopeLabel(scopeSnapshot, t) },
    )
  }, [
    executeSearch,
    getSnapshot,
    loading,
    query,
    runGuarded,
    selectedLevel,
    t,
  ])

  // RWV2-11（K13）：`document` 档位依赖显式 Source 选择；entire_project 下空
  // ID 后端必 422（runner.py document context requires sources）。
  // P1-1：收敛使用**独立的 scope 归因提示**（documentLevelAdjusted），不写入
  // adjustedFrom——后者驱动「模型能力」横幅，避免把 scope 收敛错误归因于模型
  // 且 EP→selected 切换后残留谎称模型不支持。
  // P2-⑥：仅当模型本身支持 document 时收敛；不支持时交由模型能力 effect
  // 接管清除（防两 effect 互相回弹死循环）。
  const [documentLevelAdjusted, setDocumentLevelAdjusted] = useState(false)
  useEffect(() => {
    if (mode !== 'entire_project') setDocumentLevelAdjusted(false)
  }, [mode])
  // P3-1：模型切换时清除 scope 归因提示（能力 effect 可能主动挪档位）
  useEffect(() => {
    setDocumentLevelAdjusted(false)
  }, [confirmedModelId])

  useEffect(() => {
    if (
      mode === 'entire_project' &&
      selectedLevel === 'document' &&
      // P2-⑥：收敛前提是「document 受支持且目标 focused 受支持」——缺一
      // 则由模型能力 effect 全权接管清除（防 K13↔能力 effect 回弹死循环）
      supportedLevels.includes('document') &&
      supportedLevels.includes('focused')
    ) {
      setDocumentLevelAdjusted(true)
      setSelectedLevel('focused')
    }
  }, [mode, selectedLevel, supportedLevels])

  const blockedHint = researchModelBlockedHint(blockedReason, t)

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-b p-3">
        <SearchContextSelector
          contextDefault={searchContextDefault}
          supportedLevels={supportedLevels}
          selectedLevel={selectedLevel}
          onSelectLevel={(level) => {
            interactedRef.current = true
            setAdjustedFrom(null)
            setDocumentLevelAdjusted(false)
            setSelectedLevel(level)
          }}
          onSaveContext={(level) => void handleSaveContext(level)}
          saving={savingContext}
          disabled={isSavingModel}
        />
        {adjustedFrom !== null && (
          <p className="mt-1 text-xs text-amber-600" data-testid="context-auto-adjusted">
            {t('research.searchContext.autoAdjusted', { level: adjustedFrom })}
          </p>
        )}
        {/* RWV2-11（K13/P1-1）：entire_project 下 document 档位无显式 Source，
            收敛到 focused 并给出独立归因（scope）的明确英文说明；模型能力
            横幅（adjustedFrom）不受影响、不会同时误显示 */}
        {documentLevelAdjusted && (
          <p className="mt-1 text-xs text-muted-foreground" data-testid="document-needs-sources-hint">
            {t('research.searchDocumentNeedsSourcesHint')}
          </p>
        )}
        {blockedHint && (
          <p className="mt-1 text-xs text-muted-foreground" data-testid="model-blocked-hint">
            {blockedHint}
          </p>
        )}
        {needsConsent && (
          <p className="mt-1 text-xs text-amber-600" data-testid="consent-required-hint">
            {t('research.consentRequired')}
          </p>
        )}
        {preview && (
          <div className="mt-2 rounded-md border px-3 py-2 text-xs text-muted-foreground" data-testid="context-preview">
            <span className="font-medium">{t('research.previewTitle')}</span>
            {': '}
            {preview.source_count} /{' '}
            {preview.chunk_count} / {preview.note_count} · ~
            {preview.token_estimate} tok
            {preview.direct_or_background === 'background_job' ? (
              <span className="ml-2">{t('research.previewJobHint')}</span>
            ) : (
              <span className="ml-2">{t('research.previewDirectHint')}</span>
            )}
          </div>
        )}
      </div>

      <div className="flex-1 space-y-3 overflow-y-auto p-4">
        {!result && !background && !error && (
          <p className="text-sm text-muted-foreground">{t('research.searchEmpty')}</p>
        )}

        {error && (
          <Alert variant="destructive" data-testid="search-error">
            <AlertDescription className="space-y-1">
              {/* RWV2-42（AC8）：主消息 = 稳定码映射的英文用户文案（未知→通用） */}
              <span className="font-medium">{t(userErrorMessageKey(error.code))}</span>
              {error.message && (
                <span className="block text-xs opacity-80">{error.message}</span>
              )}
              {/* R5-2：下一步引导仅适用于搜索执行失败（保存档位失败不适用）；
                  Search 按钮/Enter 即重试入口，不新增按钮 */}
              {error.phase !== 'context' && (
                <span className="block text-xs opacity-80">
                  {t('research.searchRunErrorHint')}
                </span>
              )}
            </AlertDescription>
          </Alert>
        )}

        {background && (
          <Alert data-testid="background-queued">
            <AlertDescription>
              {t('research.backgroundQueued')}
              {background.jobId && (
                <span className="ml-1 font-mono text-xs">
                  {background.jobId}
                </span>
              )}
            </AlertDescription>
          </Alert>
        )}

        {result && (
          <div className="space-y-3" data-testid="search-result">
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <Badge variant="outline" data-testid="search-mode">
                {t('research.searchResolvedMode')}: {result.resolved_mode}
              </Badge>
              {/* §14.3：实际 model/provider 与三档级别 */}
              {result.model_id && (
                <Badge variant="outline" data-testid="search-model">
                  {t('research.resultModel')}: {result.model_id}
                </Badge>
              )}
              {result.provider_id && (
                <Badge variant="outline" data-testid="search-provider">
                  provider: {result.provider_id}
                </Badge>
              )}
              {result.context_level && (
                <Badge variant="outline" data-testid="search-context-level">
                  {t('research.resultLevel')}: {result.context_level}
                </Badge>
              )}
              <span>
                {t('research.searchEvidence')}: {result.evidence.length}
              </span>
              {result.usage && (
                <span>
                  {result.usage.input_tokens} in / {result.usage.output_tokens} out
                  {result.usage.estimated === true && (
                    <span className="ml-1">({t('research.usageEstimatedBadge')})</span>
                  )}
                </span>
              )}
            </div>

            {result.context_coverage && (
              <div className="rounded-md border px-3 py-2 text-xs text-muted-foreground" data-testid="search-coverage">
                <span className="font-medium">{t('research.coverageReport')}</span>{' '}
                relevant: {result.context_coverage.relevant_extra ?? 0} · trimmed:{' '}
                {result.context_coverage.trimmed ?? 0} · budget:{' '}
                {result.context_coverage.input_budget ?? '—'}
              </div>
            )}

            {result.degradation_reason && (
              <Alert variant="default" data-testid="search-degradation">
                <AlertDescription>
                  {t('research.searchDegradation')}: {result.degradation_reason}
                </AlertDescription>
              </Alert>
            )}

            {result.conclusion && (
              <div className="rounded-lg border px-3 py-2 text-sm">
                <MarkdownRenderer>{result.conclusion}</MarkdownRenderer>
              </div>
            )}

            {result.evidence.length > 0 && (
              <div className="space-y-1.5" data-testid="search-evidence">
                <p className="text-xs font-medium text-muted-foreground">
                  {t('research.searchEvidenceList')}
                </p>
                <ol className="list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
                  {result.evidence.map((item, index) => (
                    <li key={`${item.chunk_id}-${index}`}>
                      {item.original_text}
                      <span className="ml-2 text-xs">
                        {item.source_id} · {t('research.citationPage')} {item.page_idx + 1}
                      </span>
                    </li>
                  ))}
                </ol>
              </div>
            )}

            <ResearchCitationList citations={result.citations} />

            {/* RWV2-23：Search 结果动作条——仅 v1 direct 结果（携带
                generation_id，服务端已强制持久化 search_result 才返回 200）
                提供保存；后台(202)/旧后端无 id → 不渲染写动作（不可存如实
                无入口，不猜测）。Continue research 预填派发时 query。 */}
            {result.generation_id !== undefined &&
              result.generation_id !== null && (
                <ResultActions
                  originKind="search"
                  originId={result.generation_id}
                  content={result.conclusion ?? ''}
                  citations={(result.citations ?? []).map((citation) => ({
                    claim: citation.claim,
                    original_text: citation.original_text,
                    doc_id: citation.doc_id,
                    page_idx:
                      typeof citation.page_idx === 'number'
                        ? citation.page_idx
                        : null,
                  }))}
                  onContinueResearch={
                    onContinueResearch !== undefined
                      ? () =>
                          onContinueResearch(lastExecutedQueryRef.current || query)
                      : undefined
                  }
                  onViewInsight={onViewInsight}
                  onViewNote={onViewNote}
                />
              )}
          </div>
        )}
      </div>

      <div className="flex gap-2 border-t p-3">
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && canExecute) run()
          }}
          placeholder={t('research.searchPlaceholder')}
          data-testid="search-input"
        />
        <Button
          onClick={run}
          disabled={!query.trim() || loading || !canExecute}
          data-testid="search-run"
        >
          {loading ? t('research.searchRunning') : t('research.searchRun')}
        </Button>
      </div>
    </div>
  )
}
