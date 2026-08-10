import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { InsightsPanel } from './InsightsPanel'
import { ResearchWorkspaceProvider } from '@/lib/embedded/workspace-context'
import * as researchApi from '@/lib/research/api'
import type { ResearchInsight } from '@/lib/types/research'

// UI-02 Red：Insights 工作台（REQ-SCOPE-04/REQ-API-01，契约 §7.2）——
// manual/ai 两类创建；Owner 可写，Admin 只读（无写入口）；保存不触发
// Embedding（REQ-DIS-01 语义延伸）。

vi.mock('@/lib/research/api', () => ({
  listInsights: vi.fn(),
  createInsight: vi.fn(),
}))

vi.mock('@/lib/hooks/use-translation', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}))

const toastMock = vi.fn()
vi.mock('@/lib/hooks/use-toast', () => ({
  useToast: () => ({ toast: toastMock }),
}))

const insight = (overrides: Partial<ResearchInsight> = {}): ResearchInsight => ({
  insight_id: 'ins_1',
  project_id: 'proj_1',
  title: '关键发现',
  content: 'A 与 B 显著相关',
  insight_type: 'manual',
  model_id: null,
  created_at: '2026-08-06T02:00:00Z',
  updated_at: '2026-08-06T02:00:00Z',
  ...overrides,
})

function makeWrapper(role: 'owner' | 'admin_readonly' = 'owner') {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <ResearchWorkspaceProvider projectId="proj_1" role={role}>
        {children}
      </ResearchWorkspaceProvider>
    </QueryClientProvider>
  )
  return { wrapper, queryClient }
}

describe('InsightsPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // radix Select 在 jsdom 中调用 scrollIntoView（无实现）
    Element.prototype.scrollIntoView = vi.fn()
  })

  it('Owner：列表 + 手动 Insight 创建（manual 不带 model_id）', async () => {
    vi.mocked(researchApi.listInsights).mockResolvedValue({ items: [insight()], next_cursor: null })
    vi.mocked(researchApi.createInsight).mockResolvedValue(insight({ insight_id: 'ins_2' }))
    const { wrapper } = makeWrapper()
    render(<InsightsPanel />, { wrapper })
    await waitFor(() => expect(screen.getByText('关键发现')).toBeInTheDocument())

    fireEvent.click(screen.getByRole('button', { name: 'research.insights.newInsight' }))
    fireEvent.change(screen.getByLabelText('research.notes.titleLabel'), {
      target: { value: '新发现' },
    })
    fireEvent.change(screen.getByLabelText('research.notes.contentLabel'), {
      target: { value: '新内容' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'research.notes.save' }))
    await waitFor(() =>
      expect(researchApi.createInsight).toHaveBeenCalledWith('proj_1', {
        title: '新发现',
        content: '新内容',
        insight_type: 'manual',
      }),
    )
  })

  it('AI 类型创建必须填写 model_id（契约 §7.2：ai 必带已批准模型）', async () => {
    vi.mocked(researchApi.listInsights).mockResolvedValue({ items: [], next_cursor: null })
    vi.mocked(researchApi.createInsight).mockResolvedValue(
      insight({ insight_type: 'ai', model_id: 'qwen3.6' }),
    )
    const { wrapper } = makeWrapper()
    render(<InsightsPanel />, { wrapper })
    await waitFor(() => expect(researchApi.listInsights).toHaveBeenCalled())
    fireEvent.click(screen.getByRole('button', { name: 'research.insights.newInsight' }))
    fireEvent.change(screen.getByLabelText('research.notes.titleLabel'), {
      target: { value: 'AI 发现' },
    })
    fireEvent.change(screen.getByLabelText('research.notes.contentLabel'), {
      target: { value: '生成内容' },
    })
    // 选择 AI 类型（radix Select：点击触发器 → 点击选项）
    fireEvent.click(screen.getByLabelText('research.insights.typeLabel'))
    fireEvent.click(await screen.findByRole('option', { name: 'research.insights.typeAi' }))
    const modelInput = screen.getByLabelText('research.insights.modelLabel')
    fireEvent.change(modelInput, { target: { value: 'qwen3.6' } })
    fireEvent.click(screen.getByRole('button', { name: 'research.notes.save' }))
    await waitFor(() =>
      expect(researchApi.createInsight).toHaveBeenCalledWith('proj_1', {
        title: 'AI 发现',
        content: '生成内容',
        insight_type: 'ai',
        model_id: 'qwen3.6',
      }),
    )
  })

  it('Admin：只读——列表可见、无新建入口', async () => {
    vi.mocked(researchApi.listInsights).mockResolvedValue({ items: [insight()], next_cursor: null })
    const { wrapper } = makeWrapper('admin_readonly')
    render(<InsightsPanel />, { wrapper })
    await waitFor(() => expect(screen.getByText('关键发现')).toBeInTheDocument())
    expect(screen.queryByRole('button', { name: 'research.insights.newInsight' })).toBeNull()
    expect(screen.getByText('research.workbench.adminBanner')).toBeInTheDocument()
  })
})
