'use client'

import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from '@/lib/hooks/use-translation'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { MarkdownRenderer } from '@/components/ui/markdown-renderer'
import { ResearchCitationList } from './ResearchCitationList'
import { ModelContextSelector } from './ModelContextSelector'
import {
  fetchContextPreview,
  getExecutionPreferences,
  listModels,
  saveExecutionPreferences,
  searchV1,
} from '@/lib/research/api'
import type {
  ResearchContextPreview,
  ResearchExecutionPreferences,
  ResearchModelOption,
  ResearchSearchResponse,
} from '@/lib/research/types'

/**
 * Research Search 面板（UI-03，REQ-ENG-04，契约 §8.1；Issue #200 Phase 2b
 * §14.3 增强）：
 * - 模型/三档上下文选择器分离，无已保存偏好时模型选择为空；
 * - 发送前展示 Context Preview（本地只读预判，结论只是提示）；
 * - v1 按 HTTP status 分支 direct/background；后台受理展示排队卡片提示
 *   （刷新后由 Job 列表与会话卡片兜底）；
 * - 结果展示实际 model/provider、三档级别、覆盖报告与是否估算 usage；
 * - 不实现 A/B、shadow call、自动 fallback 或 API Key 输入框。
 */

interface BackgroundNotice {
  generationId: string
  jobId: string | null
}

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
  const [query, setQuery] = useState('')
  const [result, setResult] = useState<ResearchSearchResponse | null>(null)
  const [background, setBackground] = useState<BackgroundNotice | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // 模型/上下文偏好（§14.3：无已保存偏好时模型选择为空）
  const [models, setModels] = useState<ResearchModelOption[]>([])
  const [preferences, setPreferences] =
    useState<ResearchExecutionPreferences | null>(null)
  const [savingPreference, setSavingPreference] = useState(false)
  const selectedModelId = preferences?.preferred_model_id ?? ''

  // Context Preview（§9.1 只读预判；发送前提示）
  const [preview, setPreview] = useState<ResearchContextPreview | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const [modelPage, prefs] = await Promise.all([
          listModels(projectId),
          getExecutionPreferences(projectId),
        ])
        if (cancelled) return
        setModels(modelPage.models ?? [])
        setPreferences(prefs)
      } catch {
        // 目录/偏好加载失败不阻塞面板；Run 由「未选模型」守卫拦截
      }
    })()
    return () => {
      cancelled = true
    }
  }, [projectId])

  useEffect(() => {
    const trimmed = query.trim()
    if (!trimmed) {
      setPreview(null)
      return
    }
    let cancelled = true
    const timer = setTimeout(() => {
      cancelled = false
      void fetchContextPreview(projectId, {
        context_level: preferences?.default_context_level ?? 'focused',
        source_ids: selectedSourceIds,
        note_ids: selectedNoteIds,
        question: trimmed,
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
  }, [
    query,
    projectId,
    preferences?.default_context_level,
    selectedSourceIds,
    selectedNoteIds,
  ])

  const handleSavePreference = useCallback(
    async (input: {
      default_context_level: 'focused' | 'document' | 'workspace'
      preferred_model_id: string | null
    }) => {
      setSavingPreference(true)
      try {
        const saved = await saveExecutionPreferences(projectId, input)
        setPreferences(saved)
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setSavingPreference(false)
      }
    },
    [projectId],
  )

  const run = async () => {
    const trimmed = query.trim()
    if (!trimmed || loading || !selectedModelId) return
    setLoading(true)
    setError(null)
    setResult(null)
    setBackground(null)
    try {
      const outcome = await searchV1(projectId, {
        query: trimmed,
        source_ids: selectedSourceIds,
        note_ids: selectedNoteIds,
        mode: 'auto',
        model_id: selectedModelId,
        context_level:
          preview?.coverage?.['context_level'] as string | undefined ??
          preferences?.default_context_level ??
          'focused',
      })
      if (outcome.kind === 'direct') {
        setResult(outcome.result)
      } else {
        setBackground({
          generationId: outcome.generation_id,
          jobId: outcome.job_id,
        })
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-b p-3">
        <ModelContextSelector
          models={models}
          preferences={preferences}
          onSavePreference={handleSavePreference}
          saving={savingPreference}
        />
        {!selectedModelId && (
          <p className="mt-1 text-xs text-muted-foreground" data-testid="model-required-hint">
            {t('research.modelRequiredHint')}
          </p>
        )}
        {preview && (
          <div className="mt-2 rounded-md border px-3 py-2 text-xs text-muted-foreground" data-testid="context-preview">
            <span className="font-medium">{t('research.previewTitle')}</span>
            {' · '}
            {t('research.previewTitle')}: {preview.source_count} /{' '}
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
            if (event.key === 'Enter' && selectedModelId) run()
          }}
          placeholder={t('research.searchPlaceholder')}
          data-testid="search-input"
        />
        <Button
          onClick={run}
          disabled={!query.trim() || loading || !selectedModelId}
        >
          {loading ? t('research.searchRunning') : t('research.searchRun')}
        </Button>
      </div>
    </div>
  )
}
