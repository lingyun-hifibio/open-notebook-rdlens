import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

vi.mock('@/lib/hooks/use-translation', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    language: 'zh-CN',
    setLanguage: vi.fn(),
  }),
}))

import { ResearchWorkspaceProvider } from '@/lib/embedded/workspace-context'
import { ResearchScopeProvider, useResearchScope } from '@/lib/research/scope'
import { TargetComposer } from './TargetComposer'
import type { UseResearchEditorResult } from '@/lib/hooks/use-research-editor'
import type { EditorSnapshot, ResearchWorkPurpose } from '@/lib/research/types'
import { deriveResearchDraftGate } from '../ResearchDraftComposer'

// W1 #1106 PR-B（UI-11）：composer「本次用途」专属测试——
// 摘要/展开三选/自动判断控件态/能力关闭静态摘要/写作 W3 诚实文案/
// 键盘 Esc+焦点/状态非仅颜色（aria-pressed）。

const editorStub = {
  snapshot: null,
  controller: null,
  transportWired: false,
  setDraftText: vi.fn(),
  setScope: vi.fn(),
  setChatAnchor: vi.fn(),
  setReaderAnchor: vi.fn(),
  flush: vi.fn(async () => 'skipped' as const),
  hold: vi.fn(),
  release: vi.fn(),
  retrySave: vi.fn(async () => 'skipped' as const),
  adoptServerVersion: vi.fn(async () => 'skipped' as const),
  saveLocalOverServer: vi.fn(async () => 'skipped' as const),
  clearAfterSubmission: vi.fn(async () => 'cleared' as const),
  markTokenConsumed: vi.fn(),
  canSubmit: vi.fn(() => ({ allowed: true as const })),
  restoreDraft: vi.fn(),
  refreshDraftCandidates: vi.fn(),
  releaseDocument: vi.fn(),
} as unknown as UseResearchEditorResult

function Harness({
  capability = true,
  initialPurpose = null,
  initialMenuOpen = false,
  onChange = vi.fn(),
  sessionWired = false,
  editorSnapshot = null,
  selectionChip = null,
}: {
  capability?: boolean
  initialPurpose?: ResearchWorkPurpose | null
  initialMenuOpen?: boolean
  onChange?: (purpose: ResearchWorkPurpose | null) => void
  sessionWired?: boolean
  editorSnapshot?: EditorSnapshot | null
  selectionChip?: {
    label: string
    title?: string
    onRemove: () => void
  } | null
}) {
  const [purpose, setPurpose] = useState<ResearchWorkPurpose | null>(initialPurpose)
  const [open, setOpen] = useState(initialMenuOpen)
  const scope = useResearchScope()
  return (
    <>
    {/* 测试辅助：真实单篇 pin（验证选段 chip 与 single chip 并存）。 */}
    <button
      type="button"
      data-testid="harness-pin-single"
      onClick={() => scope.setSingle('src_1', 'sess_1')}
    />
    <TargetComposer
      sessionWired={sessionWired}
      editor={editorStub}
      editorSnapshot={editorSnapshot}
      submissionReady={undefined}
      isStreaming={false}
      canExecute
      blockedHint=""
      scopeBlockedText={null}
      noActiveSession={false}
      sendError={null}
      onClearSendError={() => {}}
      onSend={async () => true}
      onOpenSearch={() => {}}
      onOpenCompare={() => {}}
      searchAvailable
      compareAvailable
      secondaryBlockedReason={null}
      compactScopeChip={null}
      onCompactScopeChipActivate={() => {}}
      selectionChip={selectionChip}
      workPurpose={purpose}
      onWorkPurposeChange={(next) => {
        setPurpose(next)
        onChange(next)
      }}
      purposeInferenceAvailable={capability}
      purposeMenuOpen={open}
      onPurposeMenuOpenChange={setOpen}
    />
    </>
  )
}

function renderComposer(props: Parameters<typeof Harness>[0] = {}) {
  return render(
    <ResearchWorkspaceProvider projectId="proj_1" role="owner" userId="user_1">
      <ResearchScopeProvider userId="user_1" projectId="proj_1">
        <Harness {...props} />
      </ResearchScopeProvider>
    </ResearchWorkspaceProvider>,
  )
}

afterEach(() => {
  cleanup()
})

describe('TargetComposer #1106 本次用途', () => {
  it('默认自动判断：摘要显示自动判断，展开后四选项、auto aria-pressed', () => {
    renderComposer()
    const container = screen.getByTestId('rdlens-target-purpose')
    expect(container).toHaveAttribute('data-purpose', 'auto')
    expect(container).toHaveAttribute('data-purpose-inference', 'true')
    const toggle = screen.getByTestId('rdlens-target-purpose-toggle')
    expect(toggle).toHaveTextContent('research.target.composer.purpose.summary')
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    // LOW：未展开时不得输出悬空 aria-controls。
    expect(toggle).not.toHaveAttribute('aria-controls')

    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(toggle).toHaveAttribute('aria-controls', 'rdlens-target-purpose-options')
    expect(screen.getByTestId('rdlens-target-purpose-options')).toBeInTheDocument()
    for (const id of ['auto', 'document_qa', 'exploration', 'writing']) {
      expect(screen.getByTestId(`rdlens-target-purpose-option-${id}`)).toBeInTheDocument()
    }
    expect(screen.getByTestId('rdlens-target-purpose-option-auto')).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    expect(screen.getByTestId('rdlens-target-purpose-option-exploration')).toHaveAttribute(
      'aria-pressed',
      'false',
    )
  })

  it('选择探索讨论 → 回调 exploration、摘要更新、菜单收起', () => {
    const onChange = vi.fn()
    renderComposer({ onChange })
    fireEvent.click(screen.getByTestId('rdlens-target-purpose-toggle'))
    fireEvent.click(screen.getByTestId('rdlens-target-purpose-option-exploration'))
    expect(onChange).toHaveBeenCalledWith('exploration')
    expect(screen.getByTestId('rdlens-target-purpose')).toHaveAttribute(
      'data-purpose',
      'exploration',
    )
    expect(screen.getByTestId('rdlens-target-purpose-toggle')).toHaveAttribute(
      'aria-expanded',
      'false',
    )
    expect(screen.queryByTestId('rdlens-target-purpose-options')).toBeNull()
  })

  it('写作选项展示诚实 W3 文案；选择写作 → writing', () => {
    const onChange = vi.fn()
    renderComposer({ onChange })
    fireEvent.click(screen.getByTestId('rdlens-target-purpose-toggle'))
    expect(screen.getByTestId('rdlens-target-purpose-writing-hint')).toHaveTextContent(
      'research.target.composer.purpose.writingHint',
    )
    fireEvent.click(screen.getByTestId('rdlens-target-purpose-option-writing'))
    expect(onChange).toHaveBeenCalledWith('writing')
  })

  it('显式态下选择自动判断 → null（省略字段由服务端推断）', () => {
    const onChange = vi.fn()
    renderComposer({ initialPurpose: 'exploration', onChange })
    expect(screen.getByTestId('rdlens-target-purpose')).toHaveAttribute(
      'data-purpose',
      'exploration',
    )
    fireEvent.click(screen.getByTestId('rdlens-target-purpose-toggle'))
    fireEvent.click(screen.getByTestId('rdlens-target-purpose-option-auto'))
    expect(onChange).toHaveBeenCalledWith(null)
  })

  it('能力位非严格 true：只显示「默认（资料问答）」静态摘要，不渲染假控件', () => {
    renderComposer({ capability: false })
    const container = screen.getByTestId('rdlens-target-purpose')
    expect(container).toHaveAttribute('data-purpose', 'default')
    expect(container).toHaveAttribute('data-purpose-inference', 'false')
    expect(screen.getByTestId('rdlens-target-purpose-default')).toHaveTextContent(
      'research.target.composer.purpose.defaultSummary',
    )
    expect(screen.queryByTestId('rdlens-target-purpose-toggle')).toBeNull()
    expect(screen.queryByTestId('rdlens-target-purpose-options')).toBeNull()
  })

  it('键盘：Esc 关闭展开并把焦点还给用途控件', () => {
    renderComposer({ initialMenuOpen: true })
    const toggle = screen.getByTestId('rdlens-target-purpose-toggle')
    expect(screen.getByTestId('rdlens-target-purpose-options')).toBeInTheDocument()
    fireEvent.keyDown(screen.getByTestId('rdlens-target-purpose-options'), { key: 'Escape' })
    expect(screen.queryByTestId('rdlens-target-purpose-options')).toBeNull()
    expect(document.activeElement).toBe(toggle)
  })

  it('外部打开（回答「改用途」入口）时把焦点送到用途控件', () => {
    renderComposer({ initialMenuOpen: true })
    expect(document.activeElement).toBe(screen.getByTestId('rdlens-target-purpose-toggle'))
  })

  it('#120 L3：点面板内不关闭；点面板外关闭（不抢焦点）', () => {
    renderComposer({ initialMenuOpen: true })
    fireEvent.pointerDown(screen.getByTestId('rdlens-target-purpose-options'))
    expect(screen.getByTestId('rdlens-target-purpose-options')).toBeInTheDocument()
    fireEvent.pointerDown(document.body)
    expect(screen.queryByTestId('rdlens-target-purpose-options')).toBeNull()
  })
})


/** #1106/D5：最小可放行 EditorSnapshot（空 selected 范围）。 */
function editorSnapshot(overrides: Partial<EditorSnapshot> = {}): EditorSnapshot {
  return {
    ref: { domain: 'research', kind: 'global', projectId: 'p', sessionId: 's', sourceId: null },
    phase: 'ready',
    loading: false,
    revision: 1,
    intentHash: 'hash',
    draftText: 'Question',
    draftToken: 'tok',
    consumedToken: null,
    baseScope: { mode: 'selected', sourceIds: [], singleSourceId: null },
    singleSourceId: null,
    noteIds: [],
    chatAnchor: null,
    readerAnchor: null,
    dirty: false,
    saving: false,
    readOnly: false,
    blocked: false,
    unreadable: false,
    warnings: [],
    conflict: null,
    saveFailure: null,
    unsynced: false,
    localVersion: 1,
    confirmedLocalVersion: 1,
    writerId: 'w',
    lastSavedAt: null,
    pendingMutations: 0,
    restoreCandidates: [],
    holds: [],
    transportAvailable: true,
    positionUnavailable: false,
    invalidated: false,
    oversize: false,
    ...overrides,
  }
}

const IDLE_CONVERSATION = {
  isBusy: false,
  isStreaming: false,
  activeTurnId: null,
  phase: 'idle' as const,
}

describe('deriveResearchDraftGate #1106/D5 空 selected 用途放行', () => {
  it('缺省（旧壳/能力关闭）：空 selected 仍 scope_invalid 阻断', () => {
    const gate = deriveResearchDraftGate({
      editorSnapshot: editorSnapshot(),
      conversationSnapshot: IDLE_CONVERSATION,
      kind: 'global',
    })
    expect(gate).toEqual({ allowed: false, reason: 'scope_invalid' })
  })

  it('allowEmptySelectedScope=true（inference on + auto/exploration/writing）：不因空 selected 阻断', () => {
    const gate = deriveResearchDraftGate({
      editorSnapshot: editorSnapshot(),
      conversationSnapshot: IDLE_CONVERSATION,
      kind: 'global',
      allowEmptySelectedScope: true,
    })
    expect(gate).toEqual({ allowed: true, reason: null })
  })

  it('TargetComposer 真实 session 门禁：空 selected + auto + 能力 on → 可发送', () => {
    renderComposer({ sessionWired: true, editorSnapshot: editorSnapshot(), capability: true })
    expect(screen.getByTestId('chat-send')).not.toBeDisabled()
  })

  it('TargetComposer 真实 session 门禁：inference 能力关闭 → 空 selected 仍阻断', () => {
    renderComposer({ sessionWired: true, editorSnapshot: editorSnapshot(), capability: false })
    expect(screen.getByTestId('chat-send')).toBeDisabled()
    expect(screen.getByTestId('research-draft-gate-hint')).toBeInTheDocument()
  })

  it('TargetComposer 真实 session 门禁：显式 document_qa + 空 selected → 仍阻断', () => {
    renderComposer({
      sessionWired: true,
      editorSnapshot: editorSnapshot(),
      capability: true,
      initialPurpose: 'document_qa',
    })
    expect(screen.getByTestId('chat-send')).toBeDisabled()
  })
})

// W2 #1077（UI 规格 v1 §5.7/BEH-11）：阅读器「讨论选段」→ composer chip。
// chip 只是显式上下文提示，不改变发送门禁；移除后请求不再携带 selection_context，
// 且必须与既有单篇 pin chip 并存（两套独立上下文）。
describe('TargetComposer W2 #1077 阅读器选段 chip', () => {
  it('渲染独立选段 chip（data-testid/标签/title），移除按钮调用 onRemove', () => {
    const onRemove = vi.fn()
    renderComposer({
      selectionChip: {
        label: 'Source A · p.3 · 2–9 · quote',
        title: 'selected quote',
        onRemove,
      },
    })
    const chip = screen.getByTestId('rdlens-target-selection-chip')
    expect(chip).toHaveTextContent('Source A · p.3 · 2–9 · quote')
    expect(screen.getByTitle('selected quote')).toBeInTheDocument()
    const remove = screen.getByTestId('rdlens-target-selection-chip-remove')
    expect(remove).toHaveAttribute('aria-label', 'research.selection.remove')
    fireEvent.click(remove)
    expect(onRemove).toHaveBeenCalledTimes(1)
  })

  it('无 pending 选段时不渲染选段 chip（composer 结构不变）', () => {
    renderComposer()
    expect(screen.queryByTestId('rdlens-target-selection-chip')).toBeNull()
    expect(screen.queryByTestId('rdlens-target-selection-chip-remove')).toBeNull()
  })

  it('与既有单篇 pin chip 并存（两行独立；不合并、不互相清除）', () => {
    const onRemove = vi.fn()
    renderComposer({
      selectionChip: { label: 'selection chip', title: 'quote', onRemove },
    })
    fireEvent.click(screen.getByTestId('harness-pin-single'))
    // ResearchDraftComposer 既有单篇 chip。
    expect(screen.getByTestId('selection-chip')).toBeInTheDocument()
    // 阅读器选段 chip 独立存在。
    const readerChip = screen.getByTestId('rdlens-target-selection-chip')
    expect(readerChip).toBeInTheDocument()
    expect(readerChip).toHaveTextContent('selection chip')
    expect(onRemove).not.toHaveBeenCalled()
  })
})
