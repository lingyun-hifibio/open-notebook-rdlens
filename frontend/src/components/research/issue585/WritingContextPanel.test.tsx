/**
 * Issue #1048 PR7：实际输入回看面板测试。
 *
 * 覆盖：选区/版本/历史采用与未采用/容量/摘要展示；受限时只显示受限状态；
 * writing_checks 缺失引用提示（不冒充完整保留）与报告不可用说明。
 */
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { WritingContextPanel } from './WritingContextPanel'
import type { WritingContextProjection } from '@/lib/research/issue585/writing-types'

vi.mock('@/lib/hooks/use-translation', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts ? `${key} ${Object.values(opts).join(' ')}` : key,
  }),
}))

function projection(overrides: Partial<WritingContextProjection> = {}): WritingContextProjection {
  return {
    generation_id: 'gen_1',
    input_id: 'inp_' + 'd'.repeat(64),
    input_schema_version: 4,
    input_hash: 'e'.repeat(64),
    document_context: {
      note_id: 'note_abc',
      revision: 4,
      snapshot_hash: 'a'.repeat(64),
      selection_kind: 'range',
      start_utf16: 1,
      end_utf16: 3,
      selected_text: '冻结选段',
      selected_text_hash: 'f'.repeat(64),
    },
    history: {
      mode: 'current',
      adopted: [{ message_id: 'msg_1', role: 'user', text: '采用的历史', text_hash: '1'.repeat(64) }],
      excluded: [
        { message_id: 'msg_2', reason: 'history_budget_excluded' },
        { message_id: 'msg_3', reason: 'history_scope_excluded' },
        { message_id: 'msg_4', reason: 'history_authority_excluded' },
      ],
    },
    integrity: {
      document_context_hash: '2'.repeat(64),
      history_hash: '3'.repeat(64),
      envelope_hash: '4'.repeat(64),
    },
    capacity: { input_utf8_bytes: 100, envelope_utf8_bytes: 120, limit_utf8_bytes: 1048576 },
    writing_checks: { version: 1, missing_binding_ids: ['bind_1', 'bind_2'], unavailable_reason: null },
    access_state: 'visible',
    ...overrides,
  }
}

describe('WritingContextPanel', () => {
  it('展示实际输入：选区/版本、采用与未采用历史、容量、摘要', () => {
    render(<WritingContextPanel projection={projection()} error={null} loading={false} />)
    expect(screen.getByTestId('writing-context-panel')).toBeInTheDocument()
    expect(screen.getByTestId('writing-context-note')).toHaveTextContent('note_abc')
    expect(screen.getByTestId('writing-context-selection').textContent).toContain('1')
    expect(screen.getByTestId('writing-context-selected-text')).toHaveTextContent('冻结选段')
    expect(screen.getByTestId('writing-context-history-adopted')).toHaveTextContent('采用的历史')
    expect(screen.getByTestId('writing-context-history-excluded')).toHaveTextContent(
      'research.notes.writing.context.history.excludedBudget',
    )
    expect(screen.getByTestId('writing-context-history-excluded')).toHaveTextContent(
      'research.notes.writing.context.history.excludedScope',
    )
    expect(screen.getByTestId('writing-context-history-excluded')).toHaveTextContent(
      'research.notes.writing.context.history.excludedAuthority',
    )
    expect(screen.getByTestId('writing-context-capacity')).toBeInTheDocument()
    expect(screen.getByTestId('writing-context-integrity')).toBeInTheDocument()
  })

  it('writing_checks 缺失引用 → 明确提示「部分输入引用未在建议中沿用」', () => {
    render(<WritingContextPanel projection={projection()} error={null} loading={false} />)
    expect(screen.getByTestId('writing-checks-missing')).toHaveTextContent(
      'research.notes.writing.checks.missing',
    )
    expect(screen.getByTestId('writing-checks-missing')).toHaveTextContent('bind_1')
    expect(screen.queryByTestId('writing-checks-none')).not.toBeInTheDocument()
  })

  it('无缺失引用 → 不显示缺失提示，但保留“派生提示”免责声明', () => {
    render(
      <WritingContextPanel
        projection={projection({
          writing_checks: { version: 1, missing_binding_ids: [], unavailable_reason: null },
        })}
        error={null}
        loading={false}
      />,
    )
    expect(screen.getByTestId('writing-checks-none')).toBeInTheDocument()
    expect(screen.getByTestId('writing-checks')).toHaveTextContent(
      'research.notes.writing.checks.disclaimer',
    )
  })

  it('writing_checks null / unavailable_reason → 报告不可用，不声称完整保留', () => {
    const { rerender } = render(
      <WritingContextPanel projection={projection({ writing_checks: null })} error={null} loading={false} />,
    )
    expect(screen.getByTestId('writing-checks-unavailable')).toBeInTheDocument()
    expect(screen.queryByTestId('writing-checks-none')).not.toBeInTheDocument()
    rerender(
      <WritingContextPanel
        projection={projection({
          writing_checks: { version: 1, missing_binding_ids: [], unavailable_reason: 'store_missing' },
        })}
        error={null}
        loading={false}
      />,
    )
    expect(screen.getByTestId('writing-checks-unavailable')).toBeInTheDocument()
  })

  it('受限只显示受限状态，不展示冻结正文', () => {
    render(
      <WritingContextPanel
        projection={projection({
          access_state: 'restricted',
          document_context: {
            ...projection().document_context,
            selected_text: null,
          },
          history: {
            mode: 'none',
            adopted: [{ message_id: 'msg_1', role: 'user', text: null, text_hash: '1'.repeat(64) }],
            excluded: [],
          },
        })}
        error={null}
        loading={false}
      />,
    )
    expect(screen.getByTestId('writing-context-restricted')).toHaveTextContent(
      'research.notes.writing.context.restricted',
    )
    expect(screen.queryByTestId('writing-context-selected-text')).not.toBeInTheDocument()
    expect(screen.queryByText('冻结选段')).not.toBeInTheDocument()
  })

  it('加载中/不可用有明确状态', () => {
    const { rerender } = render(<WritingContextPanel projection={null} error={null} loading />)
    expect(screen.getByTestId('writing-context-loading')).toBeInTheDocument()
    rerender(
      <WritingContextPanel
        projection={null}
        error={{ code: 'writing_input_unavailable', message: '', retryable: true, status: 503 }}
        loading={false}
      />,
    )
    expect(screen.getByTestId('writing-context-unavailable')).toHaveTextContent(
      'research.notes.writing.context.unavailable',
    )
  })
})
