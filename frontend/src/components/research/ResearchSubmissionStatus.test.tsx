/**
 * PR-5b（DESIGN §6.7 / §10.2 F10/F15 / §9.2 组件契约）：提交状态与恢复动作。
 *
 * 只做「可证明」动作，绝不自动清稿/换键/重发/覆盖非空稿（mock 证据，simulated）：
 * - accepted（执行中/排队）、terminal completed/failed、outcome_unknown、lookup_failed、not_observed；
 * - 查回失败保留草稿与未知标记、提示可再次查回；
 * - `submitted_draft_text` 仅显式查看/复制；当前稿为空才提供「恢复上一份已提交草稿」；
 * - 非空稿禁止自动覆盖；组件挂载时不自动 lookup/restore/copy。
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {
  ResearchSubmissionStatus,
  type ResearchSubmissionStatusView,
} from './ResearchSubmissionStatus'

function view(overrides: Partial<ResearchSubmissionStatusView> = {}): ResearchSubmissionStatusView {
  return {
    kind: 'accepted',
    generationId: 'gen_1',
    generationState: 'running',
    submittedDraftText: 'submitted question',
    ...overrides,
  } as ResearchSubmissionStatusView
}

function renderStatus(
  submissionView: ResearchSubmissionStatusView | null,
  props: Partial<Parameters<typeof ResearchSubmissionStatus>[0]> = {},
) {
  const handlers = {
    onLookup: vi.fn(),
    onRestore: vi.fn(),
    onCopy: vi.fn(),
    onRetryManually: vi.fn(),
  }
  const result = render(
    <ResearchSubmissionStatus
      submissionView={submissionView}
      currentDraft={null}
      {...handlers}
      {...props}
    />,
  )
  return { ...result, handlers }
}

afterEach(() => {
  cleanup()
})

describe('ResearchSubmissionStatus（§6.7 提交状态与恢复）', () => {
  it('挂载时不自动查回/恢复/复制（不自动重发）', () => {
    const { handlers } = renderStatus(view())
    expect(handlers.onLookup).not.toHaveBeenCalled()
    expect(handlers.onRestore).not.toHaveBeenCalled()
    expect(handlers.onCopy).not.toHaveBeenCalled()
    expect(handlers.onRetryManually).not.toHaveBeenCalled()
  })

  it('accepted：显示已提交/执行中，可查回，不出现自动重发', async () => {
    const { handlers } = renderStatus(view(), { currentDraft: 'new draft T2' })
    expect(screen.getByTestId('research-submission-status')).toHaveAttribute('data-kind', 'accepted')
    expect(screen.getByText('research.submission.accepted')).toBeInTheDocument()
    expect(screen.getByText(/research\.submission\.generationState\.running/)).toBeInTheDocument()
    // 非空稿：不提供恢复入口（禁止自动覆盖）。
    expect(screen.queryByRole('button', { name: 'research.submission.restoreSubmitted' })).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'research.submission.lookup' }))
    expect(handlers.onLookup).toHaveBeenCalledTimes(1)
    expect(handlers.onRestore).not.toHaveBeenCalled()
  })

  it('terminal completed：可找回/查看/复制已提交稿；不自动清稿', async () => {
    const { handlers } = renderStatus(
      view({ kind: 'terminal', outcome: 'completed' } as Partial<ResearchSubmissionStatusView>),
      { currentDraft: '' },
    )
    expect(screen.getByText('research.submission.terminalCompleted')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'research.submission.viewSubmitted' }))
    expect(screen.getByTestId('submitted-draft-text')).toHaveTextContent('submitted question')
    await userEvent.click(screen.getByRole('button', { name: 'research.submission.copySubmitted' }))
    expect(handlers.onCopy).toHaveBeenCalledWith('submitted question')
    await userEvent.click(screen.getByRole('button', { name: 'research.submission.restoreSubmitted' }))
    expect(handlers.onRestore).toHaveBeenCalledWith('submitted question')
  })

  it('terminal failed：显示失败码；空稿才提供恢复', () => {
    renderStatus(view({ kind: 'terminal', outcome: 'failed', failureCode: 'generation_failed' } as Partial<ResearchSubmissionStatusView>), {
      currentDraft: null,
    })
    expect(screen.getByText('research.submission.terminalFailed')).toBeInTheDocument()
    expect(screen.getByText('generation_failed')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'research.submission.restoreSubmitted' })).toBeInTheDocument()
  })

  it('outcome_unknown：结果未知/可能计费，需显式人工重试，无自动重发', async () => {
    const { handlers } = renderStatus(view({ kind: 'outcome_unknown' } as Partial<ResearchSubmissionStatusView>), {
      currentDraft: 'kept draft',
    })
    expect(screen.getByText('research.submission.outcomeUnknown')).toBeInTheDocument()
    expect(screen.getByText('research.submission.outcomeUnknownHint')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'research.submission.manualRetry' }))
    expect(handlers.onRetryManually).toHaveBeenCalledTimes(1)
    expect(handlers.onRestore).not.toHaveBeenCalled()
  })

  it('lookup_failed：提示无法确认状态、保留草稿与可查回，不清稿/不换键', () => {
    renderStatus(view({ kind: 'lookup_failed' } as Partial<ResearchSubmissionStatusView>), {
      currentDraft: 'kept draft',
    })
    expect(screen.getByText('research.submission.lookupFailed')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'research.submission.lookup' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'research.submission.restoreSubmitted' })).toBeNull()
  })

  it('not_observed：不证明未受理，保留标记与可查回', () => {
    renderStatus({ kind: 'not_observed' }, { currentDraft: 'kept draft' })
    expect(screen.getByText('research.submission.notObserved')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'research.submission.lookup' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'research.submission.restoreSubmitted' })).toBeNull()
  })

  it('submission 查回来源携带 context_report 时用同一投影渲染（失败轮同义）', () => {
    renderStatus(view(), {
      contextReport: {
        version: 1,
        status: 'blocked',
        history: { availableTurns: null, includedTurns: null, omittedTurns: null },
        evidence: { includedChunks: null, omittedChunks: null },
        inputBudget: null,
        serializedInputTokens: null,
        estimatorVersion: null,
        reasonCodes: ['context_limit_exceeded'],
        requiredContextMissing: true,
        measurementScope: 'unknown',
      },
    })
    expect(screen.getByTestId('research-context-report')).toBeInTheDocument()
    expect(screen.getByText('research.capacity.status.blocked')).toBeInTheDocument()
  })

  it('null 视图不渲染任何状态卡（无从证明）', () => {
    renderStatus(null)
    expect(screen.queryByTestId('research-submission-status')).toBeNull()
  })
})
