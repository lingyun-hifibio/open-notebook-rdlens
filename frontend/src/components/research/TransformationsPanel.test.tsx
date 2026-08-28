import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { TransformationsPanel } from './TransformationsPanel'
import { ResearchWorkspaceProvider } from '@/lib/embedded/workspace-context'
import {
  resetGlobalModelStub,
  setGlobalModelStub,
} from '@/test/global-model-stub'
import * as researchApi from '@/lib/research/api'
import type { ResearchSource, ResearchTransformation } from '@/lib/types/research'

// UI-02 Red：Transformations 工作台（REQ-SCOPE-04/REQ-DIS-02/03/
// REQ-API-01，契约 §7.3）——模板仅 prompt-only 字段（无 code/tool/url）；
// 运行只走 Gateway run 端点；结果含 Citation（CitationCard）；
// Admin 只读不可运行。
// #243 §6.6：模型来自顶层全局设置（测试替身提供 confirmed 模型），
// 面板内没有模型输入，也没有局部外发确认复选框（§4 单一 consent 逻辑）。

vi.mock('@/lib/research/api', () => ({
  listSources: vi.fn(),
  getSource: vi.fn(),
  listNotes: vi.fn(),
  createNote: vi.fn(),
  updateNote: vi.fn(),
  deleteNote: vi.fn(),
  listInsights: vi.fn(),
  createInsight: vi.fn(),
  listTransformations: vi.fn(),
  createTransformation: vi.fn(),
  runTransformation: vi.fn(),
  createExport: vi.fn(),
  downloadExport: vi.fn(),
}))

// 被测对象不是全局模型本身：用测试替身提供 confirmed 模型（本地、可执行）
vi.mock('@/lib/hooks/use-research-global-model')

vi.mock('@/lib/hooks/use-translation', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts ? `${key}:${String(opts.reason ?? '')}` : key,
  }),
}))

const toastMock = vi.fn()
vi.mock('@/lib/hooks/use-toast', () => ({
  useToast: () => ({ toast: toastMock }),
}))

const template = (overrides: Partial<ResearchTransformation> = {}): ResearchTransformation => ({
  transformation_id: 'trans_1',
  project_id: 'proj_1',
  name: '总结模板',
  prompt_template: '请总结：',
  model_id: 'qwen3.6-35b-a3b-fp8',
  scope: 'project_private',
  created_at: '2026-08-06T02:00:00Z',
  ...overrides,
})

const source = (overrides: Partial<ResearchSource> = {}): ResearchSource => ({
  source_id: 'src_1',
  document_id: 'doc_1',
  document_version: 'v3',
  status: 'ready',
  content_hash: 'h',
  synced_at: null,
  last_error: null,
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

describe('TransformationsPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    toastMock.mockClear()
    resetGlobalModelStub()
  })

  it('Owner：创建模板仅提交 prompt-only 四字段（无 code/tool/url，REQ-DIS-03）', async () => {
    vi.mocked(researchApi.listTransformations).mockResolvedValue({ items: [], next_cursor: null })
    vi.mocked(researchApi.createTransformation).mockResolvedValue(template())
    const { wrapper } = makeWrapper()
    render(<TransformationsPanel />, { wrapper })
    await waitFor(() => expect(researchApi.listTransformations).toHaveBeenCalled())

    fireEvent.click(screen.getByRole('button', { name: 'research.transformations.newTemplate' }))
    fireEvent.change(screen.getByLabelText('research.transformations.nameLabel'), {
      target: { value: '总结模板' },
    })
    fireEvent.change(screen.getByLabelText('research.transformations.promptLabel'), {
      target: { value: '请总结：' },
    })
    // §6.6：面板内不再有模型输入
    expect(screen.queryByLabelText('research.transformations.modelLabel')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'research.transformations.save' }))
    await waitFor(() =>
      expect(researchApi.createTransformation).toHaveBeenCalledWith('proj_1', {
        name: '总结模板',
        prompt_template: '请总结：',
        // 顶层 confirmed 全局模型快照（创建时的 provenance）
        model_id: 'm-local',
        scope: 'project_private',
      }),
    )
  })

  it('Owner：运行流程——先展示数据外发提示，确认后只调用 Gateway run 端点（REQ-DIS-02）', async () => {
    vi.mocked(researchApi.listTransformations).mockResolvedValue({
      items: [template()],
      next_cursor: null,
    })
    vi.mocked(researchApi.listSources).mockResolvedValue({ items: [source()], next_cursor: null })
    vi.mocked(researchApi.listNotes).mockResolvedValue({ items: [], next_cursor: null })
    vi.mocked(researchApi.runTransformation).mockResolvedValue({
      request_id: 'req_1',
      transformation_id: 'trans_1',
      requires_job: false,
      degradation_reason: null,
      result_id: 'r_1',
      model_id: 'qwen3.6-35b-a3b-fp8',
      source_refs: ['src_1'],
      usage: { input_tokens: 10, output_tokens: 5 },
      citations: [{
        citation_id: 'c_1',
        claim: '引用声明',
        chunk_id: 'chunk_1',
        doc_id: 'doc_1',
        doc_version: 'v3',
        page_idx: 3,
        section: null,
        original_text: '引用原文',
        citation_type: null,
        confidence: null,
        doc_display_name: 'Paper A',
        short_name: 'A',
        doc_type: 'pdf',
        project_id: 'proj_1',
        vlm_bboxes: null,
        minio_uri: null,
        source_path: null,
      }],
      output: '总结输出',
    })
    const { wrapper } = makeWrapper()
    render(<TransformationsPanel />, { wrapper })
    await waitFor(() => expect(screen.getByText('总结模板')).toBeInTheDocument())

    fireEvent.click(screen.getByRole('button', { name: 'research.transformations.run' }))
    // §6.6：外发确认不再是本面板的局部复选框
    expect(screen.queryByText('research.transformations.egressTitle')).toBeNull()
    // 勾选来源输入（等待来源查询加载完成）
    fireEvent.click(await screen.findByRole('checkbox', { name: /doc_1/ }))
    fireEvent.click(screen.getByRole('button', { name: 'research.transformations.confirmRun' }))

    await waitFor(() =>
      expect(researchApi.runTransformation).toHaveBeenCalledWith('proj_1', 'trans_1', {
        source_ids: ['src_1'],
        note_ids: [],
        // 运行时刻的顶层模型快照（非模板历史模型）
        model_id: 'm-local',
      }),
    )
    // 结果与 Citation 展示（原文保留）
    await waitFor(() => expect(screen.getByText('总结输出')).toBeInTheDocument())
    expect(screen.getByText('引用原文')).toBeInTheDocument()
  })

  it('#243 §6.6：无 confirmed 全局模型时不可创建也不可运行（不变量 2/7）', async () => {
    setGlobalModelStub({ confirmedModelId: null })
    vi.mocked(researchApi.listTransformations).mockResolvedValue({
      items: [template()],
      next_cursor: null,
    })
    vi.mocked(researchApi.listSources).mockResolvedValue({ items: [source()], next_cursor: null })
    vi.mocked(researchApi.listNotes).mockResolvedValue({ items: [], next_cursor: null })
    const { wrapper } = makeWrapper()
    render(<TransformationsPanel />, { wrapper })
    await waitFor(() => expect(screen.getByText('总结模板')).toBeInTheDocument())

    // 面板内没有模型输入，也没有局部外发确认入口
    fireEvent.click(screen.getByRole('button', { name: 'research.transformations.run' }))
    const confirmButton = screen.getByRole('button', { name: 'research.transformations.confirmRun' })
    expect(confirmButton).toBeDisabled()
    fireEvent.click(confirmButton)
    expect(researchApi.runTransformation).not.toHaveBeenCalled()
  })

  it('Admin：模板可见但不可创建、不可运行', async () => {
    vi.mocked(researchApi.listTransformations).mockResolvedValue({
      items: [template()],
      next_cursor: null,
    })
    const { wrapper } = makeWrapper('admin_readonly')
    render(<TransformationsPanel />, { wrapper })
    await waitFor(() => expect(screen.getByText('总结模板')).toBeInTheDocument())
    expect(screen.queryByRole('button', { name: 'research.transformations.newTemplate' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'research.transformations.run' })).toBeNull()
    expect(screen.getByText('research.workbench.adminBanner')).toBeInTheDocument()
  })

  it('run 返回 requires_job → 展示持久化任务降级提示', async () => {
    vi.mocked(researchApi.listTransformations).mockResolvedValue({
      items: [template()],
      next_cursor: null,
    })
    vi.mocked(researchApi.listSources).mockResolvedValue({ items: [source()], next_cursor: null })
    vi.mocked(researchApi.listNotes).mockResolvedValue({ items: [], next_cursor: null })
    vi.mocked(researchApi.runTransformation).mockResolvedValue({
      request_id: 'req_1',
      transformation_id: 'trans_1',
      requires_job: true,
      degradation_reason: 'output_too_large',
      result_id: null,
      model_id: 'qwen3.6-35b-a3b-fp8',
      source_refs: [],
      usage: { input_tokens: 0, output_tokens: 0 },
      citations: [],
      output: null,
    })
    const { wrapper } = makeWrapper()
    render(<TransformationsPanel />, { wrapper })
    await waitFor(() => expect(screen.getByText('总结模板')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: 'research.transformations.run' }))
    fireEvent.click(screen.getByRole('button', { name: 'research.transformations.confirmRun' }))
    await waitFor(() =>
      expect(screen.getByText(/research.transformations.degraded:output_too_large/)).toBeInTheDocument(),
    )
  })
})
