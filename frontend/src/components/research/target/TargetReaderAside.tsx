'use client'

import { Button } from '@/components/ui/button'
import { useTranslation } from '@/lib/hooks/use-translation'
import type { UseSourceMediaResult } from '@/lib/hooks/use-source-media'
import { matchCitedExcerpt } from '@/lib/research/reader'
import type { ResearchCitationDisplayItem } from '@/lib/research/types'
import type { ResearchChunk } from '@/lib/types/research'
import type {
  TargetReaderOpenRequest,
  TargetReaderVersionState,
} from './target-reader-state'

/**
 * 被引原文摘录的截断长度（§2.5-1：完整正文在正文列/原文件，aside 只做对照）。
 */
export const CITED_EXCERPT_MAX_CHARS = 280

export interface TargetReaderAsideProps {
  request: TargetReaderOpenRequest
  media: UseSourceMediaResult
  /** 触发本次打开的回答片段（只读对照；null = 不可用） */
  answerContext: string | null
  /** 当前会话可把范围限定到本来源（BEH-02） */
  canPinSingleSource: boolean
  onAskThisSource: () => void
  /** citation 入口且 return-target 可用 */
  returnAvailable: boolean
  onReturnToAnswer: () => void
  /** 返回原回答目标不可用（position_unavailable） */
  returnUnavailableNotice: boolean
}

/**
 * 宽屏阅读器 aside（Issue #1077 W2；UI 规格 v1 §5.6 UI-13/§5.7；合并计划
 * §2.5/§2.10-9）。
 *
 * 「对照」= 原文与当前引用/回答上下文的并置核对（单来源，不是双来源比较）：
 * - 被引原文摘录**只在版本护栏判定为 `match`** 时用 `matchCitedExcerpt` 匹配；
 *   不可得/兜底 chunk 时显示 `claim` 并明确标注「引用主张」，不冒称原文；
 * - 引用版本不可核对（缺成对 doc_id/doc_version）只显示 claim + 标注；
 * - 版本不一致（422 / 客户端失配）显示版本失效 + claim，不回退最新版；
 * - 资料预览入口（latest）不显示摘录区块（没有「被引」上下文）；
 * - 当前回答上下文只读展示（不自动把正文/全文发送给模型，BEH-11）；
 * - 「只问此来源」「返回原回答」复用既有单篇限定/返回动作。
 */
export function TargetReaderAside({
  request,
  media,
  answerContext,
  canPinSingleSource,
  onAskThisSource,
  returnAvailable,
  onReturnToAnswer,
  returnUnavailableNotice,
}: TargetReaderAsideProps) {
  const { t } = useTranslation()
  const chunks: readonly ResearchChunk[] = media.detail?.markdown_chunks ?? []
  const citation = request.citation
  const hasAnswerContext =
    typeof answerContext === 'string' && answerContext.trim().length > 0

  return (
    <aside
      data-testid="rdlens-target-reader-aside"
      aria-label={t('research.target.reader.asideTitle')}
      className="flex h-full min-h-0 flex-col gap-4 overflow-y-auto p-4"
      style={{
        background: 'var(--rdlens-surface)',
        color: 'var(--rdlens-ink)',
      }}
    >
      <h3
        className="text-sm font-semibold"
        style={{ color: 'var(--rdlens-ink)' }}
      >
        {t('research.target.reader.asideTitle')}
      </h3>

      {media.restricted ? (
        <p
          className="text-sm"
          role="status"
          style={{ color: 'var(--rdlens-warning)' }}
          data-testid="rdlens-target-reader-aside-restricted"
        >
          {t('research.target.reader.restricted')}
        </p>
      ) : (
        citation !== null && (
          <CitedCrossCheck
            citation={citation}
            chunks={chunks}
            versionState={media.versionState}
          />
        )
      )}

      {hasAnswerContext ? (
        <section className="space-y-1" data-testid="rdlens-target-reader-answer-section">
          <p
            className="text-[11px] font-medium uppercase tracking-wide"
            style={{ color: 'var(--rdlens-ink-muted)' }}
          >
            {t('research.target.reader.asideAnswer')}
          </p>
          <p
            className="whitespace-pre-wrap text-sm leading-relaxed"
            data-testid="rdlens-target-reader-answer-context"
          >
            {(answerContext ?? '').trim()}
          </p>
        </section>
      ) : (
        <p
          className="text-xs"
          style={{ color: 'var(--rdlens-ink-muted)' }}
          data-testid="rdlens-target-reader-answer-context-unavailable"
        >
          {t('research.target.reader.asideAnswerUnavailable')}
        </p>
      )}

      <div className="mt-auto flex flex-col gap-2 pt-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={!canPinSingleSource}
          title={
            canPinSingleSource
              ? undefined
              : t('research.target.conversation.noActiveSession')
          }
          onClick={onAskThisSource}
          data-testid="rdlens-target-reader-aside-ask-source"
        >
          {t('research.target.rightPane.askThisSource')}
        </Button>
        {!canPinSingleSource && (
          <p
            className="text-xs"
            style={{ color: 'var(--rdlens-ink-muted)' }}
            data-testid="rdlens-target-reader-aside-ask-source-unavailable"
          >
            {t('research.target.rightPane.askThisSourceUnavailable')}
          </p>
        )}
        {returnAvailable && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={onReturnToAnswer}
            data-testid="rdlens-target-reader-aside-return"
          >
            {t('research.source.returnToAnswer')}
          </Button>
        )}
        {returnUnavailableNotice && (
          <p
            className="text-xs"
            role="status"
            style={{ color: 'var(--rdlens-warning)' }}
            data-testid="rdlens-target-reader-aside-return-unavailable"
          >
            {t('research.source.returnUnavailable')}
          </p>
        )}
      </div>
    </aside>
  )
}

/** 被引原文摘录 / claim（§2.5-1/§2.10-9；版本护栏由 `media.versionState` 决定）。 */
function CitedCrossCheck({
  citation,
  chunks,
  versionState,
}: {
  citation: ResearchCitationDisplayItem
  chunks: readonly ResearchChunk[]
  versionState: TargetReaderVersionState
}) {
  const { t } = useTranslation()
  // 资料预览（source 入口）没有「被引」上下文：不显示摘录区块。
  if (versionState.kind === 'latest') return null

  const claimLabel = (
    <p
      className="text-[11px] font-medium uppercase tracking-wide"
      style={{ color: 'var(--rdlens-ink-muted)' }}
    >
      {t('research.target.reader.asideClaim')}
    </p>
  )

  // 版本不一致：不回退最新版、不匹配被引位置，只显示 claim + 版本失效说明。
  if (versionState.kind === 'mismatch') {
    return (
      <section className="space-y-1" data-testid="rdlens-target-reader-cited-claim">
        <p
          className="text-xs"
          role="status"
          style={{ color: 'var(--rdlens-warning)' }}
          data-testid="rdlens-target-reader-version-mismatch"
        >
          {t('research.target.reader.versionMismatch')}
        </p>
        {claimLabel}
        <p className="text-sm leading-relaxed" data-testid="rdlens-target-reader-claim">
          {citation.claim}
        </p>
      </section>
    )
  }

  // 版本不可核对（citation 缺成对 doc_id/doc_version）：只 claim + 标注。
  if (versionState.kind === 'unverifiable') {
    return (
      <section className="space-y-1" data-testid="rdlens-target-reader-cited-claim">
        <p
          className="text-xs"
          role="status"
          style={{ color: 'var(--rdlens-ink-muted)' }}
          data-testid="rdlens-target-reader-version-unverifiable"
        >
          {t('research.target.reader.versionUnverifiable')}
        </p>
        {claimLabel}
        <p className="text-sm leading-relaxed" data-testid="rdlens-target-reader-claim">
          {citation.claim}
        </p>
        <p
          className="text-[11px]"
          style={{ color: 'var(--rdlens-ink-muted)' }}
          data-testid="rdlens-target-reader-claim-version-note"
        >
          {t('research.target.reader.asideClaimVersionNote')}
        </p>
      </section>
    )
  }

  // 版本一致：才允许用 citation 的 chunk_id/page_idx 匹配原文。
  const match = matchCitedExcerpt({
    chunks,
    chunkId: citation.chunk_id ?? null,
    pageIdx: citation.page_idx,
  })
  if (match.chunk !== null) {
    const text = match.chunk.markdown.trim()
    const truncated =
      text.length > CITED_EXCERPT_MAX_CHARS
        ? `${text.slice(0, CITED_EXCERPT_MAX_CHARS)}…`
        : text
    return (
      <section className="space-y-1" data-testid="rdlens-target-reader-cited-excerpt-section">
        <p
          className="text-[11px] font-medium uppercase tracking-wide"
          style={{ color: 'var(--rdlens-ink-muted)' }}
        >
          {t('research.target.reader.asideCitedExcerpt')}
        </p>
        <p
          className="text-sm leading-relaxed"
          data-testid="rdlens-target-reader-cited-excerpt"
        >
          {truncated}
        </p>
      </section>
    )
  }

  return (
    <section className="space-y-1" data-testid="rdlens-target-reader-cited-claim">
      {claimLabel}
      <p className="text-sm leading-relaxed" data-testid="rdlens-target-reader-claim">
        {citation.claim}
      </p>
      {match.fallback && (
        <p
          className="text-[11px]"
          style={{ color: 'var(--rdlens-ink-muted)' }}
          data-testid="rdlens-target-reader-claim-fallback-note"
        >
          {t('research.target.reader.asideFallbackNote')}
        </p>
      )}
    </section>
  )
}
