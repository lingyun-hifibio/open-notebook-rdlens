import { beforeAll, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { createInstance } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'

import { resources } from '@/lib/locales'
import { createEditorState } from '@/lib/research/editor-machine'
import type { ResearchSessionRef } from '@/lib/research/session-contract'
import type {
  EditorSnapshot,
  ResearchScopeBarNoteOption,
  ResearchScopeBarSourceOption,
  ScopeEdit,
} from '@/lib/research/types'
import { ResearchSessionScopeBar } from './ResearchSessionScopeBar'

/**
 * #602 O-2 回归：范围摘要必须走真实的 i18next 插值。
 *
 * 生产实测（2026-10-28/29，1023/1024 视口）：范围条渲染出未插值的
 * `SELECTED: {{SOURCES}} SOURCES, {{NOTES}} NOTES`——调用点只传了
 * `{ count }`，而 `research.layout.scope.selectedSummary` 的模板在全部
 * 14 个 locale 中都要求 `{{sources}}` / `{{notes}}`。
 *
 * 兄弟测试 `ResearchSessionScopeBar.test.tsx` 的 `t` 是 mock，不会插值，
 * 因此**无法**锁住本缺陷；本文件刻意使用真实 i18next 实例 + 真实
 * react-i18next hook，断言渲染文本里不含 `{{` 且计数语义正确。
 *
 * jsdom 不做布局，1023/1024 视口宽度不影响本断言——缺陷是纯文案插值，
 * 与宽度无关，故只断言文本。
 */

// 覆盖 src/test/setup.ts 的全局 mock：让 useTranslation 走真实 react-i18next。
vi.mock('@/lib/hooks/use-translation', async () => {
  const actual = await vi.importActual<typeof import('react-i18next')>('react-i18next')
  return { useTranslation: actual.useTranslation }
})

const REF: ResearchSessionRef = {
  domain: 'research',
  kind: 'global',
  projectId: 'proj_1',
  sessionId: 'sess_1',
  sourceId: null,
}

const SOURCES: ResearchScopeBarSourceOption[] = [
  { sourceId: 'src_1', title: 'Paper One' },
  { sourceId: 'src_2', title: 'Paper Two' },
]

// 目录里的 Note（可勾选）。
const NOTES: ResearchScopeBarNoteOption[] = [{ noteId: 'note_1', title: 'Lab note' }]

const i18n = createInstance()

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    resources,
    lng: 'en-US',
    fallbackLng: 'en-US',
    interpolation: {
      // Mirrors src/lib/i18n.ts
      escapeValue: false,
    },
    react: { useSuspense: false },
  })
})

function snapshot(overrides: Partial<EditorSnapshot> = {}): EditorSnapshot {
  const base = createEditorState({
    ref: REF,
    writerId: 'writer-1',
    transportAvailable: true,
  })
  return { ...base, phase: 'ready', loading: false, ...overrides }
}

function renderBar(overrides: {
  snapshot?: Partial<EditorSnapshot>
  notes?: readonly ResearchScopeBarNoteOption[]
  onChangeScope?: (edit: ScopeEdit) => void
}) {
  render(
    <I18nextProvider i18n={i18n}>
      <ResearchSessionScopeBar
        editorSnapshot={snapshot(overrides.snapshot)}
        sources={SOURCES}
        notes={overrides.notes ?? NOTES}
        disabledReason={null}
        onChangeScope={overrides.onChangeScope ?? vi.fn()}
      />
    </I18nextProvider>,
  )
}

describe('#602 O-2 范围摘要插值（真实 i18next）', () => {
  it('en-US：渲染已插值的 Selected 摘要，且不含 {{...}} 原文', () => {
    renderBar({
      snapshot: {
        baseScope: { mode: 'selected', sourceIds: ['src_1', 'src_2'], singleSourceId: null },
        noteIds: ['note_1'],
      },
    })

    const summary = screen.getByTestId('scope-selected-summary')
    expect(summary).toHaveTextContent('Selected: 2 sources, 1 notes')
    expect(summary.textContent).not.toContain('{{')
    expect(summary.textContent).not.toContain('}}')
  })

  it('计数 = 已选来源数 / 已选 Note 数（含不在目录中的失效项，与 ResearchScopeSummary 同口径）', () => {
    // src_2 与 note_gone 不在目录中：仍属“已选”，必须计入而不是被静默丢弃。
    renderBar({
      snapshot: {
        baseScope: { mode: 'all', sourceIds: ['src_1', 'src_2'], singleSourceId: null },
        noteIds: ['note_1', 'note_gone'],
      },
    })

    const summary = screen.getByTestId('scope-selected-summary')
    expect(summary).toHaveTextContent('Selected: 2 sources, 2 notes')
    expect(summary.textContent).not.toContain('{{')
  })

  it('all 模式下勾选后摘要计数随快照更新（受控：父层回写即反映）', () => {
    renderBar({
      snapshot: {
        baseScope: { mode: 'selected', sourceIds: ['src_1'], singleSourceId: null },
        noteIds: [],
      },
    })

    expect(screen.getByTestId('scope-selected-summary')).toHaveTextContent(
      'Selected: 1 sources, 0 notes',
    )
  })

  // 14 locale 全量回归：任何 locale 的模板只要漏传变量就会重新出现 `{{`。
  it.each(Object.keys(resources))('%s：范围摘要不含未插值的 {{...}}', async code => {
    await i18n.changeLanguage(code)
    renderBar({
      snapshot: {
        baseScope: { mode: 'selected', sourceIds: ['src_1', 'src_2'], singleSourceId: null },
        noteIds: ['note_1'],
      },
    })

    const summary = screen.getByTestId('scope-selected-summary')
    expect(summary.textContent, `locale ${code}`).not.toContain('{{')
    expect(summary.textContent, `locale ${code}`).not.toContain('}}')
    // 计数占位符必须被真实数字替换（模板在两处各引用一次）。
    expect(summary.textContent, `locale ${code}`).toContain('2')
    expect(summary.textContent, `locale ${code}`).toContain('1')
  })
})
