import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'

import type { ResearchSessionRef } from '@/lib/research/session-contract'
import { createEditorState } from '@/lib/research/editor-machine'
import type {
  EditorSnapshot,
  ResearchConversationSnapshot,
  ResearchDraftGate,
  ResearchDraftGateReason,
} from '@/lib/research/types'
import { ResearchDraftComposer, deriveResearchDraftGate } from './ResearchDraftComposer'

vi.mock('@/lib/hooks/use-translation', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts ? `${key}:${String(opts.count ?? '')}` : key,
  }),
}))

const REF: ResearchSessionRef = {
  domain: 'research',
  kind: 'global',
  projectId: 'proj_1',
  sessionId: 'sess_1',
  sourceId: null,
}

const IDLE_CONVERSATION: ResearchConversationSnapshot = {
  activeTurnId: null,
  phase: 'idle',
  isStreaming: false,
  isBusy: false,
}

function makeSnapshot(overrides: Partial<EditorSnapshot> = {}): EditorSnapshot {
  const base = createEditorState({
    ref: REF,
    writerId: 'writer-1',
    transportAvailable: true,
  })
  return { ...base, phase: 'ready', loading: false, ...overrides }
}

const ALLOWED: ResearchDraftGate = { allowed: true, reason: null }

function renderComposer(overrides: {
  snapshot?: EditorSnapshot | null
  gate?: ResearchDraftGate
  gateReasonText?: string | null
  conversation?: ResearchConversationSnapshot
  onDraftChange?: (text: string) => void
  onSend?: () => void
  onRetrySave?: () => void
  onRestoreDraft?: (writerId: string) => void
} = {}) {
  const onDraftChange = overrides.onDraftChange ?? vi.fn()
  const onSend = overrides.onSend ?? vi.fn()
  const onRetrySave = overrides.onRetrySave ?? vi.fn()
  render(
    <ResearchDraftComposer
      editorSnapshot={
        overrides.snapshot === undefined ? makeSnapshot({ draftText: 'hello' }) : overrides.snapshot
      }
      conversationSnapshot={overrides.conversation ?? IDLE_CONVERSATION}
      gate={overrides.gate ?? ALLOWED}
      gateReasonText={overrides.gateReasonText ?? null}
      onDraftChange={onDraftChange}
      onSend={onSend}
      onRetrySave={onRetrySave}
      onRestoreDraft={overrides.onRestoreDraft}
    />,
  )
  return { onDraftChange, onSend, onRetrySave }
}

describe('ResearchDraftComposer', () => {
  it('C1 多行输入原样上抛（保留换行/首尾空白），不本地 trim', () => {
    const { onDraftChange } = renderComposer()

    const textarea = screen.getByTestId('chat-input')
    fireEvent.change(textarea, { target: { value: '  first line\nsecond line  ' } })

    expect(onDraftChange).toHaveBeenCalledTimes(1)
    expect(onDraftChange).toHaveBeenCalledWith('  first line\nsecond line  ')
  })

  it('C1 受控 value 来自 editor 快照（父层驱动）', () => {
    renderComposer({ snapshot: makeSnapshot({ draftText: 'from editor' }) })

    expect(screen.getByTestId('chat-input')).toHaveValue('from editor')
  })

  it('D1 点击发送只派发，不改写/不清空草稿', () => {
    const { onSend } = renderComposer({ snapshot: makeSnapshot({ draftText: 'keep me' }) })

    fireEvent.click(screen.getByTestId('chat-send'))

    expect(onSend).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('chat-input')).toHaveValue('keep me')
  })

  it('C2 Enter 发送，Shift+Enter 换行不发送', () => {
    const { onSend } = renderComposer()

    const textarea = screen.getByTestId('chat-input')
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: true })
    expect(onSend).not.toHaveBeenCalled()

    fireEvent.keyDown(textarea, { key: 'Enter' })
    expect(onSend).toHaveBeenCalledTimes(1)
  })

  it('C2 IME 组合期间 Enter 不发送；compositionend 后的 Enter 才发送', () => {
    const { onSend } = renderComposer()

    const textarea = screen.getByTestId('chat-input')
    fireEvent.compositionStart(textarea)
    fireEvent.keyDown(textarea, { key: 'Enter', isComposing: true })
    expect(onSend).not.toHaveBeenCalled()

    fireEvent.compositionEnd(textarea)
    fireEvent.keyDown(textarea, { key: 'Enter' })
    expect(onSend).toHaveBeenCalledTimes(1)
  })

  it('C3 保存状态可见：dirty/saving/clean', () => {
    const { unmount } = render(
      <ResearchDraftComposer
        editorSnapshot={makeSnapshot({ draftText: 'x', dirty: true })}
        conversationSnapshot={IDLE_CONVERSATION}
        gate={ALLOWED}
        gateReasonText={null}
        onDraftChange={vi.fn()}
        onSend={vi.fn()}
        onRetrySave={vi.fn()}
      />,
    )
    expect(screen.getByTestId('research-draft-save-state')).toHaveTextContent(
      'research.editor.unsavedDraft',
    )
    unmount()

    renderComposer({ snapshot: makeSnapshot({ draftText: 'x', saving: true }) })
    expect(screen.getByTestId('research-draft-save-state')).toHaveTextContent(
      'research.resultActions.saving',
    )

    renderComposer({ snapshot: makeSnapshot({ draftText: 'x' }) })
    const states = screen.getAllByTestId('research-draft-save-state')
    expect(states[states.length - 1]).toHaveTextContent('research.editor.saved')
  })

  it('C3 blocked / conflict / readonly 显示稳定状态文案', () => {
    renderComposer({ snapshot: makeSnapshot({ blocked: true }) })
    expect(screen.getByTestId('research-draft-save-state')).toHaveTextContent(
      'research.editor.blocked',
    )

    renderComposer({
      snapshot: makeSnapshot({ conflict: { kind: 'revision' } }),
    })
    const conflictStates = screen.getAllByTestId('research-draft-save-state')
    expect(conflictStates[conflictStates.length - 1]).toHaveTextContent(
      'research.errors.revisionChanged',
    )
  })

  it('C4 保存失败时提供重试保存动作入口', () => {
    const { onRetrySave } = renderComposer({
      snapshot: makeSnapshot({ saveFailure: { code: 'editor_write_failed', retryable: true } }),
    })

    fireEvent.click(screen.getByTestId('research-draft-save-retry'))
    expect(onRetrySave).toHaveBeenCalledTimes(1)
  })

  it('C5 门禁：save_failed 时发送禁用并显示原因，aria-describedby 指向原因', () => {
    renderComposer({
      snapshot: makeSnapshot({ saveFailure: { code: 'editor_write_failed', retryable: true } }),
      gate: { allowed: false, reason: 'save_failed' },
      gateReasonText: 'research.resultActions.saveFailed',
    })

    expect(screen.getByTestId('chat-send')).toBeDisabled()
    const hint = screen.getByTestId('research-draft-gate-hint')
    expect(hint).toHaveTextContent('research.resultActions.saveFailed')
    expect(hint).toHaveAttribute('role', 'alert')
    expect(screen.getByTestId('chat-input')).toHaveAttribute(
      'aria-describedby',
      hint.getAttribute('id'),
    )
  })

  it('C6 全部门禁原因都有非空文案映射（不得静默禁用）', () => {
    const reasons: ResearchDraftGateReason[] = [
      'runtime_unavailable',
      'editor_not_ready',
      'editor_unreadable',
      'submission_not_ready',
      'save_failed',
      'saving',
      'conflict',
      'blocked',
      'readonly',
      'invalidated',
      'oversize',
      'empty_draft',
      'scope_invalid',
      'turn_active',
    ]

    for (const reason of reasons) {
      const { unmount } = render(
        <ResearchDraftComposer
          editorSnapshot={makeSnapshot({ draftText: 'x' })}
          conversationSnapshot={IDLE_CONVERSATION}
          gate={{ allowed: false, reason }}
          gateReasonText={`gate:${reason}`}
          onDraftChange={vi.fn()}
          onSend={vi.fn()}
          onRetrySave={vi.fn()}
        />,
      )
      expect(screen.getByTestId('chat-send')).toBeDisabled()
      expect(screen.getByTestId('research-draft-gate-hint')).toHaveTextContent(`gate:${reason}`)
      unmount()
    }
  })

  it('C7 scope_invalid 时发送禁用并提示选择资料', () => {
    renderComposer({
      snapshot: makeSnapshot({ draftText: 'x', baseScope: { mode: 'selected', sourceIds: [], singleSourceId: null } }),
      gate: { allowed: false, reason: 'scope_invalid' },
      gateReasonText: 'research.layout.scope.selectItemRequired',
    })

    expect(screen.getByTestId('chat-send')).toBeDisabled()
    expect(screen.getByTestId('research-draft-gate-hint')).toHaveTextContent(
      'research.layout.scope.selectItemRequired',
    )
  })

  it('C8 本机草稿恢复候选提供恢复动作入口', () => {
    const onRestoreDraft = vi.fn()
    renderComposer({
      snapshot: makeSnapshot({
        restoreCandidates: [
          {
            writerId: 'writer-9',
            localVersion: 3,
            baseRevision: 2,
            savedAt: '2026-10-27T00:00:00Z',
            dirty: true,
          },
        ],
      }),
      onRestoreDraft,
    })

    fireEvent.click(screen.getByTestId('research-draft-restore'))
    expect(onRestoreDraft).toHaveBeenCalledWith('writer-9')
  })

  it('C9 无 editor 快照时显示运行时不可用原因且发送禁用', () => {
    renderComposer({
      snapshot: null,
      gate: { allowed: false, reason: 'runtime_unavailable' },
      gateReasonText: 'research.errors.internal',
    })

    expect(screen.getByTestId('chat-send')).toBeDisabled()
    expect(screen.getByTestId('research-draft-gate-hint')).toHaveTextContent(
      'research.errors.internal',
    )
  })

  it('C14 submission capability 未就绪 → submission_not_ready（§6.1 条件 2）', () => {
    const gate = deriveResearchDraftGate({
      editorSnapshot: makeSnapshot({ draftText: '问题', dirty: true }),
      conversationSnapshot: IDLE_CONVERSATION,
      submissionReady: false,
    })
    expect(gate).toEqual({ allowed: false, reason: 'submission_not_ready' })
  })

  it('C15 effective all 携带非空 Note → scope_invalid（§5.3/§6.1）', () => {
    const gate = deriveResearchDraftGate({
      editorSnapshot: makeSnapshot({
        draftText: '问题',
        dirty: true,
        baseScope: { mode: 'all', sourceIds: [], singleSourceId: null },
        noteIds: ['note_1'],
      }),
      conversationSnapshot: IDLE_CONVERSATION,
    })
    expect(gate).toEqual({ allowed: false, reason: 'scope_invalid' })
  })
})