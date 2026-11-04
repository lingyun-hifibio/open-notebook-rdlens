'use client'

/**
 * 搜索记录只读详情（Issue #1014 / D1-F 主单 §2.8/§2.12）。
 *
 * 固定六分区（顺序固定）：
 * ① 查询与执行上下文；② 当时资料范围（允许来源）；③ 实际命中；
 * ④ 最终引用；⑤ 结论与原因；⑥ 实际模型。
 *
 * 关键纪律（计划 §2.5/§2.8/§2.12）：
 * - 三可区分：允许来源只来自 `sources[]`（当时范围），实际命中只来自
 *   `hits.items` + `hit_count`，最终引用只来自 `citations.items` +
 *   `citation_count`；三区各有独立标题与计数，命中项按
 *   `(document_version, chunk_id)` 与引用集合比对标记「已引用/未引用」；
 * - restricted（任一来源 denied）时隐藏来源身份、片段与 conclusion，只保留
 *   query/时间/计数/模型与受限计数；不把受限渲染成「无命中」；
 * - v1 行（no_generation/no_hit/failed）不渲染 v2 分区（③/④），因为 wire
 *   未携带 `hits/citations`；
 * - `snippet/claim=null` 显示「片段不可用」，绝不伪造文本；未知 outcome /
 *   未知 warning 通用展示，不崩溃；
 * - 不提供 Save as Insight/Note、Continue research、Rerun（§2.13）；
 * - 跳转只经既有 `resolveCitationSource` + `canJumpToCitation` 四闸，禁用时
 *   显示既有降级文案（degradedSource/degradedVersion/degradedPage），不静默。
 */

import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { MarkdownRenderer } from '@/components/ui/markdown-renderer'
import { useTranslation } from '@/lib/hooks/use-translation'
import { formatResearchTimestamp } from '@/lib/research/format'
import {
  hasSearchRecordResultProjection,
  isHitCited,
  searchRecordOutcomeDetailKey,
  searchRecordOutcomeLabelKey,
  searchRecordScopeModeLabelKey,
} from '@/lib/research/search-records'
import {
  canJumpToCitation,
  resolveCitationCandidate,
  resolveCitationSource,
} from './citation-utils'
import type { ResearchCitation, ResearchSource } from '@/lib/types/research'
import type {
  ResearchSearchRecordCitation,
  ResearchSearchRecordDetail,
  ResearchSearchRecordHit,
} from '@/lib/research/types'

interface RecordJump {
  canJump: boolean
  sourceId: string | null
  pageIdx: number | null
  /** 禁用时的既有降级文案 key；可跳转为 null。 */
  denyKey: string | null
}

interface JumpableRecordItem {
  document_id: string
  document_version: string
  chunk_id: string
  page_idx: number | null
  source_id: string | null
}

/**
 * 跳转四闸（计划 §2.12 #18）：wire `source_id` 已解析、来源存在且 ready、
 * `document_version` 与当前来源一致、`page_idx` 为 number。任一不满足 →
 * 禁用并给出既有降级文案，绝不静默、绝不打开另一版本。
 */
function evaluateRecordJump(
  sources: readonly ResearchSource[],
  item: JumpableRecordItem,
): RecordJump {
  if (item.source_id === null) {
    return { canJump: false, sourceId: null, pageIdx: null, denyKey: 'research.citation.degradedSource' }
  }
  const citation = {
    doc_id: item.document_id,
    doc_version: item.document_version,
    chunk_id: item.chunk_id,
    page_idx: item.page_idx,
  } as unknown as ResearchCitation
  // 跳转目标只认**版本精确匹配**的来源（resolveCitationSource）；拒绝原因用
  // 文档级候选（resolveCitationCandidate）——版本不符时才能如实给出
  // degradedVersion，而不是误报 source_unavailable（同 CitationCard 语义）。
  const exactSource = resolveCitationSource(sources, citation) ?? null
  const candidateForReason = exactSource ?? resolveCitationCandidate(sources, citation) ?? null
  const evaluation = canJumpToCitation(citation, candidateForReason, undefined)
  if (evaluation.canJump && exactSource !== null && exactSource.source_id !== null) {
    return { canJump: true, sourceId: exactSource.source_id, pageIdx: item.page_idx, denyKey: null }
  }
  const denyKey =
    evaluation.reason === 'version_mismatch'
      ? 'research.citation.degradedVersion'
      : evaluation.reason === 'source_unavailable'
        ? 'research.citation.degradedSource'
        : 'research.citation.degradedPage'
  return { canJump: false, sourceId: null, pageIdx: null, denyKey }
}

/**
 * 来源展示身份：wire 无名称字段，只能按 `source_id` 从 `sources` 解析；
 * 解析失败回退记录内 `document_id`/`document_version`（跳转同时被禁用）。
 */
function sourceIdentity(
  sources: readonly ResearchSource[],
  sourceId: string | null,
  fallbackDocumentId: string,
  fallbackDocumentVersion: string,
): { documentId: string; documentVersion: string; resolved: boolean } {
  const resolved = sourceId === null
    ? undefined
    : sources.find((source) => source.source_id === sourceId)
  return {
    documentId: resolved?.document_id ?? fallbackDocumentId,
    documentVersion: resolved?.document_version ?? fallbackDocumentVersion,
    resolved: resolved !== undefined,
  }
}

function RecordJumpButton({
  jump,
  testId,
  onCitationJump,
}: {
  jump: RecordJump
  testId: string
  onCitationJump?: (sourceId: string, pageIdx: number | null) => void
}) {
  const { t } = useTranslation()
  const enabled = jump.canJump
    && jump.sourceId !== null
    && jump.pageIdx !== null
    && onCitationJump !== undefined
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <Button
        size="sm"
        variant="outline"
        disabled={!enabled}
        data-testid={testId}
        onClick={() => {
          if (enabled) onCitationJump?.(jump.sourceId as string, jump.pageIdx)
        }}
      >
        {t('research.searchHistory.jump')}
      </Button>
      {!enabled && jump.denyKey !== null && (
        <span className="text-xs text-muted-foreground" data-testid={`${testId}-degraded`}>
          {t(jump.denyKey)}
        </span>
      )}
    </span>
  )
}

/** 命中/引用条目的来源与页码元信息（不渲染伪造的名称）。 */
function ItemSourceMeta({
  source,
  pageIdx,
}: {
  source: { documentId: string; documentVersion: string }
  pageIdx: number | null
}) {
  const { t } = useTranslation()
  return (
    <span className="text-xs text-muted-foreground">
      {source.documentId}
      {source.documentVersion !== '' && (
        <span className="ml-1">· {source.documentVersion}</span>
      )}
      {pageIdx !== null && (
        <span className="ml-1">
          · {t('research.citationPage')} {pageIdx + 1}
        </span>
      )}
    </span>
  )
}

function HitItem({
  hit,
  index,
  sources,
  citations,
  restricted,
  resultAvailable,
  onCitationJump,
}: {
  hit: ResearchSearchRecordHit
  index: number
  sources: readonly ResearchSource[]
  citations: readonly ResearchSearchRecordCitation[]
  restricted: boolean
  resultAvailable: boolean
  onCitationJump?: (sourceId: string, pageIdx: number | null) => void
}) {
  const { t } = useTranslation()
  const source = sourceIdentity(
    sources,
    hit.source_id,
    hit.document_id,
    hit.document_version,
  )
  const jump = evaluateRecordJump(sources, hit)
  const cited = isHitCited(hit, citations)
  const snippetAvailable = !restricted && resultAvailable && hit.snippet !== null
  return (
    <li className="space-y-1 border-t pt-2" data-testid={`search-record-hit-${index}`}>
      <div className="flex flex-wrap items-center gap-2">
        <ItemSourceMeta source={source} pageIdx={hit.page_idx} />
        <Badge
          variant={cited ? 'default' : 'outline'}
          data-testid={`search-record-hit-cited-${index}`}
        >
          {cited
            ? t('research.searchHistory.cited')
            : t('research.searchHistory.notCited')}
        </Badge>
        {hit.warning === 'source_unavailable' && (
          <span className="text-xs" data-testid={`search-record-hit-source-unavailable-${index}`}>
            {t('research.searchHistory.sourceUnavailable')}
          </span>
        )}
      </div>
      {snippetAvailable ? (
        <p className="whitespace-pre-wrap text-sm" data-testid={`search-record-hit-snippet-${index}`}>
          {hit.snippet}
        </p>
      ) : (
        <p className="text-xs text-muted-foreground" data-testid={`search-record-hit-snippet-unavailable-${index}`}>
          {t('research.searchHistory.snippetUnavailable')}
        </p>
      )}
      {!restricted && (
        <RecordJumpButton
          jump={jump}
          testId={`search-record-hit-jump-${index}`}
          onCitationJump={onCitationJump}
        />
      )}
    </li>
  )
}

function CitationItem({
  citation,
  index,
  sources,
  restricted,
  resultAvailable,
  onCitationJump,
}: {
  citation: ResearchSearchRecordCitation
  index: number
  sources: readonly ResearchSource[]
  restricted: boolean
  resultAvailable: boolean
  onCitationJump?: (sourceId: string, pageIdx: number | null) => void
}) {
  const { t } = useTranslation()
  const source = sourceIdentity(
    sources,
    citation.source_id,
    citation.document_id,
    citation.document_version,
  )
  const jump = evaluateRecordJump(sources, citation)
  const claimAvailable = !restricted && citation.claim !== null
  const snippetAvailable = !restricted && resultAvailable && citation.snippet !== null
  return (
    <li className="space-y-1 border-t pt-2" data-testid={`search-record-citation-${index}`}>
      <div className="flex flex-wrap items-center gap-2">
        <ItemSourceMeta source={source} pageIdx={citation.page_idx} />
        {citation.warning === 'source_unavailable' && (
          <span className="text-xs" data-testid={`search-record-citation-source-unavailable-${index}`}>
            {t('research.searchHistory.sourceUnavailable')}
          </span>
        )}
      </div>
      {claimAvailable ? (
        <p className="text-sm" data-testid={`search-record-citation-claim-${index}`}>
          {citation.claim}
        </p>
      ) : (
        <p className="text-xs text-muted-foreground" data-testid={`search-record-citation-claim-unavailable-${index}`}>
          {t('research.searchHistory.snippetUnavailable')}
        </p>
      )}
      {snippetAvailable && (
        <p
          className="whitespace-pre-wrap text-xs text-muted-foreground"
          data-testid={`search-record-citation-snippet-${index}`}
        >
          {citation.snippet}
        </p>
      )}
      {!restricted && (
        <RecordJumpButton
          jump={jump}
          testId={`search-record-citation-jump-${index}`}
          onCitationJump={onCitationJump}
        />
      )}
    </li>
  )
}

export function SearchRecordDetail({
  record,
  sources = [],
  onBack,
  onClose,
  onCitationJump,
}: {
  record: ResearchSearchRecordDetail
  sources?: readonly ResearchSource[]
  onBack: () => void
  onClose: () => void
  onCitationJump?: (sourceId: string, pageIdx: number | null) => void
}) {
  const { t } = useTranslation()
  const restricted = record.record_visibility === 'restricted'
  const hasResultProjection = hasSearchRecordResultProjection(record)
  const outcomeLabel = t(searchRecordOutcomeLabelKey(record.outcome))
  const outcomeIsUnknown = record.outcome !== null
    && searchRecordOutcomeLabelKey(record.outcome) === 'research.searchHistory.outcome.unknown'
  const detailKey = searchRecordOutcomeDetailKey(record.outcome_detail)
  const createdText = formatResearchTimestamp(record.created_at) ?? '—'
  const completedText = formatResearchTimestamp(record.completed_at) ?? '—'
  const scopeModeLabel = t(searchRecordScopeModeLabelKey(record.scope?.mode ?? null))
  const hits = record.hits
  const citations = record.citations
  const resultAvailable = record.result_available !== false

  const modelRecorded = record.model !== null
    && (record.outcome === 'completed' || record.outcome === 'no_hit')

  return (
    <div className="space-y-4 p-4" data-testid="search-record-detail">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button
          size="sm"
          variant="outline"
          onClick={onBack}
          data-testid="search-history-back"
        >
          {t('research.searchHistory.backToList')}
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={onClose}
          data-testid="search-history-close"
        >
          {t('research.searchHistory.close')}
        </Button>
      </div>

      {/* ① 查询与执行上下文 */}
      <section className="space-y-1" data-testid="search-record-section-context">
        <h3 className="text-sm font-medium">
          {t('research.searchHistory.sections.context')}
        </h3>
        <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <dt>{t('research.searchHistory.fields.query')}</dt>
          <dd className="break-words" data-testid="search-record-query">{record.query}</dd>
          <dt>{t('research.searchHistory.fields.outcome')}</dt>
          <dd data-testid="search-record-outcome">
            {outcomeLabel}
            {outcomeIsUnknown && (
              <span className="ml-1 font-mono" data-testid="search-record-outcome-raw">
                {record.outcome}
              </span>
            )}
          </dd>
          <dt>{t('research.searchHistory.fields.contextLevel')}</dt>
          <dd data-testid="search-record-context-level">{record.context_level ?? '—'}</dd>
          <dt>{t('research.searchHistory.fields.requestedMode')}</dt>
          <dd data-testid="search-record-requested-mode">{record.requested_mode ?? '—'}</dd>
          <dt>{t('research.searchHistory.fields.resolvedMode')}</dt>
          <dd data-testid="search-record-resolved-mode">{record.resolved_mode ?? '—'}</dd>
          <dt>{t('research.searchHistory.fields.createdAt')}</dt>
          <dd data-testid="search-record-created-at">{createdText}</dd>
          <dt>{t('research.searchHistory.fields.completedAt')}</dt>
          <dd data-testid="search-record-completed-at">{completedText}</dd>
        </dl>
      </section>

      {/* ② 当时资料范围（允许来源） */}
      <section className="space-y-2" data-testid="search-record-section-allowed-sources">
        <h3 className="text-sm font-medium">
          {t('research.searchHistory.sections.allowedSources')}{' '}
          <span className="text-xs font-normal text-muted-foreground" data-testid="search-record-allowed-sources-count">
            {record.source_counts.total}
          </span>
        </h3>
        {restricted ? (
          <div
            className="space-y-1 rounded-md border border-dashed p-3 text-sm"
            data-testid="search-record-restricted"
          >
            <p className="font-medium">{t('research.searchHistory.restricted.title')}</p>
            <p className="text-xs text-muted-foreground">
              {t('research.searchHistory.restricted.identity')}
            </p>
            <p className="text-xs" data-testid="search-record-restricted-count">
              {t('research.searchHistory.restricted.count', {
                count: record.source_counts.restricted,
                total: record.source_counts.total,
              })}
            </p>
          </div>
        ) : record.scope === null ? (
          <p className="text-xs text-muted-foreground" data-testid="search-record-scope-missing">
            {t('research.scopeDetails.projectionMissing')}
          </p>
        ) : (
          <>
            <p className="text-xs text-muted-foreground" data-testid="search-record-scope-mode">
              {scopeModeLabel}
              {' · '}
              {t('research.searchHistory.fields.sourceTotal', {
                count: record.scope.source_total,
              })}
            </p>
            {record.sources.length === 0 ? (
              <p className="text-xs text-muted-foreground" data-testid="search-record-sources-empty">
                {t('research.searchHistory.noAllowedSources')}
              </p>
            ) : (
              <ul className="space-y-1">
                {record.sources.map((source, index) => {
                  const identity = sourceIdentity(
                    sources,
                    source.source_id,
                    source.document_id,
                    source.document_version,
                  )
                  return (
                    <li
                      key={`${source.document_id}:${source.document_version}:${index}`}
                      className="flex flex-wrap items-center gap-2 text-xs"
                      data-testid={`search-record-allowed-source-${index}`}
                    >
                      <span>{identity.documentId}</span>
                      {identity.documentVersion !== '' && (
                        <span className="text-muted-foreground">· {identity.documentVersion}</span>
                      )}
                      {source.status !== null && (
                        <Badge variant="outline">{source.status}</Badge>
                      )}
                      {source.warning !== null && (
                        <span className="text-muted-foreground">
                          {t('research.searchHistory.sourceUnavailable')}
                        </span>
                      )}
                    </li>
                  )
                })}
              </ul>
            )}
            {record.scope.missing_source_ids.length > 0 && (
              <p className="text-xs text-muted-foreground" data-testid="search-record-missing-sources">
                {t('research.searchHistory.fields.missingSources', {
                  count: record.scope.missing_source_ids.length,
                })}
              </p>
            )}
            {record.scope.note_ids.length > 0 && (
              <p className="text-xs text-muted-foreground" data-testid="search-record-notes-in-scope">
                {t('research.searchHistory.fields.notesInScope', {
                  count: record.scope.note_ids.length,
                })}
              </p>
            )}
          </>
        )}
      </section>

      {/* ③ 实际命中 / ④ 最终引用：仅 v2 结果投影存在时渲染（v1 行不渲染） */}
      {hasResultProjection && (
        <section className="space-y-2" data-testid="search-record-section-hits">
          <h3 className="text-sm font-medium">
            {t('research.searchHistory.sections.hits')}{' '}
            <span className="text-xs font-normal text-muted-foreground">
              {t('research.searchHistory.fields.hitTotal', {
                count: hits?.total ?? 0,
              })}
              {' · '}
              {t('research.searchHistory.fields.hitShown', {
                count: hits?.items.length ?? 0,
              })}
            </span>
          </h3>
          {restricted ? (
            <p className="text-xs text-muted-foreground" data-testid="search-record-hits-restricted">
              {t('research.searchHistory.restricted.hits')}
            </p>
          ) : (
            <>
              {!resultAvailable && (
                <p className="text-xs" data-testid="search-record-result-unavailable">
                  {t('research.searchHistory.resultUnavailable')}
                </p>
              )}
              {hits?.truncated === true && (
                <p className="text-xs" data-testid="search-record-hits-truncated">
                  {t('research.searchHistory.truncated', {
                    total: hits.total,
                    shown: hits.items.length,
                  })}
                </p>
              )}
              {(hits?.items.length ?? 0) === 0 && resultAvailable ? (
                <p className="text-xs text-muted-foreground" data-testid="search-record-no-hits">
                  {t('research.searchHistory.noHits')}
                </p>
              ) : (
                <ul className="space-y-2">
                  {(hits?.items ?? []).map((hit, index) => (
                    <HitItem
                      key={`${hit.document_id}:${hit.document_version}:${hit.chunk_id}:${index}`}
                      hit={hit}
                      index={index}
                      sources={sources}
                      citations={citations?.items ?? []}
                      restricted={restricted}
                      resultAvailable={resultAvailable}
                      onCitationJump={onCitationJump}
                    />
                  ))}
                </ul>
              )}
            </>
          )}
        </section>
      )}

      {hasResultProjection && (
        <section className="space-y-2" data-testid="search-record-section-citations">
          <h3 className="text-sm font-medium">
            {t('research.searchHistory.sections.citations')}{' '}
            <span className="text-xs font-normal text-muted-foreground">
              {t('research.searchHistory.fields.citationTotal', {
                count: citations?.total ?? 0,
              })}
              {' · '}
              {t('research.searchHistory.fields.citationShown', {
                count: citations?.items.length ?? 0,
              })}
            </span>
          </h3>
          {restricted ? (
            <p className="text-xs text-muted-foreground" data-testid="search-record-citations-restricted">
              {t('research.searchHistory.restricted.citations')}
            </p>
          ) : (
            <>
              {citations?.truncated === true && (
                <p className="text-xs" data-testid="search-record-citations-truncated">
                  {t('research.searchHistory.truncated', {
                    total: citations.total,
                    shown: citations.items.length,
                  })}
                </p>
              )}
              {(citations?.items.length ?? 0) === 0 ? (
                <p className="text-xs text-muted-foreground" data-testid="search-record-no-citations">
                  {t('research.searchHistory.noCitations')}
                </p>
              ) : (
                <ul className="space-y-2">
                  {(citations?.items ?? []).map((citation, index) => (
                    <CitationItem
                      key={`${citation.document_id}:${citation.document_version}:${citation.chunk_id}:${index}`}
                      citation={citation}
                      index={index}
                      sources={sources}
                      restricted={restricted}
                      resultAvailable={resultAvailable}
                      onCitationJump={onCitationJump}
                    />
                  ))}
                </ul>
              )}
            </>
          )}
        </section>
      )}

      {/* ⑤ 结论与原因 */}
      <section className="space-y-2" data-testid="search-record-section-conclusion">
        <h3 className="text-sm font-medium">
          {t('research.searchHistory.sections.conclusionAndReasons')}
        </h3>
        {restricted ? (
          <p className="text-xs text-muted-foreground" data-testid="search-record-conclusion-restricted">
            {t('research.searchHistory.restricted.conclusion')}
          </p>
        ) : (
          <>
            {record.outcome_detail !== null && (
              <p className="text-xs" data-testid="search-record-outcome-detail">
                {t('research.searchHistory.fields.outcomeDetail')}
                {': '}
                {detailKey !== null ? t(detailKey) : record.outcome_detail}
              </p>
            )}
            {record.failure !== null && (
              <p className="font-mono text-xs" data-testid="search-record-failure">
                {t('research.searchHistory.failure')}
                {': '}
                {record.failure.code}
                {record.failure.detail_safe !== null && (
                  <span className="ml-2 text-muted-foreground">
                    {record.failure.detail_safe}
                  </span>
                )}
              </p>
            )}
            {record.conclusion.text !== null ? (
              <div data-testid="search-record-conclusion">
                <MarkdownRenderer>{record.conclusion.text}</MarkdownRenderer>
              </div>
            ) : (
              <p className="text-xs text-muted-foreground" data-testid="search-record-conclusion-empty">
                {t('research.searchHistory.conclusionEmpty')}
              </p>
            )}
            {record.conclusion.truncated && (
              <p className="text-xs text-muted-foreground" data-testid="search-record-conclusion-truncated">
                {t('research.searchHistory.conclusionTruncated')}
              </p>
            )}
            {record.degradations.length > 0 && (
              <div className="space-y-1" data-testid="search-record-degradations">
                <p className="text-xs font-medium">
                  {t('research.searchHistory.degradations')}
                </p>
                <ul className="list-disc pl-5 text-xs">
                  {record.degradations.map((degradation, index) => (
                    <li key={`${degradation.code}:${index}`} className="font-mono">
                      {degradation.code}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {record.coverage !== null && (
              <div className="space-y-1" data-testid="search-record-coverage">
                <p className="text-xs font-medium">
                  {t('research.searchHistory.coverage')}
                </p>
                <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs text-muted-foreground">
                  {Object.entries(record.coverage).map(([key, value]) => (
                    <div key={key} className="contents">
                      <dt className="font-mono">{key}</dt>
                      <dd>{value === null ? '—' : String(value)}</dd>
                    </div>
                  ))}
                </dl>
              </div>
            )}
          </>
        )}
      </section>

      {/* ⑥ 实际模型 */}
      <section className="space-y-1" data-testid="search-record-section-model">
        <h3 className="text-sm font-medium">
          {t('research.searchHistory.sections.model')}
        </h3>
        {modelRecorded ? (
          <dl
            className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs text-muted-foreground"
            data-testid="search-record-model"
          >
            <dt>model_id</dt>
            <dd data-testid="search-record-model-id">
              {record.model?.model_id ?? t('research.searchHistory.notRecorded')}
            </dd>
            <dt>provider_id</dt>
            <dd data-testid="search-record-provider-id">
              {record.model?.provider_id ?? t('research.searchHistory.notRecorded')}
            </dd>
          </dl>
        ) : (
          <p className="text-xs text-muted-foreground" data-testid="search-record-model-unavailable">
            {record.outcome === 'no_generation'
              ? t('research.searchHistory.noModelSystemRoute')
              : t('research.searchHistory.modelNotRecorded')}
          </p>
        )}
      </section>
    </div>
  )
}
