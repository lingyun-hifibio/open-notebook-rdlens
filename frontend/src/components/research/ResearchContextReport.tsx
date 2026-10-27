'use client'

/**
 * 上下文说明（DESIGN §7.3 / §10.2 F06 / §9.2 组件契约）。
 *
 * 一个纯展示投影，四处复用：assistant 消息下方、失败卡、提交状态卡与
 * 重开历史。规则：
 * - `complete/trimmed/blocked/unknown` 四态独立文案；未知计量显示「未知」，
 *   **绝不把 null 填成 0**，也不把缺失报告说成「完整」；
 * - trimmed 展示省略类别/数量 + reason codes + 动作，但不声称完整接续；
 * - blocked 展示必要上下文缺失与动作，不提供自动重发；
 * - 失败轮（`variant='failed-card'`）与成功消息同一投影、同一文案。
 */

import { useId, useState } from 'react'

import { useTranslation } from '@/lib/hooks/use-translation'
import type {
  ResearchContextReportProjection,
  ResearchSessionVisibility,
} from '@/lib/research/session-contract'

export interface ResearchContextReportProps {
  readonly report: ResearchContextReportProjection | null | undefined
  /** 会话可见性；restricted 时仅渲染报告本身，不泄露标题/正文。 */
  readonly visibility?: ResearchSessionVisibility
  readonly variant?: 'inline' | 'failed-card'
  readonly defaultOpen?: boolean
  readonly onAdjustScope?: () => void
  readonly onShortenQuestion?: () => void
  readonly onNewSession?: () => void
}

/** 静态字面量映射（i18n 扫描器按字面量统计引用，禁止模板拼接）。 */
const STATUS_KEYS = {
  complete: 'research.capacity.status.complete',
  trimmed: 'research.capacity.status.trimmed',
  blocked: 'research.capacity.status.blocked',
  unknown: 'research.capacity.status.unknown',
} as const

export function ResearchContextReport({
  report,
  visibility = 'visible',
  variant = 'inline',
  defaultOpen,
  onAdjustScope,
  onShortenQuestion,
  onNewSession,
}: ResearchContextReportProps) {
  const { t } = useTranslation()
  const regionId = useId()
  const [open, setOpen] = useState<boolean>(defaultOpen ?? variant === 'failed-card')

  const status = report?.status ?? 'unknown'
  const reasonCodes = report?.reasonCodes ?? []
  const displayable = status === 'trimmed' || status === 'blocked'

  const numberText = (value: number | null | undefined): string =>
    value === null || value === undefined
      ? t('research.capacity.unknownValue')
      : String(value)

  return (
    <section
      data-testid="research-context-report"
      data-status={status}
      data-variant={variant}
      data-visibility={visibility}
      aria-label={t('research.capacity.heading')}
      className="rounded-md border border-border/60 bg-muted/20 px-3 py-2 text-xs"
    >
      <button
        type="button"
        className="flex w-full items-center justify-between gap-2 text-left font-medium"
        aria-expanded={open}
        aria-controls={regionId}
        onClick={() => setOpen((prev) => !prev)}
      >
        <span>{t('research.capacity.heading')}</span>
        <span className="text-muted-foreground">{t(STATUS_KEYS[status])}</span>
      </button>

      {open ? (
        <div id={regionId} className="mt-2 space-y-1.5 text-muted-foreground">
          {status === 'trimmed' || status === 'blocked' ? (
            <p data-testid="ctx-omitted-history">
              {t('research.capacity.omittedHistory')}: {numberText(report?.history?.omittedTurns)}
            </p>
          ) : null}
          {status === 'trimmed' || status === 'blocked' ? (
            <p data-testid="ctx-omitted-evidence">
              {t('research.capacity.omittedEvidence')}: {numberText(report?.evidence?.omittedChunks)}
            </p>
          ) : null}

          {status === 'trimmed' || status === 'blocked' ? (
            <p data-testid="ctx-history">
              {t('research.capacity.history')}: {numberText(report?.history?.includedTurns)} / {numberText(report?.history?.availableTurns)}
            </p>
          ) : null}
          {status === 'trimmed' || status === 'blocked' ? (
            <p data-testid="ctx-evidence">
              {t('research.capacity.evidence')}: {numberText(report?.evidence?.includedChunks)}
            </p>
          ) : null}

          <p data-testid="ctx-budget">
            {t('research.capacity.inputBudget')}: {numberText(report?.inputBudget)}
            {' · '}
            {t('research.capacity.serializedTokens')}: {numberText(report?.serializedInputTokens)}
            {' · '}
            {t('research.capacity.estimatorVersion')}:{' '}
            {report?.estimatorVersion ?? t('research.capacity.unknownValue')}
          </p>

          {reasonCodes.length > 0 ? (
            <div>
              <p>{t('research.capacity.reasonCodes')}</p>
              <ul className="list-disc pl-4">
                {reasonCodes.map((code) => {
                  const key = `research.capacity.reason.${code}`
                  const label = t(key)
                  return <li key={code}>{label === key ? code : label}</li>
                })}
              </ul>
            </div>
          ) : null}

          {report?.requiredContextMissing === true ? (
            <p data-testid="ctx-required-missing">{t('research.capacity.requiredContextMissing')}</p>
          ) : null}

          {displayable ? (
            <p data-testid="ctx-continuity">{t('research.capacity.continuityDisclaimer')}</p>
          ) : null}

          {report?.measurementScope === 'final_reasoning_call' ? (
            <p data-testid="ctx-measurement-scope">
              {t('research.capacity.measurementScope.finalReasoningCall')}
            </p>
          ) : null}

          {displayable && (onAdjustScope || onShortenQuestion || onNewSession) ? (
            <div className="flex flex-wrap gap-2 pt-1">
              {onAdjustScope ? (
                <button type="button" className="underline" onClick={onAdjustScope}>
                  {t('research.capacity.action.adjustScope')}
                </button>
              ) : null}
              {onShortenQuestion ? (
                <button type="button" className="underline" onClick={onShortenQuestion}>
                  {t('research.capacity.action.shortenQuestion')}
                </button>
              ) : null}
              {onNewSession ? (
                <button type="button" className="underline" onClick={onNewSession}>
                  {t('research.capacity.action.newSession')}
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  )
}
