import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { TransformationsPanel } from './TransformationsPanel'
import { ResearchWorkspaceProvider } from '@/lib/embedded/workspace-context'
import { ResearchScopeProvider, scopeStorageKey, useResearchScope } from '@/lib/research/scope'
import {
  resetGlobalModelStub,
  setGlobalModelStub,
} from '@/test/global-model-stub'
import * as researchApi from '@/lib/research/api'
import type { ResearchSource, ResearchTransformation } from '@/lib/types/research'

// RWV2-12 Red：TransformationsPanel 迁移到共享 Research Scope。
// - 运行对话框只读展示当前 Scope 摘要（Entire project / Selected: N sources, M notes）
//   + Edit scope 入口；不再有第三套 Sources/Notes 复选框。
// - 请求载荷使用 provider 快照：selected=快照 ids；entire_project=派发时
//   分页枚举的全部授权 id（resolveScopeSelection）。
// - 打开/关闭/Edit scope 均不重置全局 Scope；空（entire_project 空项目）
//   阻断并英文引导；派发后修改 Scope/模型不影响在途运行；外部模型
//   consent 取消零副作用（runSnapshot 不设置，摘要仍为 live）。
// - 结果/Citation/requires_job 降级与 Admin 只读行为保持。

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
      opts ? `${key}:${JSON.stringify(opts)}` : key,
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

const runResult = () => ({
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

const USER = 'u1'
const PROJECT = 'proj_1'

/** 预置 provider 的持久化 Scope（与 provider restoreScope 同构）。 */
function seedScope(mode: 'entire_project' | 'selected', sourceIds: string[] = [], noteIds: string[] = []) {
  localStorage.setItem(
    scopeStorageKey(USER, PROJECT),
    JSON.stringify({ version: 1, mode, sourceIds, noteIds }),
  )
}

/** 变更 provider scope 的探针（在途隔离用例用）。 */
function ScopeProbe() {
  const { toggleSource, toggleNote } = useResearchScope()
  return (
    <div>
      <button type="button" data-testid="probe-toggle-src-2" onClick={() => toggleSource('src_2')}>
        toggle-src-2
      </button>
      <button type="button" data-testid="probe-toggle-note-2" onClick={() => toggleNote('note_2')}>
        toggle-note-2
      </button>
    </div>
  )
}

function makeWrapper(role: 'owner' | 'admin_readonly' = 'owner') {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <ResearchWorkspaceProvider userId={USER} projectId={PROJECT} role={role}>
        <ResearchScopeProvider userId={USER} projectId={PROJECT}>
          {children}
        </ResearchScopeProvider>
      </ResearchWorkspaceProvider>
    </QueryClientProvider>
  )
  return { wrapper, queryClient }
}

describe('TransformationsPanel（RWV2-12 共享 Scope）', () => {
  beforeEach(() => {
    localStorage.clear()
    // resetAllMocks 同时清除 mockReturnValueOnce 队列（B1 用例依赖『挂载
    // 查询消费持久默认』的接线前提，Once 残留会污染下一用例；clearAllMocks
    // 只清调用记录不清实现）——见 vitest-factory-mock-reset 模式
    vi.resetAllMocks()
    toastMock.mockClear()
    resetGlobalModelStub()
    vi.mocked(researchApi.listTransformations).mockResolvedValue({
      items: [template()],
      next_cursor: null,
    })
    vi.mocked(researchApi.listSources).mockResolvedValue({ items: [source()], next_cursor: null })
    vi.mocked(researchApi.listNotes).mockResolvedValue({ items: [], next_cursor: null })
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
    expect(screen.queryByLabelText('research.transformations.modelLabel')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'research.transformations.save' }))
    await waitFor(() =>
      expect(researchApi.createTransformation).toHaveBeenCalledWith('proj_1', {
        name: '总结模板',
        prompt_template: '请总结：',
        model_id: 'm-local',
        scope: 'project_private',
      }),
    )
  })

  it('AC-1 selected：运行对话框只读展示 Scope 摘要，载荷=provider 快照 ids，无第三套复选框', async () => {
    seedScope('selected', ['src_1'], [])
    const { wrapper } = makeWrapper()
    vi.mocked(researchApi.runTransformation).mockResolvedValue(runResult())
    render(<TransformationsPanel />, { wrapper })
    await waitFor(() => expect(screen.getByText('总结模板')).toBeInTheDocument())

    fireEvent.click(screen.getByRole('button', { name: 'research.transformations.run' }))
    await waitFor(() =>
      expect(screen.getByTestId('run-scope-summary')).toHaveTextContent('selectedSummary'),
    )
    expect(screen.getByTestId('run-scope-summary').textContent).toContain('"sources":1')
    // 不再渲染来源/笔记复选框（第三套选择状态删除）
    expect(screen.queryByRole('checkbox')).toBeNull()
    // Language 行：按模板单 Prompt 检测（RFC §4.2）
    expect(screen.getByTestId('run-language').textContent).toContain('zh')

    fireEvent.click(screen.getByRole('button', { name: 'research.transformations.confirmRun' }))
    await waitFor(() =>
      expect(researchApi.runTransformation).toHaveBeenCalledWith('proj_1', 'trans_1', {
        source_ids: ['src_1'],
        note_ids: [],
        model_id: 'm-local',
      }, { idempotencyKey: undefined }),
    )
    // 结果与 Citation 展示（回归：引用原文保留）
    await waitFor(() => expect(screen.getByText('总结输出')).toBeInTheDocument())
    expect(screen.getByText('引用原文')).toBeInTheDocument()
  })

  it('AC-1 entire_project：载荷=派发时分页枚举的全部授权 id（Entire project 摘要）', async () => {
    seedScope('entire_project')
    const { wrapper } = makeWrapper()
    vi.mocked(researchApi.runTransformation).mockResolvedValue(runResult())
    render(<TransformationsPanel />, { wrapper })
    await waitFor(() => expect(screen.getByText('总结模板')).toBeInTheDocument())

    fireEvent.click(screen.getByRole('button', { name: 'research.transformations.run' }))
    await waitFor(() =>
      expect(screen.getByTestId('run-scope-summary')).toHaveTextContent('entireProject'),
    )
    // 挂载查询已消费默认 mock；枚举在点击时追加跨页序列
    vi.mocked(researchApi.listSources)
      .mockResolvedValueOnce({ items: [source()], next_cursor: 'c_2' })
      .mockResolvedValueOnce({ items: [source({ source_id: 'src_2', document_id: 'doc_2' })], next_cursor: null })
    vi.mocked(researchApi.listNotes)
      .mockResolvedValueOnce({ items: [{
        note_id: 'note_1',
        project_id: 'proj_1',
        title: 'Note One',
        content: 'body',
        note_type: 'human',
        created_at: '2026-08-06T02:00:00Z',
        updated_at: '2026-08-06T02:00:00Z',
      }], next_cursor: null })

    fireEvent.click(screen.getByRole('button', { name: 'research.transformations.confirmRun' }))
    await waitFor(() =>
      expect(researchApi.runTransformation).toHaveBeenCalledWith('proj_1', 'trans_1', {
        source_ids: ['src_1', 'src_2'],
        note_ids: ['note_1'],
        model_id: 'm-local',
      }, { idempotencyKey: undefined }),
    )
  })

  it('AC-2：打开/关闭（含 Edit scope）运行对话框永不重置全局 Scope', async () => {
    seedScope('selected', ['src_1'], [])
    const { wrapper } = makeWrapper()
    render(<TransformationsPanel />, { wrapper })
    await waitFor(() => expect(screen.getByText('总结模板')).toBeInTheDocument())

    fireEvent.click(screen.getByRole('button', { name: 'research.transformations.run' }))
    await waitFor(() => expect(screen.getByTestId('run-scope-summary')).toBeInTheDocument())
    // Edit scope：仅关闭对话框，不改 provider 状态
    fireEvent.click(screen.getByTestId('run-edit-scope'))
    await waitFor(() => expect(screen.queryByTestId('run-scope-summary')).toBeNull())

    // 重新打开：摘要仍是预置的 selected（1 source）
    fireEvent.click(screen.getByRole('button', { name: 'research.transformations.run' }))
    await waitFor(() =>
      expect(screen.getByTestId('run-scope-summary')).toHaveTextContent('selectedSummary'),
    )
    expect(screen.getByTestId('run-scope-summary').textContent).toContain('"sources":1')
  })

  it('AC-3 可达分支：entire_project 空项目 → 阻断 + 英文引导，不派发', async () => {
    seedScope('entire_project')
    const { wrapper } = makeWrapper()
    render(<TransformationsPanel />, { wrapper })
    await waitFor(() => expect(screen.getByText('总结模板')).toBeInTheDocument())

    fireEvent.click(screen.getByRole('button', { name: 'research.transformations.run' }))
    await waitFor(() => expect(screen.getByTestId('run-scope-summary')).toBeInTheDocument())
    // 枚举返回空项目
    vi.mocked(researchApi.listSources).mockResolvedValue({ items: [], next_cursor: null })
    vi.mocked(researchApi.listNotes).mockResolvedValue({ items: [], next_cursor: null })

    fireEvent.click(screen.getByRole('button', { name: 'research.transformations.confirmRun' }))
    await waitFor(() =>
      expect(screen.getByTestId('run-empty-project-blocked')).toBeInTheDocument(),
    )
    expect(researchApi.runTransformation).not.toHaveBeenCalled()
    // 对话框保持打开（用户可关掉后改 scope）；阻断后 Confirm 禁用防重复枚举
    expect(screen.getByTestId('run-scope-summary')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'research.transformations.confirmRun' })).toBeDisabled()
    // 重开后阻断状态复位，Confirm 恢复可点
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByTestId('run-scope-summary')).toBeNull())
    fireEvent.click(screen.getByRole('button', { name: 'research.transformations.run' }))
    await waitFor(() => expect(screen.getByTestId('run-scope-summary')).toBeInTheDocument())
    expect(screen.getByRole('button', { name: 'research.transformations.confirmRun' })).not.toBeDisabled()
  })

  it('AC-4：派发后修改 Scope 不影响在途运行，且摘要显示派发时快照', async () => {
    seedScope('selected', ['src_1'], [])
    const { wrapper } = makeWrapper()
    const d = deferred<ReturnType<typeof runResult>>()
    vi.mocked(researchApi.runTransformation).mockReturnValue(d.promise)
    render(
      <>
        <TransformationsPanel />
        <ScopeProbe />
      </>,
      { wrapper },
    )
    await waitFor(() => expect(screen.getByText('总结模板')).toBeInTheDocument())

    fireEvent.click(screen.getByRole('button', { name: 'research.transformations.run' }))
    await waitFor(() => expect(screen.getByTestId('run-scope-summary')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: 'research.transformations.confirmRun' }))
    // 在途：变更全局 Scope（toggle 追加 src_2）
    fireEvent.click(screen.getByTestId('probe-toggle-src-2'))
    d.resolve(runResult())
    await waitFor(() => expect(screen.getByText('总结输出')).toBeInTheDocument())

    // 载荷仍是派发时快照（仅 src_1）
    expect(researchApi.runTransformation).toHaveBeenCalledWith('proj_1', 'trans_1', {
      source_ids: ['src_1'],
      note_ids: [],
      model_id: 'm-local',
    }, { idempotencyKey: undefined })
    // 摘要显示派发时快照（1 source），而非 live（2 sources）
    expect(screen.getByTestId('run-scope-summary').textContent).toContain('"sources":1')
  })

  it('AC-6：外部模型 consent 取消零副作用——不派发、runSnapshot 未设置', async () => {
    seedScope('selected', ['src_1'], [])
    // models 必须含 m-ext（data_egress）且 confirmed=m-ext → canExecute=true、
    // needsConsent=true，Confirm 可点，deferGuarded 才真正模拟「待确认/取消」
    // 路径（否则按钮禁用、用例悬空）
    setGlobalModelStub({
      confirmedModelId: 'm-ext',
      needsConsent: true,
      deferGuarded: true,
      models: [{
        model_id: 'm-ext',
        display_name: 'Ext M',
        data_egress: true,
        interactive_context_levels: ['focused'],
      }],
    })
    const { wrapper } = makeWrapper()
    render(
      <>
        <TransformationsPanel />
        <ScopeProbe />
      </>,
      { wrapper },
    )
    await waitFor(() => expect(screen.getByText('总结模板')).toBeInTheDocument())

    fireEvent.click(screen.getByRole('button', { name: 'research.transformations.run' }))
    await waitFor(() => expect(screen.getByTestId('run-scope-summary')).toBeInTheDocument())
    // N1 栅栏：Confirm 必须可点，否则本例静默退回悬空（canExecute 回归即红）
    expect(
      screen.getByRole('button', { name: 'research.transformations.confirmRun' }),
    ).not.toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'research.transformations.confirmRun' }))

    // 未派发、无结果（deferGuarded 下 operation 未执行）
    expect(researchApi.runTransformation).not.toHaveBeenCalled()
    expect(screen.queryByText('总结输出')).toBeNull()
    // N2 判别：变更 live scope 后摘要跟随 live（runSnapshot 未设置才会
    // 显示 sources:2；若错误设置了派发快照则冻结在 sources:1）
    fireEvent.click(screen.getByTestId('probe-toggle-src-2'))
    expect(screen.getByTestId('run-scope-summary').textContent).toContain('"sources":2')
  })

  it('#243 §6.6：无 confirmed 全局模型时不可创建也不可运行（不变量 2/7）', async () => {
    setGlobalModelStub({ confirmedModelId: null })
    seedScope('selected', ['src_1'], [])
    const { wrapper } = makeWrapper()
    render(<TransformationsPanel />, { wrapper })
    await waitFor(() => expect(screen.getByText('总结模板')).toBeInTheDocument())

    fireEvent.click(screen.getByRole('button', { name: 'research.transformations.run' }))
    const confirmButton = screen.getByRole('button', { name: 'research.transformations.confirmRun' })
    expect(confirmButton).toBeDisabled()
    fireEvent.click(confirmButton)
    expect(researchApi.runTransformation).not.toHaveBeenCalled()
  })

  it('Admin：模板可见但不可创建、不可运行', async () => {
    const { wrapper } = makeWrapper('admin_readonly')
    render(<TransformationsPanel />, { wrapper })
    await waitFor(() => expect(screen.getByText('总结模板')).toBeInTheDocument())
    expect(screen.queryByRole('button', { name: 'research.transformations.newTemplate' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'research.transformations.run' })).toBeNull()
    expect(screen.getByText('research.workbench.adminBanner')).toBeInTheDocument()
  })

  it('run 返回 requires_job → 展示持久化任务降级提示（回归）', async () => {
    seedScope('selected', ['src_1'], [])
    const { wrapper } = makeWrapper()
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
    render(<TransformationsPanel />, { wrapper })
    await waitFor(() => expect(screen.getByText('总结模板')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: 'research.transformations.run' }))
    await waitFor(() => expect(screen.getByTestId('run-scope-summary')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: 'research.transformations.confirmRun' }))
    await waitFor(() => {
      const degraded = screen.getByText(/research\.transformations\.degraded/)
      expect(degraded.textContent).toContain('output_too_large')
    })
  })

  it('B1 派发中止：entire_project 解析在途时关闭对话框 → 不派发', async () => {
    seedScope('entire_project')
    const { wrapper } = makeWrapper()
    const d = deferred<{ items: ResearchSource[]; next_cursor: string | null }>()
    vi.mocked(researchApi.listNotes).mockResolvedValue({ items: [], next_cursor: null })
    render(<TransformationsPanel />, { wrapper })
    await waitFor(() => expect(screen.getByText('总结模板')).toBeInTheDocument())

    fireEvent.click(screen.getByRole('button', { name: 'research.transformations.run' }))
    await waitFor(() => expect(screen.getByTestId('run-scope-summary')).toBeInTheDocument())
    // 渲染后挂 deferred：挂载查询已消费 beforeEach 持久默认，第一次枚举
    // （listSources('proj_1', { limit: 100 })）将消费本 Once → 枚举真实挂起
    vi.mocked(researchApi.listSources).mockReturnValueOnce(d.promise)
    fireEvent.click(screen.getByRole('button', { name: 'research.transformations.confirmRun' }))
    // 枚举在途（第 2 次 listSources，带 limit）已挂起
    await waitFor(() =>
      expect(researchApi.listSources).toHaveBeenCalledWith('proj_1', { limit: 100 }),
    )
    // Esc 关闭对话框
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByTestId('run-scope-summary')).toBeNull())
    // 枚举返回后：令牌失效 → 不派发（旧代码在此路径也会拦截：
    // 判别责任在下一个用例的击穿场景）
    d.resolve({ items: [source()], next_cursor: null })
    await waitFor(() => expect(researchApi.runTransformation).not.toHaveBeenCalled())
  })

  it('B1 击穿修复：解析在途关闭并重开同一模板 → 旧流不派发，新确认正常派发', async () => {
    seedScope('entire_project')
    const { wrapper } = makeWrapper()
    const d = deferred<{ items: ResearchSource[]; next_cursor: string | null }>()
    vi.mocked(researchApi.listNotes).mockResolvedValue({ items: [], next_cursor: null })
    vi.mocked(researchApi.runTransformation).mockResolvedValue(runResult())
    render(<TransformationsPanel />, { wrapper })
    await waitFor(() => expect(screen.getByText('总结模板')).toBeInTheDocument())

    fireEvent.click(screen.getByRole('button', { name: 'research.transformations.run' }))
    await waitFor(() => expect(screen.getByTestId('run-scope-summary')).toBeInTheDocument())
    // 挂 deferred 到第一次枚举（渲染后；挂载查询已消费默认）
    vi.mocked(researchApi.listSources).mockReturnValueOnce(d.promise)
    fireEvent.click(screen.getByRole('button', { name: 'research.transformations.confirmRun' }))
    await waitFor(() =>
      expect(researchApi.listSources).toHaveBeenCalledWith('proj_1', { limit: 100 }),
    )
    // 枚举在途：Esc 关闭 + 重开同一模板（对象同一性守卫曾被击穿的路径）
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByTestId('run-scope-summary')).toBeNull())
    fireEvent.click(screen.getByRole('button', { name: 'research.transformations.run' }))
    await waitFor(() => expect(screen.getByTestId('run-scope-summary')).toBeInTheDocument())
    // 旧枚举返回：runTargetRef 已重新指向同一模板对象——对象同一性守卫
    // 会放行（修复前代码此处必红）；令牌守卫必须废弃旧执行流。
    // 先冲刷宏任务让陈旧流 continuation 确定性执行，避免 waitFor 首次
    // 同步检查与微任务 continuation 竞速产生假绿（实测时序抖动）。
    d.resolve({ items: [source()], next_cursor: null })
    await new Promise((r) => setTimeout(r, 50))
    await waitFor(() => expect(researchApi.runTransformation).not.toHaveBeenCalled())
    // 新的 Confirm 正常派发（当前快照；枚举走 beforeEach 持久默认）
    fireEvent.click(screen.getByRole('button', { name: 'research.transformations.confirmRun' }))
    await waitFor(() =>
      expect(researchApi.runTransformation).toHaveBeenCalledWith('proj_1', 'trans_1', {
        source_ids: ['src_1'],
        note_ids: [],
        model_id: 'm-local',
      }, { idempotencyKey: undefined }),
    )
  })
})

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}
