import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ComparePanel } from './ComparePanel'
import { ResearchScopeProvider, scopeStorageKey } from '@/lib/research/scope'
import {
  COMPARE_MIN_DOCUMENTS,
  checkCompareDocumentFloor,
  checkCompareSelection,
} from '@/lib/research/compare'
import type { ResearchSource } from '@/lib/types/research'

/**
 * PR5（D-16 / D-20 / T32 / T38）：Compare 的**文档计量**与阻断原因。
 *
 * 为什么单列：`ComparePanel.test.tsx` 覆盖既有的 30/50 上限与 all 阻断；
 * 本文件覆盖 C-05 特有的两件事——
 * - T32：同文档多版本共选（`mixed_versions_of_same_document_allowed`）时，
 *   **计量按文档去重**（提示"已合并"），合并后不足两份 → 按"需要两份不同
 *   文档"阻断；而**版本语义**处（执行载荷 `document_ids`）不去重，不得因
 *   合并而丢精确版本；
 * - T38：`all` 的阻断原因是 `all`（不是 `empty`），文案是"需先选择资料"。
 */

const USER_ID = 'u1'
const PROJECT_ID = 'p1'

function source(overrides: Partial<ResearchSource> & { source_id: string }): ResearchSource {
  return {
    document_id: `doc_${overrides.source_id}`,
    document_version: 'v3',
    status: 'ready',
    content_hash: null,
    synced_at: '2026-08-06T02:00:00Z',
    last_error: null,
    ...overrides,
  }
}

function seedScope(mode: 'all' | 'selected', sourceIds: string[]): void {
  localStorage.setItem(
    scopeStorageKey(USER_ID, PROJECT_ID),
    JSON.stringify({ version: 1, mode, sourceIds, noteIds: [] }),
  )
}

function renderPanel(
  rows: ResearchSource[],
  selected: string[],
  mode: 'all' | 'selected' = 'selected',
  onCreate = vi.fn(async (_documentIds: string[]) => true),
) {
  seedScope(mode, selected)
  return {
    onCreate,
    ...render(
      <ResearchScopeProvider userId={USER_ID} projectId={PROJECT_ID}>
        <ComparePanel sources={rows} isCreating={false} error={null} onCreate={onCreate} />
      </ResearchScopeProvider>,
    ),
  }
}

describe('ComparePanel · 文档计量（D-16 / T32）', () => {
  beforeEach(() => {
    localStorage.clear()
  })
  afterEach(() => {
    cleanup()
    localStorage.clear()
  })

  it('T32：同文档 v1+v2 共选 → 提示"已合并同文档多版本"', () => {
    const rows = [
      source({ source_id: 'src_v1', document_id: 'doc_A', document_version: 'v1' }),
      source({ source_id: 'src_v2', document_id: 'doc_A', document_version: 'v2' }),
      source({ source_id: 'src_b', document_id: 'doc_B', document_version: 'v1' }),
    ]
    renderPanel(rows, ['src_v1', 'src_v2', 'src_b'])

    expect(screen.getByTestId('compare-merged-versions')).toHaveTextContent(
      'research.compareMergedVersions',
    )
  })

  it('T32：合并后只剩一个唯一文档 → 按"需要两份不同文档"阻断（不是空选）', () => {
    const rows = [
      source({ source_id: 'src_v1', document_id: 'doc_A', document_version: 'v1' }),
      source({ source_id: 'src_v2', document_id: 'doc_A', document_version: 'v2' }),
    ]
    renderPanel(rows, ['src_v1', 'src_v2'])

    expect(screen.getByTestId('compare-single-document')).toHaveTextContent(
      'research.compareNeedsTwoDocuments',
    )
    // 不得退化成"没有可用资料"（D-11 禁用该措辞描述有选择但不足的情形）
    expect(screen.queryByTestId('compare-empty')).toBeNull()
    expect(screen.getByTestId('compare-create')).toBeDisabled()
  })

  it('T32：两个唯一文档（共三行）→ 执行载荷按**文档**去重（端点无法表达精确版本）', async () => {
    const rows = [
      source({ source_id: 'src_v1', document_id: 'doc_A', document_version: 'v1' }),
      source({ source_id: 'src_v2', document_id: 'doc_A', document_version: 'v2' }),
      source({ source_id: 'src_b', document_id: 'doc_B', document_version: 'v1' }),
    ]
    const { onCreate } = renderPanel(rows, ['src_v1', 'src_v2', 'src_b'])

    const button = screen.getByTestId('compare-create')
    expect(button).not.toBeDisabled()
    fireEvent.click(button)

    await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(1))
    // `POST /compare/jobs` 只接受 document_ids 且服务端逐条取最新版本
    //（router.py:2562-2570）——重复 doc_id 不会保住旧版本，只会让服务端把
    // 同一 (doc, 最新版) 解析两次（A 与 A 比较）。故载荷必须去重。
    const payload = onCreate.mock.calls[0][0]
    expect(payload).toEqual(['doc_A', 'doc_B'])
    expect(new Set(payload).size).toBe(payload.length)
  })

  it('T32：单文档单行（未合并）同样不足两份 → 阻断', () => {
    const rows = [source({ source_id: 'src_1', document_id: 'doc_A' })]
    renderPanel(rows, ['src_1'])

    expect(screen.getByTestId('compare-single-document')).toBeInTheDocument()
    expect(screen.queryByTestId('compare-merged-versions')).toBeNull()
    expect(screen.getByTestId('compare-create')).toBeDisabled()
  })

  it('T32：纯函数层——下限判定与"按文献计数上限"分层（不影响重试路径语义）', () => {
    expect(COMPARE_MIN_DOCUMENTS).toBe(2)
    // 0 篇不是"合并后不足"，归 empty 分支（原因不得互相吞并）
    expect(checkCompareDocumentFloor(0)).toEqual({ ok: true })
    expect(checkCompareDocumentFloor(1)).toMatchObject({ ok: false, reason: 'single_document' })
    expect(checkCompareDocumentFloor(2)).toEqual({ ok: true })
    // 既有上限语义不变（重试路径依赖它）
    expect(checkCompareSelection(['doc_A'])).toMatchObject({ ok: true, count: 1 })
    expect(checkCompareSelection([])).toMatchObject({ ok: false, reason: 'empty' })
  })
})

describe('ComparePanel · 阻断原因与文案（D-20 / T38）', () => {
  beforeEach(() => {
    localStorage.clear()
  })
  afterEach(() => {
    cleanup()
    localStorage.clear()
  })

  it('T38：all 下阻断原因是 all（非 empty），文案为"需先选择资料"', () => {
    const rows = [source({ source_id: 'src_1' }), source({ source_id: 'src_2' })]
    renderPanel(rows, [], 'all')

    const notice = screen.getByTestId('compare-entire-project')
    expect(notice).toHaveTextContent('research.compareEntireProjectRequiresSelection')
    expect(screen.queryByTestId('compare-empty')).toBeNull()
    expect(screen.getByTestId('compare-create')).toBeDisabled()
  })

  it('T38 对照：真的没有可用资料时仍走 empty 文案（两类原因不互相吞并）', () => {
    renderPanel([], [], 'selected')

    expect(screen.getByTestId('compare-empty')).toHaveTextContent('research.compareEmpty')
    expect(screen.queryByTestId('compare-entire-project')).toBeNull()
    expect(screen.queryByTestId('compare-single-document')).toBeNull()
  })
})
