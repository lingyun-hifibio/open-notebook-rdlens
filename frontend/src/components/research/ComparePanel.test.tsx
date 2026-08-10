import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { ComparePanel } from './ComparePanel'
import type { ResearchSource } from '@/lib/types/research'

// UI-03 Red：Compare 面板边界（REQ-QUOTA-01）——51 篇拒绝（组件级）、
// 31–50 超默认提示、空选禁用、document_ids 正确映射。

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

function renderPanel(sources: ResearchSource[], selected: string[]) {
  return render(
    <ComparePanel
      sources={sources}
      selectedSourceIds={selected}
      isCreating={false}
      error={null}
      onCreate={vi.fn()}
    />,
  )
}

describe('ComparePanel', () => {
  afterEach(cleanup)

  it('51 篇被拒绝：创建按钮禁用并显示硬上限提示', () => {
    const all = sources(51)
    const selected = all.map((s) => s.source_id)
    renderPanel(all, selected)
    expect(screen.getByRole('button', { name: /compare/ })).toBeDisabled()
    expect(screen.getByText(/50/)).toBeInTheDocument()
  })

  it('31–50 篇允许创建但显示超默认警告', () => {
    const all = sources(31)
    const selected = all.map((s) => s.source_id)
    renderPanel(all, selected)
    expect(screen.getByRole('button', { name: /compare/ })).toBeEnabled()
    expect(screen.getByText(/30/)).toBeInTheDocument()
  })

  it('30 篇以内无警告，按钮可用', () => {
    const all = sources(30)
    const selected = all.map((s) => s.source_id)
    renderPanel(all, selected)
    expect(screen.getByRole('button', { name: /compare/ })).toBeEnabled()
    expect(screen.queryByText(/Exceeds/)).toBeNull()
  })

  it('空选禁用并提示先选择', () => {
    renderPanel(sources(5), [])
    expect(screen.getByRole('button', { name: /compare/ })).toBeDisabled()
  })

  it('点击创建把选中 Source 映射为 document_ids 回调', () => {
    const all = sources(3)
    const onCreate = vi.fn()
    render(
      <ComparePanel
        sources={all}
        selectedSourceIds={['src_0', 'src_2']}
        isCreating={false}
        error={null}
        onCreate={onCreate}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: /compare/ }))
    expect(onCreate).toHaveBeenCalledWith(['doc_0', 'doc_2'])
    expect(screen.getByTestId('compare-submitted')).toBeInTheDocument()
  })

  it('创建中禁用按钮并显示进度文案', () => {
    const all = sources(2)
    render(
      <ComparePanel
        sources={all}
        selectedSourceIds={all.map((s) => s.source_id)}
        isCreating
        error={null}
        onCreate={vi.fn()}
      />,
    )
    expect(screen.getByRole('button', { name: /compare/ })).toBeDisabled()
  })

  it('错误信息透出', () => {
    const all = sources(2)
    render(
      <ComparePanel
        sources={all}
        selectedSourceIds={all.map((s) => s.source_id)}
        isCreating={false}
        error="compare.createFailed"
        onCreate={vi.fn()}
      />,
    )
    expect(screen.getByText('compare.createFailed')).toBeInTheDocument()
  })
})
