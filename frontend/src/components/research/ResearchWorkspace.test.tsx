import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { ResearchWorkspace } from './ResearchWorkspace'
import * as api from '@/lib/research/api'
import * as tokenStore from '@/lib/embedded/token-store'
import type { ResearchNote, ResearchSource } from '@/lib/types/research'
import {
  resetGlobalModelStub,
  setGlobalModelStub,
} from '@/test/global-model-stub'

// UI-03 Red：工作区组合（REQ-SCOPE-04）——无项目上下文 fail-closed 错误态；
// 有上下文时加载 Source/Note 并渲染四个面板 Tab。
// #243 §6.4：Chat/Compare 的执行必须经顶层守卫（模型快照 + 外发确认）。

vi.mock('@/lib/research/api', async (importOriginal) => {
  const actual = await importOriginal<typeof api>()
  return {
    ...actual,
    listSources: vi.fn(),
    listNotes: vi.fn(),
    getJob: vi.fn(),
    createCompare: vi.fn(),
    cancelJob: vi.fn(),
    openResearchChatStream: vi.fn(() => () => {}),
  }
})

// 被测对象不是全局模型本身：用测试替身提供 confirmed 模型（本地、可执行）
vi.mock('@/lib/hooks/use-research-global-model')

function b64url(input: string): string {
  return Buffer.from(input).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_')
}

function researchToken(): string {
  const payload = JSON.stringify({ sub: 'u1', project_id: 'proj_1', aud: 'research-workspace' })
  return `h.${b64url(payload)}.s`
}

const source: ResearchSource = {
  source_id: 'src_1',
  document_id: 'doc_1',
  document_version: 'v3',
  status: 'ready',
  content_hash: null,
  synced_at: '2026-08-06T02:00:00Z',
  last_error: null,
}

const note: ResearchNote = {
  note_id: 'note_1',
  project_id: 'proj_1',
  title: 'Note One',
  content: 'body',
  note_type: 'human',
  created_at: '2026-08-06T02:00:00Z',
  updated_at: '2026-08-06T02:00:00Z',
}

describe('ResearchWorkspace', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.clearAllMocks()
    resetGlobalModelStub()
    vi.mocked(api.listSources).mockResolvedValue({ items: [source], next_cursor: null })
    vi.mocked(api.listNotes).mockResolvedValue({ items: [note], next_cursor: null })
  })

  afterEach(() => {
    cleanup()
    tokenStore.clearResearchToken()
  })

  it('无项目上下文（无 Token）显示错误态而非面板', async () => {
    tokenStore.clearResearchToken()
    render(<ResearchWorkspace />)
    expect(await screen.findByText('research.noProjectContext')).toBeInTheDocument()
    expect(screen.queryByRole('tab', { name: /chat/i })).toBeNull()
  })

  it('有 Token 时默认收起选择器，展开后显示 Source/Note 与四个 Tab', async () => {
    tokenStore.setResearchToken(researchToken(), 9999999999)
    render(<ResearchWorkspace />)
    expect(await screen.findByTestId('research-context-scope')).toHaveTextContent('research.layout.projectScope')
    expect(screen.getByText('Note One').closest('#research-context-selection')).toHaveAttribute('hidden')
    const contextButton = screen.getByRole('button', { name: 'research.layout.expandContext' })
    expect(contextButton).toHaveClass('border', 'bg-background', 'shadow-sm')
    fireEvent.click(contextButton)
    expect(await screen.findByText('Note One')).toBeInTheDocument()
    const tabs = screen.getAllByRole('tab').map((tab) => tab.textContent)
    expect(tabs).toEqual([
      'research.tabSearch',
      'research.tabChat',
      'research.tabCompare',
      'research.tabJobs',
    ])
    expect(api.listSources).toHaveBeenCalledWith('proj_1')
    expect(api.listNotes).toHaveBeenCalledWith('proj_1')
  })

  it('Source/Note 长列表在各自最多 200px 的区域内纵向滚动', async () => {
    const sources = Array.from({ length: 12 }, (_, index): ResearchSource => ({
      ...source,
      source_id: `src_${index + 1}`,
      document_id: `doc_${index + 1}`,
    }))
    const notes = Array.from({ length: 12 }, (_, index): ResearchNote => ({
      ...note,
      note_id: `note_${index + 1}`,
      title: `Note ${index + 1}`,
    }))
    vi.mocked(api.listSources).mockResolvedValue({ items: sources, next_cursor: null })
    vi.mocked(api.listNotes).mockResolvedValue({ items: notes, next_cursor: null })
    tokenStore.setResearchToken(researchToken(), 9999999999)

    render(<ResearchWorkspace />)
    fireEvent.click(await screen.findByRole('button', { name: 'research.layout.expandContext' }))

    const sourceList = screen.getByTestId('source-selection-list')
    const noteList = screen.getByTestId('note-selection-list')
    expect(sourceList).toHaveClass('max-h-[200px]', 'overflow-y-auto')
    expect(noteList).toHaveClass('max-h-[200px]', 'overflow-y-auto')
    expect(sourceList.contains(screen.getByTestId('source-src_12'))).toBe(true)
    expect(noteList.contains(screen.getByTestId('note-note_12'))).toBe(true)
  })

  it('#243 §6.4：Chat 发送经顶层守卫——待确认/无模型时不打开流、不留 turn', async () => {
    tokenStore.setResearchToken(researchToken(), 9999999999)
    // 外部模型待确认：守卫登记但不执行（不变量 9）
    setGlobalModelStub({ deferGuarded: true })
    render(<ResearchWorkspace />)
    // Radix Tabs 在 jsdom 下按 mousedown 切换（fireEvent.click 不触发）
    fireEvent.mouseDown(await screen.findByRole('tab', { name: 'research.tabChat' }), {
      button: 0,
      ctrlKey: false,
    })
    fireEvent.change(screen.getByTestId('chat-input'), { target: { value: '问题' } })
    fireEvent.click(screen.getByRole('button', { name: 'research.chatSend' }))

    expect(api.openResearchChatStream).not.toHaveBeenCalled()
    // 输入未被清空：取消确认应零副作用
    expect(screen.getByTestId('chat-input')).toHaveValue('问题')

    // 守卫放行后同一条输入即被派发
    resetGlobalModelStub()
    fireEvent.click(screen.getByRole('button', { name: 'research.chatSend' }))
    await waitFor(() => expect(api.openResearchChatStream).toHaveBeenCalledTimes(1))
    expect(screen.getByTestId('chat-input')).toHaveValue('')
  })

  it('#243 §6.4：Compare 创建经顶层守卫——待确认时不发创建请求', async () => {
    tokenStore.setResearchToken(researchToken(), 9999999999)
    setGlobalModelStub({ deferGuarded: true })
    vi.mocked(api.createCompare).mockResolvedValue({ job_id: 'job_1', status: 'queued' })
    vi.mocked(api.getJob).mockResolvedValue({
      job_id: 'job_1',
      project_id: 'proj_1',
      job_type: 'deep_compare',
      status: 'queued',
      stage: null,
      progress: 0,
      model_id: 'm-local',
      generation_epoch: 1,
      retry_count: 0,
      last_error: null,
      result_ref: null,
      created_at: '2026-08-06T02:00:00Z',
      updated_at: '2026-08-06T02:00:00Z',
    })
    render(<ResearchWorkspace />)
    // 选中一个 Source（Compare 以 document_ids 入参）
    fireEvent.click(await screen.findByRole('button', { name: 'research.layout.expandContext' }))
    fireEvent.click(await screen.findByTestId('source-src_1'))
    fireEvent.mouseDown(await screen.findByRole('tab', { name: 'research.tabCompare' }), {
      button: 0,
      ctrlKey: false,
    })
    fireEvent.click(await screen.findByRole('button', { name: 'research.compareCreate' }))

    // 守卫未放行：不创建 Job、不落 localStorage（不变量 9）
    expect(api.createCompare).not.toHaveBeenCalled()
    expect(localStorage.getItem('rdlens.research.jobs.proj_1')).toBeNull()
  })

  it('#243：无可用全局模型时 Chat 输入/发送禁用并展示引导（评审 Important-2）', async () => {
    tokenStore.setResearchToken(researchToken(), 9999999999)
    setGlobalModelStub({ confirmedModelId: null })
    render(<ResearchWorkspace />)
    fireEvent.mouseDown(await screen.findByRole('tab', { name: 'research.tabChat' }), {
      button: 0,
      ctrlKey: false,
    })

    expect(screen.getByTestId('chat-input')).toBeDisabled()
    expect(screen.getByRole('button', { name: 'research.chatSend' })).toBeDisabled()
    expect(screen.getByTestId('chat-model-blocked-hint')).toHaveTextContent(
      'research.globalModel.selectModelHint',
    )
    expect(api.openResearchChatStream).not.toHaveBeenCalled()
  })

  it('#243：无可用全局模型时 Compare 创建禁用并展示引导（评审 Important-2）', async () => {
    tokenStore.setResearchToken(researchToken(), 9999999999)
    setGlobalModelStub({ confirmedModelId: null })
    render(<ResearchWorkspace />)
    fireEvent.click(await screen.findByRole('button', { name: 'research.layout.expandContext' }))
    fireEvent.click(await screen.findByTestId('source-src_1'))
    fireEvent.mouseDown(await screen.findByRole('tab', { name: 'research.tabCompare' }), {
      button: 0,
      ctrlKey: false,
    })

    expect(screen.getByTestId('compare-create')).toBeDisabled()
    expect(screen.getByTestId('compare-model-blocked-hint')).toHaveTextContent(
      'research.globalModel.selectModelHint',
    )
    expect(api.createCompare).not.toHaveBeenCalled()
  })

  it('加载失败显示错误与重试按钮', async () => {
    tokenStore.setResearchToken(researchToken(), 9999999999)
    vi.mocked(api.listSources).mockRejectedValue(new Error('network down'))
    render(<ResearchWorkspace />)
    expect(await screen.findByRole('button', { name: /retry/i })).toBeInTheDocument()
  })
})
