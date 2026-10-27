/**
 * PR-5b（DESIGN §7.3 / §10.2 F06 / §9.2 组件契约）：上下文说明报告。
 *
 * 投影规则（全部为「诚实呈现」断言，mock 证据，simulated）：
 * - complete/trimmed/blocked/unknown 四态各有独立文案；
 * - trimmed 展示省略类别/数量 + reason codes + 动作，且不声称「完整接续」；
 * - blocked 展示必要上下文缺失 + 动作，不自动重发；
 * - unknown 只显示「当时未记录容量信息」，**禁止把 null 显示成 0**、禁止显示完整；
 * - null 数字显示「未知」；
 * - 失败轮 variant（失败卡内）与成功消息同义渲染；
 * - 折叠默认收起，点击后展开。
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ResearchContextReportProjection } from '@/lib/research/session-contract'
import { ResearchContextReport } from './ResearchContextReport'

function report(
  overrides: Partial<ResearchContextReportProjection> = {},
): ResearchContextReportProjection {
  return {
    version: 1,
    status: 'trimmed',
    history: { availableTurns: 7, includedTurns: 4, omittedTurns: 3 },
    evidence: { includedChunks: 5, omittedChunks: 2 },
    inputBudget: 12000,
    serializedInputTokens: 9000,
    estimatorVersion: 'est-1',
    reasonCodes: ['history_trimmed', 'evidence_budget'],
    requiredContextMissing: false,
    measurementScope: 'final_reasoning_call',
    ...overrides,
  }
}

function renderReport(props: Partial<Parameters<typeof ResearchContextReport>[0]> = {}) {
  return render(<ResearchContextReport report={report()} {...props} />)
}

afterEach(() => {
  cleanup()
})

describe('ResearchContextReport（§7.3 上下文说明）', () => {
  it('默认收起；点击标题后展开状态、省略数量、reason codes 与动作', async () => {
    const onAdjustScope = vi.fn()
    const onShortenQuestion = vi.fn()
    const onNewSession = vi.fn()
    renderReport({ onAdjustScope, onShortenQuestion, onNewSession })

    const toggle = screen.getByRole('button', { name: /research\.capacity\.heading/ })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(screen.getByTestId('research-context-report')).toHaveAttribute('data-status', 'trimmed')

    await userEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('research.capacity.status.trimmed')).toBeInTheDocument()
    // 省略类别/数量：3 turns / 2 chunks 以数字呈现（t mock 返回键名）。
    expect(screen.getByTestId('ctx-omitted-history')).toHaveTextContent('3')
    expect(screen.getByTestId('ctx-omitted-evidence')).toHaveTextContent('2')
    // reason codes 原样列出（本地化映射缺失时不得吞掉）。
    expect(screen.getByText('history_trimmed')).toBeInTheDocument()
    expect(screen.getByText('evidence_budget')).toBeInTheDocument()
    // 不得声称完整接续。
    expect(screen.getByText('research.capacity.continuityDisclaimer')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'research.capacity.action.adjustScope' }))
    await userEvent.click(screen.getByRole('button', { name: 'research.capacity.action.shortenQuestion' }))
    await userEvent.click(screen.getByRole('button', { name: 'research.capacity.action.newSession' }))
    expect(onAdjustScope).toHaveBeenCalledTimes(1)
    expect(onShortenQuestion).toHaveBeenCalledTimes(1)
    expect(onNewSession).toHaveBeenCalledTimes(1)
  })

  it('blocked：展示必要上下文缺失与动作，不出现「重发」入口', async () => {
    renderReport({
      report: report({
        status: 'blocked',
        requiredContextMissing: true,
        reasonCodes: ['context_limit_exceeded'],
      }),
    })
    await userEvent.click(screen.getByRole('button', { name: /research\.capacity\.heading/ }))
    expect(screen.getByTestId('research-context-report')).toHaveAttribute('data-status', 'blocked')
    expect(screen.getByText('research.capacity.status.blocked')).toBeInTheDocument()
    expect(screen.getByText('research.capacity.requiredContextMissing')).toBeInTheDocument()
    expect(screen.getByText('context_limit_exceeded')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /resend/i })).toBeNull()
  })

  it('unknown：只显示「未记录」，不填零、不显示完整、数字为未知', async () => {
    renderReport({
      report: report({
        status: 'unknown',
        history: { availableTurns: null, includedTurns: null, omittedTurns: null },
        evidence: { includedChunks: null, omittedChunks: null },
        inputBudget: null,
        serializedInputTokens: null,
        reasonCodes: [],
        measurementScope: 'unknown',
      }),
    })
    await userEvent.click(screen.getByRole('button', { name: /research\.capacity\.heading/ }))
    expect(screen.getByTestId('research-context-report')).toHaveAttribute('data-status', 'unknown')
    expect(screen.getByText('research.capacity.status.unknown')).toBeInTheDocument()
    expect(screen.queryByText('research.capacity.status.complete')).toBeNull()
    // 未知计量不得显示 0。
    const budget = screen.getByTestId('ctx-budget')
    expect(budget).toHaveTextContent('research.capacity.unknownValue')
    expect(budget).not.toHaveTextContent('0')
    expect(screen.queryByTestId('ctx-history')).toBeNull()
  })

  it('complete：简短「未记录裁剪」，不伪造计数', async () => {
    renderReport({
      report: report({
        status: 'complete',
        history: { availableTurns: null, includedTurns: null, omittedTurns: null },
        evidence: { includedChunks: null, omittedChunks: null },
        reasonCodes: [],
      }),
    })
    await userEvent.click(screen.getByRole('button', { name: /research\.capacity\.heading/ }))
    expect(screen.getByText('research.capacity.status.complete')).toBeInTheDocument()
    expect(screen.queryByTestId('ctx-omitted-history')).toBeNull()
    expect(screen.queryByTestId('ctx-omitted-evidence')).toBeNull()
  })

  it('report 为 null 时按 unknown 投影（四来源全缺）', async () => {
    renderReport({ report: null })
    expect(screen.getByTestId('research-context-report')).toHaveAttribute('data-status', 'unknown')
    await userEvent.click(screen.getByRole('button', { name: /research\.capacity\.heading/ }))
    expect(screen.getByText('research.capacity.status.unknown')).toBeInTheDocument()
  })

  it('失败卡 variant 与成功消息同义：status/reason/动作 全部渲染', async () => {
    renderReport({
      variant: 'failed-card',
      report: report({ status: 'blocked', requiredContextMissing: true }),
      onShortenQuestion: vi.fn(),
    })
    expect(screen.getByTestId('research-context-report')).toHaveAttribute('data-variant', 'failed-card')
    expect(screen.getByText('research.capacity.status.blocked')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'research.capacity.action.shortenQuestion' })).toBeInTheDocument()
  })

  it('measurement_scope=final_reasoning_call 时注明只覆盖最后一次 REASON 调用', async () => {
    renderReport()
    await userEvent.click(screen.getByRole('button', { name: /research\.capacity\.heading/ }))
    expect(screen.getByText('research.capacity.measurementScope.finalReasoningCall')).toBeInTheDocument()
  })

  it('restricted 会话仍只渲染报告本身，不泄露标题/正文', () => {
    renderReport({ visibility: 'restricted' })
    expect(screen.queryByTestId('ctx-session-title')).toBeNull()
    expect(screen.getByTestId('research-context-report')).toBeInTheDocument()
  })
})
