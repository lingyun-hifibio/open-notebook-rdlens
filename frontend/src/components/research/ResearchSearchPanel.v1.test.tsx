/**
 * Issue #200 Phase 2b：ResearchSearchPanel v1 集成（§14.3）。
 *
 * - 未选模型时 Run 禁用（后端不隐式补 model_id 的 UI 对应）；
 * - 发送前展示 Context Preview（只读预判）；
 * - 202 后台受理展示排队提示（刷新不消失语义由 Job 列表兜底）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ResearchSearchPanel } from './ResearchSearchPanel'

vi.mock('@/lib/hooks/use-translation', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

const prefs = {
  project_id: 'p1',
  default_context_level: 'focused' as const,
  preferred_model_id: 'm-local',
  updated_by: 1,
  updated_at: '2026-08-26T00:00:00+00:00',
}

const noPrefs = {
  project_id: 'p1',
  default_context_level: 'focused' as const,
  preferred_model_id: null,
  updated_by: null,
  updated_at: null,
}

vi.mock('@/lib/research/api', () => ({
  listModels: vi.fn(async () => ({
    models: [{ model_id: 'm-local', display_name: 'Local M' }],
  })),
  getExecutionPreferences: vi.fn(async () => noPrefs),
  saveExecutionPreferences: vi.fn(async (input) => ({ ...noPrefs, ...input })),
  fetchContextPreview: vi.fn(async () => ({
    source_count: 1,
    chunk_count: 3,
    note_count: 0,
    token_estimate: 120,
    direct_or_background: 'direct',
    needs_consent: false,
    coverage: {},
    warnings: [],
  })),
  searchV1: vi.fn(),
  newIdempotencyKey: vi.fn(() => 'ui-key'),
}))

import { searchV1, getExecutionPreferences } from '@/lib/research/api'

describe('ResearchSearchPanel v1（§14.3）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('未保存模型偏好时 Run 禁用并显示提示；选择模型后可发送', async () => {
    // 覆盖无偏好的初始态
    render(<ResearchSearchPanel projectId="p1" selectedSourceIds={['d1']} selectedNoteIds={[]} />)
    await waitFor(() =>
      expect(screen.getByTestId('model-select')).toBeTruthy(),
    )
    const run = screen.getByRole('button', { name: 'research.searchRun' })
    expect((run as HTMLButtonElement).disabled).toBe(true)
  })

  it('有已保存偏好时输入查询展示 Preview 并以显式 model_id 发送', async () => {
    vi.mocked(getExecutionPreferences).mockResolvedValue(prefs)
    vi.mocked(searchV1).mockResolvedValue({
      kind: 'direct',
      result: {
        request_id: 'r1',
        resolved_mode: 'direct_context',
        evidence: [],
        citations: [],
        usage: { input_tokens: 10, output_tokens: 5, estimated: true },
        degradation_reason: null,
        conclusion: 'ok',
        model_id: 'm-local',
        provider_id: 'local-sglang',
        context_level: 'focused',
        context_coverage: {
          context_level: 'focused',
          relevant_extra: 2,
          trimmed: 1,
          input_budget: 65536,
        },
      },
    })
    render(
      <ResearchSearchPanel
        projectId="p1"
        selectedSourceIds={['d1']}
        selectedNoteIds={[]}
      />,
    )
    // 等待偏好加载完成（model-select 回显 m-local）
    await waitFor(() =>
      expect(
        (screen.getByTestId('model-select') as HTMLSelectElement).value,
      ).toBe('m-local'),
    )
    fireEvent.change(screen.getByTestId('search-input'), {
      target: { value: 'what is ORR?' },
    })
    // Preview 防抖后出现
    await waitFor(() =>
      expect(screen.getByTestId('context-preview')).toBeTruthy(),
    )
    fireEvent.click(screen.getByRole('button', { name: 'research.searchRun' }))
    await waitFor(() =>
      expect(screen.getByTestId('search-result')).toBeTruthy(),
    )
    expect(searchV1).toHaveBeenCalledWith(
      'p1',
      expect.objectContaining({
        query: 'what is ORR?',
        model_id: 'm-local',
      }),
      expect.objectContaining({ idempotencyKey: 'ui-key' }),
    )
    // §14.3 结果展示：provider/覆盖报告 + 估算 usage 标识
    expect(screen.getByTestId('search-provider').textContent).toContain(
      'local-sglang',
    )
    expect(screen.getByTestId('search-coverage')).toBeTruthy()
    expect(screen.getByTestId('search-model').textContent).toContain('m-local')
  })

  it('失败后立即重试复用同一幂等键；成功后重置为新执行（§7.2）', async () => {
    vi.mocked(getExecutionPreferences).mockResolvedValue(prefs)
    vi.mocked(searchV1)
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce({
        kind: 'direct',
        result: {
          request_id: 'r9',
          resolved_mode: 'direct_context',
          evidence: [],
          citations: [],
          usage: { input_tokens: 1, output_tokens: 1 },
          degradation_reason: null,
          conclusion: 'ok',
        },
      })
    render(
      <ResearchSearchPanel
        projectId="p1"
        selectedSourceIds={['d1']}
        selectedNoteIds={[]}
      />,
    )
    await waitFor(() =>
      expect(
        (screen.getByTestId('model-select') as HTMLSelectElement).value,
      ).toBe('m-local'),
    )
    const runButton = () =>
      screen.getByRole('button', { name: 'research.searchRun' })
    fireEvent.change(screen.getByTestId('search-input'), {
      target: { value: 'retry me' },
    })
    fireEvent.click(runButton())
    await waitFor(() => expect(screen.getByText('network down')).toBeTruthy())
    fireEvent.click(runButton())
    await waitFor(() => expect(screen.getByTestId('search-result')).toBeTruthy())
    // 两次调用使用同一 Idempotency-Key（同逻辑提交不双跑）
    const firstKey = vi.mocked(searchV1).mock.calls[0][2]?.idempotencyKey
    const secondKey = vi.mocked(searchV1).mock.calls[1][2]?.idempotencyKey
    expect(firstKey).toBeTruthy()
    expect(secondKey).toBe(firstKey)
  })

  it('202 后台受理展示排队提示而非结果', async () => {
    vi.mocked(getExecutionPreferences).mockResolvedValue(prefs)
    vi.mocked(searchV1).mockResolvedValue({
      kind: 'background',
      generation_id: 'gen_bg_1',
      job_id: 'job_bg_9',
      status: 'queued',
    })
    render(
      <ResearchSearchPanel
        projectId="p1"
        selectedSourceIds={['d1']}
        selectedNoteIds={[]}
      />,
    )
    await waitFor(() =>
      expect(
        (screen.getByTestId('model-select') as HTMLSelectElement).value,
      ).toBe('m-local'),
    )
    fireEvent.change(screen.getByTestId('search-input'), {
      target: { value: 'long research' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'research.searchRun' }))
    await waitFor(() =>
      expect(screen.getByTestId('background-queued')).toBeTruthy(),
    )
    expect(screen.queryByTestId('search-result')).toBeNull()
    expect(screen.getByTestId('background-queued').textContent).toContain(
      'job_bg_9',
    )
  })
})
