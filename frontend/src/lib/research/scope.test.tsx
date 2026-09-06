import { act, render, renderHook, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  ResearchScopeProvider,
  formatScopeLabel,
  scopeStorageKey,
  useResearchScope,
  validateResearchScope,
} from './scope'

const projectId = 'proj_1'
const userId = 'user_1'

function wrapper({ children }: { children: React.ReactNode }) {
  return (
    <ResearchScopeProvider projectId={projectId} userId={userId}>
      {children}
    </ResearchScopeProvider>
  )
}

function ScopeProbe() {
  const { mode, selectedSourceIds } = useResearchScope()
  return <output data-testid="scope-probe">{`${mode}:${selectedSourceIds.join(',')}`}</output>
}

describe('ResearchScopeProvider', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  afterEach(() => {
    localStorage.clear()
  })

  it('restores a valid selected scope only from this user and project key', () => {
    localStorage.setItem(
      scopeStorageKey(userId, projectId),
      JSON.stringify({ version: 1, mode: 'selected', sourceIds: ['src_1'], noteIds: ['note_1'] }),
    )
    localStorage.setItem(
      scopeStorageKey('other_user', projectId),
      JSON.stringify({ version: 1, mode: 'selected', sourceIds: ['other'], noteIds: [] }),
    )

    const { result } = renderHook(() => useResearchScope(), { wrapper })

    expect(result.current.mode).toBe('selected')
    expect(result.current.selectedSourceIds).toEqual(['src_1'])
    expect(result.current.selectedNoteIds).toEqual(['note_1'])
  })

  it('rejects an empty selected scope instead of expanding it to the project', () => {
    expect(
      validateResearchScope({ mode: 'selected', sourceIds: [], noteIds: [] }),
    ).toEqual({ valid: false, reason: 'empty_selected_scope' })

    const { result } = renderHook(() => useResearchScope(), { wrapper })
    act(() => {
      result.current.setMode('selected')
    })

    expect(result.current.mode).toBe('entire_project')
    expect(result.current.validate()).toEqual({ valid: true })
  })

  it('discards malformed persisted data rather than applying it to this session', () => {
    const key = scopeStorageKey(userId, projectId)
    localStorage.setItem(key, JSON.stringify({ version: 1, mode: 'selected', sourceIds: [], noteIds: [] }))

    const { result } = renderHook(() => useResearchScope(), { wrapper })

    expect(result.current.mode).toBe('entire_project')
    expect(localStorage.getItem(key)).toBeNull()
  })

  it('returns a frozen dispatch snapshot that cannot drift with later scope edits', () => {
    const { result } = renderHook(() => useResearchScope(), { wrapper })

    act(() => {
      result.current.toggleSource('src_1')
    })
    const snapshot = result.current.getSnapshot()

    expect(snapshot).toEqual({ mode: 'selected', sourceIds: ['src_1'], noteIds: [] })
    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(Object.isFrozen(snapshot.sourceIds)).toBe(true)
    expect(Object.isFrozen(snapshot.noteIds)).toBe(true)

    act(() => {
      result.current.toggleNote('note_1')
    })
    expect(snapshot).toEqual({ mode: 'selected', sourceIds: ['src_1'], noteIds: [] })
  })

  it('remounts by encoded user and project identity without leaking the previous scope', () => {
    localStorage.setItem(
      scopeStorageKey('user_1', 'project_1'),
      JSON.stringify({ version: 1, mode: 'selected', sourceIds: ['source_for_user_1'], noteIds: [] }),
    )
    localStorage.setItem(
      scopeStorageKey('user_2', 'project_1'),
      JSON.stringify({ version: 1, mode: 'selected', sourceIds: ['source_for_user_2'], noteIds: [] }),
    )

    const { rerender } = render(
      <ResearchScopeProvider userId="user_1" projectId="project_1"><ScopeProbe /></ResearchScopeProvider>,
    )
    expect(screen.getByTestId('scope-probe')).toHaveTextContent('selected:source_for_user_1')

    rerender(
      <ResearchScopeProvider userId="user_2" projectId="project_1"><ScopeProbe /></ResearchScopeProvider>,
    )
    expect(screen.getByTestId('scope-probe')).toHaveTextContent('selected:source_for_user_2')

    rerender(
      <ResearchScopeProvider userId="user_1" projectId="project_2"><ScopeProbe /></ResearchScopeProvider>,
    )
    expect(screen.getByTestId('scope-probe')).toHaveTextContent('entire_project:')
    expect(localStorage.getItem(scopeStorageKey('user_1', 'project_2'))).toBeNull()
  })
})

describe('formatScopeLabel（RWV2-11 K11）', () => {
  // 与 ResearchSearchPanel.v1.test 同款 t() mock（key|opts），验证内容映射
  const t = (key: string, opts?: Record<string, unknown>) =>
    opts === undefined ? key : `${key}|${JSON.stringify(opts)}`

  it('entire_project → Entire project 语义 key', () => {
    expect(
      formatScopeLabel({ mode: 'entire_project', sourceIds: [], noteIds: [] }, t),
    ).toBe('research.scopeSummary.entireProject')
  })

  it('selected 单 Source → sourceOne', () => {
    const label = formatScopeLabel(
      { mode: 'selected', sourceIds: ['s1'], noteIds: [] },
      t,
    )
    expect(label).toBe('research.scopeSummary.sourceOne')
  })

  it('selected 多 Source 单 Note → sourceMany + noteOne（join 有序）', () => {
    const label = formatScopeLabel(
      { mode: 'selected', sourceIds: ['s1', 's2'], noteIds: ['n1'] },
      t,
    )
    expect(label).toBe(
      'research.scopeSummary.sourceMany|{"count":2} · research.scopeSummary.noteOne',
    )
  })

  it('selected 空（Provider 不变量下不可达）→ 防御性回退 selected 标签', () => {
    const label = formatScopeLabel({ mode: 'selected', sourceIds: [], noteIds: [] }, t)
    expect(label).toBe('research.layout.scope.selected')
  })
})
