import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'

import type { ResearchSessionRef } from '@/lib/research/session-contract'
import { createEditorState } from '@/lib/research/editor-machine'
import type {
  EditorSnapshot,
  ResearchScopeBarNoteOption,
  ResearchScopeBarSourceOption,
  ScopeEdit,
} from '@/lib/research/types'
import { ResearchSessionScopeBar } from './ResearchSessionScopeBar'

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

function makeSnapshot(overrides: Partial<EditorSnapshot> = {}): EditorSnapshot {
  const base = createEditorState({
    ref: REF,
    writerId: 'writer-1',
    transportAvailable: true,
  })
  return { ...base, phase: 'ready', loading: false, ...overrides }
}

const SOURCES: ResearchScopeBarSourceOption[] = [
  { sourceId: 'src_1', title: 'Paper One' },
  { sourceId: 'src_2', title: 'Paper Two' },
]
const NOTES: ResearchScopeBarNoteOption[] = [{ noteId: 'note_1', title: 'Lab note' }]

function renderBar(overrides: {
  snapshot?: Partial<EditorSnapshot>
  sources?: typeof SOURCES
  notes?: typeof NOTES
  disabledReason?: string | null
  onChangeScope?: (edit: ScopeEdit) => void
}) {
  const onChangeScope = overrides.onChangeScope ?? vi.fn()
  render(
    <ResearchSessionScopeBar
      editorSnapshot={makeSnapshot(overrides.snapshot)}
      sources={overrides.sources ?? SOURCES}
      notes={overrides.notes ?? NOTES}
      disabledReason={overrides.disabledReason ?? null}
      onChangeScope={onChangeScope}
    />,
  )
  return { onChangeScope }
}

describe('ResearchSessionScopeBar', () => {
  it('B1 默认 all 模式显示“全部可用”与当前模式标签', () => {
    renderBar({ snapshot: { baseScope: { mode: 'all', sourceIds: [], singleSourceId: null } } })

    expect(screen.getByTestId('research-session-scope-bar')).toBeInTheDocument()
    expect(screen.getByTestId('scope-mode-all')).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByTestId('scope-mode-selected')).toHaveAttribute('aria-checked', 'false')
    expect(screen.getByText('research.layout.scope.modeLabel')).toBeInTheDocument()
    expect(screen.getByText('research.layout.scope.allHint')).toBeInTheDocument()
  })

  it('B2 切到 selected 保留已选来源并展示列表', () => {
    const { onChangeScope } = renderBar({
      snapshot: { baseScope: { mode: 'all', sourceIds: ['src_1'], singleSourceId: null } },
    })

    fireEvent.click(screen.getByTestId('scope-mode-selected'))

    expect(onChangeScope).toHaveBeenCalledTimes(1)
    expect(onChangeScope).toHaveBeenCalledWith({ mode: 'selected', sourceIds: ['src_1'] })
  })

  it('B3 勾选来源与 Note 通过 onChangeScope 传递；取消勾选同理（受控：按父层回写快照）', () => {
    const onChangeScope = vi.fn()
    const { rerender } = render(
      <ResearchSessionScopeBar
        editorSnapshot={makeSnapshot({
          baseScope: { mode: 'selected', sourceIds: ['src_1'], singleSourceId: null },
        })}
        sources={SOURCES}
        notes={NOTES}
        disabledReason={null}
        onChangeScope={onChangeScope}
      />,
    )

    fireEvent.click(screen.getByTestId('scope-source-src_2'))
    expect(onChangeScope).toHaveBeenLastCalledWith({
      mode: 'selected',
      sourceIds: ['src_1', 'src_2'],
    })

    rerender(
      <ResearchSessionScopeBar
        editorSnapshot={makeSnapshot({
          baseScope: { mode: 'selected', sourceIds: ['src_1', 'src_2'], singleSourceId: null },
        })}
        sources={SOURCES}
        notes={NOTES}
        disabledReason={null}
        onChangeScope={onChangeScope}
      />,
    )
    fireEvent.click(screen.getByTestId('scope-source-src_1'))
    expect(onChangeScope).toHaveBeenLastCalledWith({ mode: 'selected', sourceIds: ['src_2'] })
  })

  it('B3 all 模式下勾 Note 切到 selected（Note-only 合法）', () => {
    const { onChangeScope } = renderBar({
      snapshot: { baseScope: { mode: 'all', sourceIds: [], singleSourceId: null } },
    })

    fireEvent.click(screen.getByTestId('scope-note-note_1'))

    expect(onChangeScope).toHaveBeenCalledTimes(1)
    expect(onChangeScope).toHaveBeenCalledWith({
      mode: 'selected',
      sourceIds: [],
      noteIds: ['note_1'],
    })
  })

  it('B4 selected 为空时提示必须选择资料，不自动扩大为 all', () => {
    const { onChangeScope } = renderBar({
      snapshot: { baseScope: { mode: 'selected', sourceIds: [], singleSourceId: null } },
    })

    expect(screen.getByTestId('scope-empty-hint')).toHaveTextContent(
      'research.layout.scope.selectItemRequired',
    )
    expect(screen.getByTestId('scope-mode-selected')).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByTestId('scope-mode-all')).toHaveAttribute('aria-checked', 'false')
    expect(onChangeScope).not.toHaveBeenCalled()
  })

  it('B5 single 模式固定“仅此来源：X”，清除后恢复 base', () => {
    const { onChangeScope } = renderBar({
      snapshot: {
        baseScope: { mode: 'selected', sourceIds: ['src_1'], singleSourceId: null },
        singleSourceId: 'src_1',
      },
    })

    expect(screen.getByTestId('scope-single-banner')).toHaveTextContent(
      'research.layout.scope.singleActive',
    )
    expect(screen.getByTestId('scope-single-banner')).toHaveTextContent('src_1')

    fireEvent.click(screen.getByTestId('scope-single-clear'))

    expect(onChangeScope).toHaveBeenCalledWith({ mode: 'single', sourceId: null })
  })

  it('B6 legacy 范围（base_scope=null）显示重选横幅且不默认 all', () => {
    renderBar({ snapshot: { baseScope: null } })

    expect(screen.getByTestId('scope-legacy-banner')).toHaveTextContent(
      'research.editor.legacyScopeReselection',
    )
    expect(screen.getByTestId('scope-mode-all')).toHaveAttribute('aria-checked', 'false')
    expect(screen.getByTestId('scope-mode-selected')).toHaveAttribute('aria-checked', 'false')
  })

  it('B7 失效来源保留选择并逐项标注“未确认”，不自动删除', () => {
    renderBar({
      snapshot: { baseScope: { mode: 'selected', sourceIds: ['src_gone'], singleSourceId: null } },
      sources: [
        { sourceId: 'src_gone', title: 'Gone paper', unavailable: true },
        ...SOURCES,
      ],
    })

    const item = screen.getByTestId('scope-source-src_gone')
    expect(item).toBeChecked()
    expect(screen.getByTestId('scope-unconfirmed-hint')).toHaveTextContent(
      'research.editor.unconfirmedItems',
    )
  })

  it('B8 disabledReason 可见且交互禁用（不只靠视觉禁用）', () => {
    renderBar({ disabledReason: 'This session is still running', snapshot: { blocked: true } })

    expect(screen.getByTestId('scope-disabled-reason')).toHaveTextContent(
      'This session is still running',
    )
    expect(screen.getByTestId('scope-mode-selected')).toBeDisabled()
    expect(screen.getByTestId('scope-source-src_1')).toBeDisabled()
  })

  it('B9 空快照（无 editor）时不渲染，避免改写任何范围', () => {
    const onChangeScope = vi.fn()
    render(
      <ResearchSessionScopeBar
        editorSnapshot={null}
        sources={SOURCES}
        notes={NOTES}
        disabledReason={null}
        onChangeScope={onChangeScope}
      />,
    )

    expect(screen.queryByTestId('research-session-scope-bar')).not.toBeInTheDocument()
    expect(onChangeScope).not.toHaveBeenCalled()
  })

  it('B10 已存但不在目录中的 Source/Note 保留并逐项标注，可取消', () => {
    const onChangeScope = vi.fn()
    renderBar({
      snapshot: {
        baseScope: {
          mode: 'selected',
          sourceIds: ['src_1', 'src_missing'],
          singleSourceId: null,
        },
        noteIds: ['note_missing'],
      },
      onChangeScope,
    })
    const staleSource = screen.getByTestId('scope-source-src_missing')
    expect(staleSource).toBeChecked()
    expect(staleSource).toHaveAttribute('data-unconfirmed', 'true')
    fireEvent.click(staleSource)
    expect(onChangeScope).toHaveBeenLastCalledWith({
      mode: 'selected',
      sourceIds: ['src_1'],
    })
    const staleNote = screen.getByTestId('scope-note-note_missing')
    expect(staleNote).toBeChecked()
    expect(staleNote).toHaveAttribute('data-unconfirmed', 'true')
    fireEvent.click(staleNote)
    expect(onChangeScope).toHaveBeenLastCalledWith({ mode: 'note', noteIds: [] })
  })

  it('B11 来源行提供“仅问此来源”入口（single 叠加，不改 base）', () => {
    const onChangeScope = vi.fn()
    renderBar({
      snapshot: {
        baseScope: { mode: 'selected', sourceIds: ['src_1'], singleSourceId: null },
      },
      onChangeScope,
    })
    fireEvent.click(screen.getByTestId('scope-single-src_2'))
    expect(onChangeScope).toHaveBeenCalledTimes(1)
    expect(onChangeScope).toHaveBeenLastCalledWith({ mode: 'single', sourceId: 'src_2' })
  })

  it('B12 切到 all 显式清空 Note（effective all 不得携带 Note）', () => {
    const onChangeScope = vi.fn()
    renderBar({
      snapshot: {
        baseScope: { mode: 'selected', sourceIds: ['src_1'], singleSourceId: null },
        noteIds: ['note_1'],
      },
      onChangeScope,
    })
    fireEvent.click(screen.getByTestId('scope-mode-all'))
    expect(onChangeScope.mock.calls).toEqual([
      [{ mode: 'all' }],
      [{ mode: 'note', noteIds: [] }],
    ])
  })
})