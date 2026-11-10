'use client'

/**
 * Issue #1048 PR7（D2-B4）：实际输入回看面板（方案 §6.3/§6.4）。
 *
 * 只渲染 `GET .../writing-contexts/{generation_id}` 的读投影：
 * - 实际选区/Note 版本/历史采用与未采用原因/摘要/容量；
 * - `writing_checks` 是独立派生的缺失引用提示槽位：缺失时如实显示
 *   「部分输入引用未在建议中沿用」，**不**冒充完整保留、不新增建议状态；
 * - 受限（restricted）时只显示受限状态（正文为 null，不返回冻结正文）。
 *
 * 本组件不重新计算、不覆盖已持久化的执行事实；报告不可用时明确说明。
 */

import { useTranslation } from '@/lib/hooks/use-translation'
import type {
  WritingApiError,
  WritingContextProjection,
} from '@/lib/research/issue585/writing-types'
import {
  writingApiErrorLabelKey,
  historyExcludedLabelKey,
} from '@/lib/research/issue585/writing-ui-labels'

/** 长文本预览上限（只影响展示，不改冻结事实）。 */
const PREVIEW_CHARS = 400

function truncate(value: string): string {
  return value.length > PREVIEW_CHARS ? `${value.slice(0, PREVIEW_CHARS)}…` : value
}

function shortHash(value: string): string {
  return value.length <= 16 ? value : `${value.slice(0, 8)}…${value.slice(-4)}`
}

export function WritingContextPanel({
  projection,
  error,
  loading,
}: {
  projection: WritingContextProjection | null
  error: WritingApiError | null
  loading: boolean
}) {
  const { t } = useTranslation()
  if (loading) {
    return (
      <p className="text-xs text-muted-foreground" role="status" data-testid="writing-context-loading">
        {t('research.notes.writing.context.loading')}
      </p>
    )
  }
  if (projection === null) {
    return (
      <p className="text-xs text-destructive" role="alert" data-testid="writing-context-unavailable">
        {t('research.notes.writing.context.unavailable')}
        {error !== null ? ` (${t(writingApiErrorLabelKey(error.code))})` : ''}
      </p>
    )
  }
  const { document_context: documentContext, history, capacity, writing_checks: checks } =
    projection
  const restricted = projection.access_state === 'restricted'
  const selectionLabel =
    documentContext.selection_kind === 'full'
      ? t('research.notes.writing.scope.full')
      : t('research.notes.writing.scope.range', {
          start: documentContext.start_utf16 ?? 0,
          end: documentContext.end_utf16 ?? 0,
        })
  const missingBindingIds = checks?.missing_binding_ids ?? []
  const checksUnavailable = checks === null || checks.unavailable_reason !== null
  return (
    <section
      className="space-y-2 rounded-md border p-3 text-xs"
      data-testid="writing-context-panel"
      aria-label={t('research.notes.writing.context.title')}
    >
      <header className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-sm font-semibold">{t('research.notes.writing.context.title')}</h4>
        <span className="text-muted-foreground" data-testid="writing-context-generation">
          {projection.generation_id}
        </span>
      </header>

      {restricted && (
        <div data-testid="writing-context-restricted" role="status" className="space-y-1">
          <p className="font-medium">{t('research.notes.writing.context.restricted')}</p>
          <p className="text-muted-foreground">
            {t('research.notes.writing.context.restrictedHint')}
          </p>
        </div>
      )}

      <dl className="grid grid-cols-1 gap-1 sm:grid-cols-2">
        <div>
          <dt className="text-muted-foreground">{t('research.notes.writing.context.noteMeta')}</dt>
          <dd data-testid="writing-context-note">
            {t('research.notes.writing.scope.noteMeta', {
              noteId: documentContext.note_id,
              revision: documentContext.revision,
            })}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">{t('research.notes.writing.scope.title')}</dt>
          <dd data-testid="writing-context-selection">{selectionLabel}</dd>
        </div>
      </dl>

      {!restricted && documentContext.selected_text !== null && (
        <div>
          <p className="mb-1 font-medium">
            {t('research.notes.writing.context.selectedText')}
          </p>
          <pre
            className="max-h-32 overflow-auto whitespace-pre-wrap break-words rounded bg-muted/40 p-2 font-mono text-[11px]"
            data-testid="writing-context-selected-text"
          >
            {truncate(documentContext.selected_text)}
          </pre>
        </div>
      )}

      <div data-testid="writing-context-history">
        <p className="font-medium">{t('research.notes.writing.context.history.title')}</p>
        <p className="text-muted-foreground">
          {history.mode === 'current'
            ? t('research.notes.writing.context.history.current')
            : t('research.notes.writing.context.history.none')}
        </p>
        <p className="mt-1 text-muted-foreground">
          {t('research.notes.writing.context.history.adopted')}
        </p>
        {history.adopted.length === 0 ? (
          <p className="text-muted-foreground" data-testid="writing-context-history-empty">
            {t('research.notes.writing.context.history.adoptedEmpty')}
          </p>
        ) : (
          <ul className="list-disc space-y-0.5 pl-4" data-testid="writing-context-history-adopted">
            {history.adopted.map((turn) => (
              <li key={turn.message_id}>
                <span className="text-muted-foreground">{turn.role}</span>{' '}
                <span className="font-mono">{shortHash(turn.message_id)}</span>
                {!restricted && turn.text !== null && (
                  <span className="text-muted-foreground"> — {truncate(turn.text)}</span>
                )}
              </li>
            ))}
          </ul>
        )}
        {history.excluded.length > 0 && (
          <>
            <p className="mt-1 text-muted-foreground">
              {t('research.notes.writing.context.history.excluded')}
            </p>
            <ul className="list-disc space-y-0.5 pl-4" data-testid="writing-context-history-excluded">
              {history.excluded.map((turn) => (
                <li key={turn.message_id}>
                  <span className="font-mono">{shortHash(turn.message_id)}</span>
                  <span className="text-muted-foreground">
                    {' '}
                    — {t(historyExcludedLabelKey(turn.reason))}
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>

      <div data-testid="writing-context-capacity">
        <p className="font-medium">{t('research.notes.writing.context.capacity.title')}</p>
        <p className="text-muted-foreground">
          {t('research.notes.writing.context.capacity.value', {
            input: capacity.input_utf8_bytes,
            envelope: capacity.envelope_utf8_bytes,
            limit: capacity.limit_utf8_bytes,
          })}
        </p>
      </div>

      <div data-testid="writing-context-integrity">
        <p className="font-medium">{t('research.notes.writing.context.integrity.title')}</p>
        <p className="font-mono text-muted-foreground">
          {t('research.notes.writing.context.integrity.hash', {
            hash: shortHash(projection.integrity.envelope_hash),
          })}
        </p>
      </div>

      <div data-testid="writing-checks">
        <p className="font-medium">{t('research.notes.writing.checks.title')}</p>
        {checksUnavailable ? (
          <p role="status" className="text-muted-foreground" data-testid="writing-checks-unavailable">
            {t('research.notes.writing.checks.unavailable')}
          </p>
        ) : missingBindingIds.length > 0 ? (
          <div role="status" data-testid="writing-checks-missing">
            <p className="font-medium text-amber-700 dark:text-amber-500">
              {t('research.notes.writing.checks.missing', {
                count: missingBindingIds.length,
              })}
            </p>
            <ul className="list-disc pl-4 font-mono text-muted-foreground">
              {missingBindingIds.map((bindingId) => (
                <li key={bindingId}>{bindingId}</li>
              ))}
            </ul>
          </div>
        ) : (
          <p className="text-muted-foreground" data-testid="writing-checks-none">
            {t('research.notes.writing.checks.none')}
          </p>
        )}
        <p className="mt-1 text-[11px] text-muted-foreground">
          {t('research.notes.writing.checks.disclaimer')}
        </p>
      </div>
    </section>
  )
}
