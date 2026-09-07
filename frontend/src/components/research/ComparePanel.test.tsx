import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { ComparePanel } from './ComparePanel'
import { ResearchScopeProvider, scopeStorageKey } from '@/lib/research/scope'
import type { ResearchSource } from '@/lib/types/research'

// UI-03 Red：Compare 面板边界（REQ-QUOTA-01）——51 篇拒绝（组件级）、
// 31–50 超默认提示、空选禁用、document_ids 正确映射。
// RWV2-11（K2/K7）：面板直接消费共享 ResearchScopeProvider——测试经
// localStorage 预置范围（仿 scope.test.tsx 模式）；entire_project 模式
// 显示专属英文消息并禁用创建（mode 前置，不落入通用 empty）。

const USER_ID = 'u1'
const PROJECT_ID = 'p1'

function sources(count: number): ResearchSource[] {
  return Array.from({ length: count }, (_, i) => ({
    source_id: `src_${i}`,
    document_id: `doc_${i}`,
    document_version: 'v3',
    status: 'ready',
    content_hash: null,
    synced_at: '2026-08-06T02:00:00Z',
    last_error: null,
  }))
}

function seedScope(
  mode: 'entire_project' | 'selected',
  sourceIds: string[],
  noteIds: string[] = [],
): void {
  localStorage.setItem(
    scopeStorageKey(USER_ID, PROJECT_ID),
    JSON.stringify({ version: 1, mode, sourceIds, noteIds }),
  )
}

function renderPanel(sources: ResearchSource[], selected: string[], mode: 'entire_project' | 'selected' = 'selected') {
  seedScope(mode, selected)
  return render(
    <ResearchScopeProvider userId={USER_ID} projectId={PROJECT_ID}>
      <ComparePanel
        sources={sources}
        isCreating={false}
        error={null}
        onCreate={vi.fn(async () => true)}
      />
    </ResearchScopeProvider>,
  )
}

describe('ComparePanel', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  afterEach(() => {
    cleanup()
    localStorage.clear()
  })

  it('entire_project 模式：明确英文消息并禁用创建（不落入通用 empty）', () => {
    renderPanel(sources(5), [], 'entire_project')
    expect(screen.getByRole('button', { name: /compare/ })).toBeDisabled()
    expect(screen.getByTestId('compare-entire-project')).toBeInTheDocument()
    expect(screen.queryByTestId('compare-empty')).toBeNull()
  })

  it('51 篇被拒绝：创建按钮禁用并显示硬上限提示', () => {
    const all = sources(51)
    renderPanel(all, all.map((s) => s.source_id))
    expect(screen.getByRole('button', { name: /compare/ })).toBeDisabled()
    expect(screen.getByText(/50/)).toBeInTheDocument()
  })

  it('31–50 篇允许创建但显示超默认警告', () => {
    const all = sources(31)
    renderPanel(all, all.map((s) => s.source_id))
    expect(screen.getByRole('button', { name: /compare/ })).toBeEnabled()
    expect(screen.getByText(/30/)).toBeInTheDocument()
  })

  it('30 篇以内无警告，按钮可用', () => {
    const all = sources(30)
    renderPanel(all, all.map((s) => s.source_id))
    expect(screen.getByRole('button', { name: /compare/ })).toBeEnabled()
    expect(screen.queryByText(/Exceeds/)).toBeNull()
  })

  it('selected 但映射为空（选定的 ID 不在已加载来源列表）禁用并提示先选择', () => {
    // RWV2-11（B6）：映射基于已加载列表；列表外的 selected ID 静默不参与，
    // 落入通用 empty 消息（删除/失效清理属 RWV2-14）
    renderPanel(sources(5), ['src_missing'])
    expect(screen.getByRole('button', { name: /compare/ })).toBeDisabled()
    expect(screen.getByTestId('compare-empty')).toBeInTheDocument()
  })

  it('点击创建把选中 Source 映射为 document_ids 回调，派发后显示已创建', async () => {
    const all = sources(3)
    const onCreate = vi.fn(async () => true)
    seedScope('selected', ['src_0', 'src_2'])
    render(
      <ResearchScopeProvider userId={USER_ID} projectId={PROJECT_ID}>
        <ComparePanel
          sources={all}
          isCreating={false}
          error={null}
          onCreate={onCreate}
        />
      </ResearchScopeProvider>,
    )
    fireEvent.click(screen.getByRole('button', { name: /compare/ }))
    await waitFor(() => expect(onCreate).toHaveBeenCalledWith(['doc_0', 'doc_2']))
    expect(await screen.findByTestId('compare-submitted')).toBeInTheDocument()
  })

  it('守卫未派发（onCreate 返回 false）时不显示「已创建」（评审 MEDIUM-1）', async () => {
    const all = sources(3)
    const onCreate = vi.fn(async () => false)
    seedScope('selected', ['src_0', 'src_2'])
    render(
      <ResearchScopeProvider userId={USER_ID} projectId={PROJECT_ID}>
        <ComparePanel
          sources={all}
          isCreating={false}
          error={null}
          onCreate={onCreate}
        />
      </ResearchScopeProvider>,
    )
    fireEvent.click(screen.getByRole('button', { name: /compare/ }))
    await waitFor(() => expect(onCreate).toHaveBeenCalledWith(['doc_0', 'doc_2']))
    // consent 取消 = 未派发：不误报「已创建」
    expect(screen.queryByTestId('compare-submitted')).toBeNull()
  })

  it('创建中禁用按钮并显示进度文案', () => {
    const all = sources(2)
    seedScope('selected', all.map((s) => s.source_id))
    render(
      <ResearchScopeProvider userId={USER_ID} projectId={PROJECT_ID}>
        <ComparePanel
          sources={all}
          isCreating
          error={null}
          onCreate={vi.fn()}
        />
      </ResearchScopeProvider>,
    )
    expect(screen.getByRole('button', { name: /compare/ })).toBeDisabled()
  })

  it('错误信息透出：generic 主文案 + raw 仅次级诊断（RWV2-42 AC8）', () => {
    const all = sources(2)
    seedScope('selected', all.map((s) => s.source_id))
    render(
      <ResearchScopeProvider userId={USER_ID} projectId={PROJECT_ID}>
        <ComparePanel
          sources={all}
          isCreating={false}
          error="compare.createFailed"
          onCreate={vi.fn()}
        />
      </ResearchScopeProvider>,
    )
    // 主消息 = 通用文案 key；旧伪 key 字面量只作次级诊断行，不再是主消息
    expect(screen.getByText('research.errors.generic')).toBeInTheDocument()
    expect(screen.getByText('compare.createFailed')).toBeInTheDocument()
  })

  it('RWV2-42：HTTP 稳定码 → 映射主文案；raw code 不作主消息', () => {
    const all = sources(2)
    seedScope('selected', all.map((s) => s.source_id))
    render(
      <ResearchScopeProvider userId={USER_ID} projectId={PROJECT_ID}>
        <ComparePanel
          sources={all}
          isCreating={false}
          error="engine down"
          errorCode="engine_unavailable"
          onCreate={vi.fn()}
        />
      </ResearchScopeProvider>,
    )
    expect(screen.getByText('research.errors.engineUnavailable')).toBeInTheDocument()
    expect(screen.queryByText('engine_unavailable')).toBeNull()
    expect(screen.getByText('engine down')).toBeInTheDocument()
  })

  it('RWV2-42（R4-H2）：专用状态 Alert 可见时不渲染 hook 错误行（防双文案）', () => {
    // selected 空 → 面板显示 compare-empty Alert；hook 陈旧错误不得叠加
    seedScope('selected', [])
    render(
      <ResearchScopeProvider userId={USER_ID} projectId={PROJECT_ID}>
        <ComparePanel
          sources={sources(2)}
          isCreating={false}
          error="stale error"
          errorCode="quota_exceeded"
          onCreate={vi.fn()}
        />
      </ResearchScopeProvider>,
    )
    expect(screen.getByTestId('compare-empty')).toBeInTheDocument()
    expect(screen.queryByTestId('compare-error')).toBeNull()
    expect(screen.queryByText('stale error')).toBeNull()
  })
})