'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from '@/lib/hooks/use-translation'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { MarkdownRenderer } from '@/components/ui/markdown-renderer'
import { ResearchCitationList } from './ResearchCitationList'
import {
  SearchContextSelector,
  CONTEXT_LEVELS,
} from './SearchContextSelector'
import { fetchContextPreview, newIdempotencyKey, searchV1 } from '@/lib/research/api'
import { researchModelBlockedHint, useResearchGlobalModel } from '@/lib/hooks/use-research-global-model'
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
  selectedSourceIds,
  selectedNoteIds,
}: {
  projectId: string
  selectedSourceIds: string[]
  selectedNoteIds: string[]
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

  const [query, setQuery] = useState('')
  const [result, setResult] = useState<ResearchSearchResponse | null>(null)
  const [background, setBackground] = useState<BackgroundNotice | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [savingContext, setSavingContext] = useState(false)

  // 局部档位：初始取服务端默认值；用户手动改过之后不再被服务端值覆盖
  const [selectedLevel, setSelectedLevel] =
    useState<ResearchContextLevel>('focused')
  const [adjustedFrom, setAdjustedFrom] = useState<ResearchContextLevel | null>(null)
  const interactedRef = useRef(false)

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
    if (!trimmed || confirmedModelId === null) {
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
  }, [query, projectId, selectedLevel, selectedSourceIds, selectedNoteIds, confirmedModelId])

  const handleSaveContext = useCallback(
    async (level: ResearchContextLevel) => {
      setSavingContext(true)
      try {
        // 只 PATCH default_context_level——保存 Search 上下文不改顶层模型
        await saveSearchContext(level)
        interactedRef.current = false
        setError(null)
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
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
        if (hasServerResponse) {
          idempotencyKeyRef.current = null
          keyInputsRef.current = ''
          // 后端 dispatch gate 判定授权失效 → 让 consent 重新生效判定，
          // 下一次执行由根级 guard 重新弹确认；不在此处自行重试或改模型。
          const detailCode =
            ((err as { response?: { data?: { detail?: { code?: string } } } })
              ?.response?.data?.detail?.code ?? '')
          if (CONSENT_ERROR_CODES.includes(detailCode)) {
            invalidateConsent()
          }
        }
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setLoading(false)
      }
    },
    [invalidateConsent, projectId],
  )

  const run = useCallback(() => {
    const trimmed = query.trim()
    if (!trimmed || loading) return
    // 快照模型与档位：外部模型需确认时执行被推迟，不能采用确认后的新值
    const levelSnapshot = selectedLevel
    const sourceSnapshot = [...selectedSourceIds]
    const noteSnapshot = [...selectedNoteIds]
    void runGuarded((modelId) =>
      executeSearch(trimmed, modelId, levelSnapshot, sourceSnapshot, noteSnapshot),
    )
  }, [
    executeSearch,
    loading,
    query,
    runGuarded,
    selectedLevel,
    selectedNoteIds,
    selectedSourceIds,
  ])

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
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
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
