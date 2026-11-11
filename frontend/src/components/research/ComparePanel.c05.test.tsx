import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useEffect } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ComparePanel } from './ComparePanel'
import {
  ResearchScopeProvider,
  scopeStorageKey,
  useResearchScope,
} from '@/lib/research/scope'
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

// ── Issue #1017（D1-H）：capability 位驱动的 C05 声明范围 ──────────────────
//
// 能力 true（`capabilities.c05.entries.compare.execution_ready === true`，
// 由父层以 `c05Ready` 下发）时：
// - `all` 不再阻断（文档集合由服务端解析）；
// - `selected` 发送 scope provider 的 `source_ids`（不再映射 document_ids），
//   仅对已加载且可判文档身份的行按 document_id 去重；分页外 selected 原样
//   保留（服务端解析/稳定拒绝），不静默丢弃。
// 能力 false 时既有 legacy 行为逐字节不变（另有 ComparePanel.test.tsx 覆盖）。

function renderC05Panel({
  rows,
  selected,
  mode = 'selected',
  onCreate = vi.fn(async () => true),
  error = null,
  errorCode = null,
  c05Ready = true,
}: {
  rows: ResearchSource[]
  selected: string[]
  mode?: 'all' | 'selected'
  onCreate?: ReturnType<typeof vi.fn>
  error?: string | null
  errorCode?: string | null
  c05Ready?: boolean
}) {
  seedScope(mode, selected)
  return {
    onCreate,
    ...render(
      <ResearchScopeProvider userId={USER_ID} projectId={PROJECT_ID}>
        <ComparePanel
          sources={rows}
          isCreating={false}
          error={error}
          errorCode={errorCode}
          onCreate={onCreate as unknown as (ids: string[], groupSize?: number) => Promise<boolean>}
          c05Ready={c05Ready}
        />
      </ResearchScopeProvider>,
    ),
  }
}

describe('ComparePanel · C05 声明范围（#1017）', () => {
  beforeEach(() => {
    localStorage.clear()
  })
  afterEach(() => {
    cleanup()
    localStorage.clear()
  })

  it('#1017 capability true + all：不再阻断，提交声明范围（onCreate 收到空 source 集合）', async () => {
    const rows = [source({ source_id: 'src_1' }), source({ source_id: 'src_2' })]
    const { onCreate } = renderC05Panel({ rows, selected: [], mode: 'all' })

    const button = screen.getByTestId('compare-create')
    expect(button).not.toBeDisabled()
    // 既有「需先选择资料」阻断文案消失；改为声明范围说明
    expect(screen.queryByTestId('compare-entire-project')).toBeNull()
    expect(screen.getByTestId('compare-declared-all')).toHaveTextContent(
      'research.compareScopeAllHint',
    )

    fireEvent.click(button)
    await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(1))
    // C05 `all`：客户端没有 document_ids；父层按 scope 快照装配 source_scope
    expect(onCreate.mock.calls[0][0]).toEqual([])
    expect(await screen.findByTestId('compare-submitted')).toBeInTheDocument()
  })

  it('#1017 capability true + selected：发送 provider source_ids（不是 document_ids），列表外 selected 不丢弃', async () => {
    const rows = [source({ source_id: 'src_1' }), source({ source_id: 'src_2' })]
    // src_offpage 不在已加载列表 → 仍须发送（服务端解析精确版本），不得静默丢弃
    const { onCreate } = renderC05Panel({ rows, selected: ['src_1', 'src_2', 'src_offpage'] })

    expect(screen.getByTestId('compare-declared-unloaded')).toHaveTextContent(
      'research.compareScopeSelectedUnloaded',
    )
    fireEvent.click(screen.getByTestId('compare-create'))
    await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(1))
    expect(onCreate.mock.calls[0][0]).toEqual(['src_1', 'src_2', 'src_offpage'])
    // 不得映射成 legacy document_ids（那是 capability false 的行为）
    expect(onCreate.mock.calls[0][0]).not.toContain('doc_src_1')
  })

  it('#1017 capability true + selected：已加载同文档多版本按 document_id 去重（保留首个）', async () => {
    const rows = [
      source({ source_id: 'src_v1', document_id: 'doc_A', document_version: 'v1' }),
      source({ source_id: 'src_v2', document_id: 'doc_A', document_version: 'v2' }),
      source({ source_id: 'src_b', document_id: 'doc_B', document_version: 'v1' }),
    ]
    const { onCreate } = renderC05Panel({
      rows,
      selected: ['src_v1', 'src_v2', 'src_b'],
    })

    expect(screen.getByTestId('compare-merged-versions')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('compare-create'))
    await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(1))
    // 已加载范围内同文档 v1+v2 合并为一份（保留首个）；不同文档保留
    expect(onCreate.mock.calls[0][0]).toEqual(['src_v1', 'src_b'])
  })

  it('#1017 capability true + selected：去重后不足两份 → 阻断（不冒充空选）', () => {
    const rows = [
      source({ source_id: 'src_v1', document_id: 'doc_A', document_version: 'v1' }),
      source({ source_id: 'src_v2', document_id: 'doc_A', document_version: 'v2' }),
    ]
    renderC05Panel({ rows, selected: ['src_v1', 'src_v2'] })

    expect(screen.getByTestId('compare-single-document')).toHaveTextContent(
      'research.compareNeedsTwoDocuments',
    )
    expect(screen.queryByTestId('compare-empty')).toBeNull()
    expect(screen.getByTestId('compare-create')).toBeDisabled()
  })

  it('#1017 capability true + single 范围：Compare 不提供 → 阻断并显示专用文案', () => {
    seedScope('selected', ['src_1', 'src_2'])
    function SingleBridge() {
      const { setSingle, bindSession } = useResearchScope()
      useEffect(() => {
        setSingle('src_1', 'sess_1')
        bindSession('sess_1')
      }, [bindSession, setSingle])
      return null
    }
    const onCreate = vi.fn(async () => true)
    render(
      <ResearchScopeProvider userId={USER_ID} projectId={PROJECT_ID}>
        <SingleBridge />
        <ComparePanel
          sources={[source({ source_id: 'src_1' }), source({ source_id: 'src_2' })]}
          isCreating={false}
          error={null}
          onCreate={onCreate}
          c05Ready
        />
      </ResearchScopeProvider>,
    )

    expect(screen.getByTestId('compare-declared-single-unsupported')).toHaveTextContent(
      'research.compareScopeSingleUnsupported',
    )
    expect(screen.getByTestId('compare-create')).toBeDisabled()
    // single 不得被静默改写成 all/selected 派发
    expect(onCreate).not.toHaveBeenCalled()
  })

  it('#1017 capability false 回归：all 仍阻断、selected 仍映射 document_ids（legacy 字节不变）', async () => {
    const rows = [source({ source_id: 'src_1' }), source({ source_id: 'src_2' })]
    // 能力 false 由父层不下发 c05Ready（默认 false）
    seedScope('all', [])
    const onCreateAll = vi.fn(async () => true)
    const view = render(
      <ResearchScopeProvider userId={USER_ID} projectId={PROJECT_ID}>
        <ComparePanel
          sources={rows}
          isCreating={false}
          error={null}
          onCreate={onCreateAll}
        />
      </ResearchScopeProvider>,
    )
    expect(screen.getByTestId('compare-entire-project')).toBeInTheDocument()
    expect(screen.getByTestId('compare-create')).toBeDisabled()
    expect(screen.queryByTestId('compare-declared-all')).toBeNull()
    view.unmount()

    const { onCreate } = renderC05Panel({
      rows,
      selected: ['src_1', 'src_2'],
      c05Ready: false,
    })
    fireEvent.click(screen.getByTestId('compare-create'))
    await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(1))
    // capability false：legacy 送 document_ids（不是 source_ids）
    expect(onCreate.mock.calls[0][0]).toEqual(['doc_src_1', 'doc_src_2'])
  })

  it('#1017 服务端 422 compare_duplicate_document_versions → 稳定文案显示（不静默合并/丢弃）', () => {
    renderC05Panel({
      rows: [source({ source_id: 'src_1' }), source({ source_id: 'src_2' })],
      selected: ['src_1', 'src_2'],
      error: 'compare_duplicate_document_versions',
      errorCode: 'compare_duplicate_document_versions',
    })

    expect(screen.getByTestId('compare-error')).toHaveTextContent(
      'research.errors.compareDuplicateDocumentVersions',
    )
  })
})
