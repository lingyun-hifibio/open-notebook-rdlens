import { describe, expect, it } from 'vitest'

import { zhCN } from './zh-CN'
import { enUS } from './en-US'

// W1 #1104（审查 A F2 / 审查 B F2）：目标壳 zh-CN 不得残留英文值。
// 除既有 14-locale parity 门禁（键/占位符）外，本文件钉住**目标壳渲染子树**
// 实际引用文案的中文值，防止回归（截图为验收证据）。

const CJK = /[\u4e00-\u9fff]/

function get(obj: unknown, key: string): unknown {
  return key.split('.').reduce<unknown>((acc, part) => {
    if (acc === null || typeof acc !== 'object') return undefined
    return (acc as Record<string, unknown>)[part]
  }, obj)
}

function collectLeaves(obj: unknown, prefix = '', out: string[] = []): string[] {
  if (obj === null || typeof obj !== 'object') return out
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${key}` : key
    if (typeof value === 'string') out.push(path)
    else collectLeaves(value, path, out)
  }
  return out
}

describe('zh-CN 目标壳文案（I18N-01）', () => {
  it('research.target.* 全部有中文值（无英文占位）', () => {
    const leaves = collectLeaves(get(enUS, 'research.target'), 'research.target')
    expect(leaves.length).toBeGreaterThan(50)
    const englishOnly = leaves.filter((key) => {
      const value = get(zhCN, key)
      return typeof value !== 'string' || !CJK.test(value)
    })
    expect(englishOnly).toEqual([])
  })

  it('任务历史状态六值已译（审查 A F2）', () => {
    for (const key of ['queued', 'running', 'cancelling', 'cancelled', 'completed', 'failed']) {
      const value = get(zhCN, `research.activity.state.${key}`)
      expect(typeof value).toBe('string')
      expect(CJK.test(value as string)).toBe(true)
    }
  })

  it('范围 reconcile toast 标题已译（modeLabel）', () => {
    expect(get(zhCN, 'research.layout.scope.modeLabel')).toBe('研究范围')
  })

  it('资料状态 retiring/deleted 已译', () => {
    expect(get(zhCN, 'research.sources.statusRetiring')).toBe('即将移除')
    expect(get(zhCN, 'research.sources.statusDeleted')).toBe('已移除')
  })

  it('目标壳复用的既有 key 无英文值（截图残留扫描口径）', () => {
    const reused = [
      'research.chatScopeBadge',
      'research.editor.blocked',
      'research.editor.composerLabel',
      'research.editor.saved',
      'research.editor.unsavedDraft',
      'research.resultActions.copy',
      'research.resultActions.saveAsNote',
      'research.resultActions.saveAsInsight',
      'research.resultActions.continueResearch',
      'research.pagination.loadMore',
      'research.pagination.loadingMore',
      'research.scopeSummary.sourceMany',
      'research.scopeSummary.noteOne',
      'research.scopeSummary.entireProject',
      'research.layout.scope.singleClear',
      'research.sources.addMaterials',
      'research.sources.scopeSelect',
      'research.sources.staleSelectionWarning',
      'research.searchContext.autoAdjusted',
      'research.searchErrorBudgetExceeded',
      'research.searchErrorPreviewChecksUnavailable',
      'research.searchErrorRecoveryExhausted',
      'research.resultProvider',
    ]
    const englishOnly = reused.filter((key) => {
      const value = get(zhCN, key)
      return typeof value !== 'string' || !CJK.test(value)
    })
    expect(englishOnly).toEqual([])
  })
})
