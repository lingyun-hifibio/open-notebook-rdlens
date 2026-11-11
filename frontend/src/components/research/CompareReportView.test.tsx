import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

// #1017（D1-H）：deep_compare 结果回访视图——`GET /jobs/{id}` 的加性
// `compare` 段 + 顶层 `verification_record`，以及 report 端点的 410/503
// 终态。report 与 job detail 是两条独立读取：本文件同时替身化。

vi.mock('@/lib/research/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/research/api')>()
  return {
    ...actual,
    getCompareReport: vi.fn(),
    getJob: vi.fn(),
  }
})

import { getCompareReport, getJob } from '@/lib/research/api'
import { CompareReportView } from './CompareReportView'
import type {
  ResearchCompareJobView,
  ResearchCompareJobWarning,
  ResearchJob,
  ResearchVerificationRecord,
} from '@/lib/research/types'

function job(overrides: Partial<ResearchJob> = {}): ResearchJob {
  return {
    job_id: 'job_cmp',
    project_id: 'proj_1',
    job_type: 'deep_compare',
    status: 'completed',
    stage: null,
    progress: 1,
    model_id: 'm-local',
    generation_epoch: 1,
    retry_count: 0,
    last_error: null,
    result_ref: 'job_cmp-report',
    created_at: '2026-11-11T02:00:00Z',
    updated_at: '2026-11-11T02:05:00Z',
    ...overrides,
  }
}

const REPORT = {
  job_id: 'job_cmp',
  status: 'completed',
  report: { ref: 'job_cmp-report', markdown: '# 合成比较报告\n\n结论正文（synthetic）' },
  citations: [
    {
      canonical_citation_id: 'cid-1',
      snapshot: { doc_id: 'doc_a', claim: '合成引用依据', page_idx: 0 },
    },
  ],
}

function compareSegment(overrides: Partial<ResearchCompareJobView> = {}): ResearchCompareJobView {
  return {
    scope: {
      contract_version: 'c05-v1',
      requested_mode: 'all',
      source_ids: [],
      resolved_refs: [
        { document_id: 'doc_a', document_version: 'v1' },
        { document_id: 'doc_b', document_version: 'v2' },
      ],
      resolved_count: 2,
      warnings: [],
    },
    coverage: { included_count: 2, failed_count: 0 },
    model: {
      model_id: 'm-compare-verified',
      provider_id: 'local-sglang',
      execution_revision: 'rev-7',
    },
    result: { ref: 'job_cmp-report' },
    ...overrides,
  }
}

function verification(
  status: ResearchVerificationRecord['status'],
  overrides: Partial<ResearchVerificationRecord> = {},
): ResearchVerificationRecord {
  return {
    schema_version: 1,
    status,
    executor: status === 'not_run' || status === 'not_recorded' ? 'none' : 'compare_verifier',
    deterministic: {
      executed: status === 'pass',
      checks: status === 'pass' ? ['number_support'] : [],
      findings: status === 'degraded' ? [{ check: 'number_support', fixable: true }] : [],
    },
    ...overrides,
  }
}

function detailJob({
  compare,
  record,
}: {
  compare?: ResearchCompareJobView
  record?: ResearchVerificationRecord
}): ResearchJob {
  return job({
    ...(compare === undefined ? {} : { compare }),
    ...(record === undefined ? {} : { verification_record: record }),
  })
}

function axiosError(status: number, code?: string): Error {
  const err = new Error(`Request failed with status code ${status}`) as Error & {
    isAxiosError?: boolean
    response?: { status: number; data: { detail?: { code?: string } } }
  }
  err.isAxiosError = true
  err.response = { status, data: code === undefined ? {} : { detail: { code } } }
  return err
}

function renderView() {
  const onCitationJump = vi.fn()
  return render(<CompareReportView job={job()} onCitationJump={onCitationJump} />)
}

async function openView() {
  fireEvent.click(screen.getByTestId('compare-report-toggle-job_cmp'))
  await waitFor(() => expect(screen.getByTestId('compare-report-readback')).toBeInTheDocument())
}

describe('CompareReportView · #1017 回访展示', () => {
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('completed + pass：声明范围/解析版本/实际模型/校验通过 + 正文与引用', async () => {
    vi.mocked(getCompareReport).mockResolvedValue(REPORT)
    vi.mocked(getJob).mockResolvedValue(
      detailJob({ compare: compareSegment(), record: verification('pass') }),
    )
    renderView()
    await openView()

    expect(getCompareReport).toHaveBeenCalledWith('proj_1', 'job_cmp')
    expect(getJob).toHaveBeenCalledWith('proj_1', 'job_cmp')

    expect(screen.getByTestId('compare-report-scope-mode')).toHaveTextContent(
      'research.compareReportScopeAll',
    )
    expect(screen.getByTestId('compare-report-scope-resolved')).toHaveTextContent(
      'research.compareReportScopeResolved',
    )
    expect(screen.getByTestId('compare-report-coverage')).toHaveTextContent(
      'research.compareReportCoverageCounts',
    )
    expect(screen.getByTestId('compare-report-model-id')).toHaveTextContent('m-compare-verified')
    expect(screen.getByTestId('compare-report-verification-status')).toHaveAttribute(
      'data-status',
      'pass',
    )
    expect(screen.getByTestId('compare-report-verification-status')).toHaveTextContent(
      'research.compareReportVerificationPass',
    )
    expect(screen.getByText(/结论正文/)).toBeInTheDocument()
    expect(screen.getByTestId('research-citations')).toBeInTheDocument()
  })

  it('MEDIUM-1：selected 声明范围展示「来源数」；all 不伪造客户端来源数', async () => {
    vi.mocked(getCompareReport).mockResolvedValue(REPORT)
    vi.mocked(getJob).mockResolvedValue(
      detailJob({
        compare: compareSegment({
          scope: {
            contract_version: 'c05-v1',
            requested_mode: 'selected',
            source_ids: ['src_a', 'src_b', 'src_c'],
            resolved_refs: [
              { document_id: 'doc_a', document_version: 'v1' },
              { document_id: 'doc_b', document_version: 'v1' },
              { document_id: 'doc_c', document_version: 'v1' },
            ],
            resolved_count: 3,
            warnings: [],
          },
        }),
        record: verification('pass'),
      }),
    )
    const first = renderView()
    await openView()
    expect(screen.getByTestId('compare-report-scope-declared-sources')).toHaveTextContent(
      'research.compareReportScopeDeclaredSources',
    )
    expect(screen.getByTestId('compare-report-scope-mode')).toHaveTextContent(
      'research.compareReportScopeSelected',
    )
    first.unmount()

    // all：服务端解析，无客户端来源集合 → 不渲染「声明来源数」
    vi.mocked(getJob).mockResolvedValue(
      detailJob({ compare: compareSegment(), record: verification('pass') }),
    )
    renderView()
    await openView()
    expect(screen.queryByTestId('compare-report-scope-declared-sources')).toBeNull()
  })

  it('LOW-1：warnings 为 host 对象数组时只按数量展示且不渲染 [object Object]', async () => {
    vi.mocked(getCompareReport).mockResolvedValue(REPORT)
    vi.mocked(getJob).mockResolvedValue(
      detailJob({
        compare: compareSegment({
          scope: {
            contract_version: 'c05-v1',
            requested_mode: 'selected',
            source_ids: ['src_a', 'src_b'],
            resolved_refs: [
              { document_id: 'doc_a', document_version: 'v1' },
              { document_id: 'doc_b', document_version: 'v1' },
            ],
            resolved_count: 2,
            warnings: [
              {
                code: 'stale_fallback',
                message: 'synthetic stale fallback warning',
                documents: [
                  { document_id: 'doc_a', used_version: 'v2', skipped_version: 'v1' },
                ],
              },
            ] satisfies ResearchCompareJobWarning[],
          },
        }),
        record: verification('pass'),
      }),
    )
    renderView()
    await openView()
    expect(screen.getByTestId('compare-report-scope-warnings')).toHaveTextContent(
      'research.compareReportScopeWarnings',
    )
    expect(document.body.textContent).not.toContain('[object Object]')
  })

  it('LOW-2：畸形 coverage（缺计数）显示「未记录」而不是伪造 0', async () => {
    vi.mocked(getCompareReport).mockResolvedValue(REPORT)
    vi.mocked(getJob).mockResolvedValue(
      detailJob({
        // 缺 included_count/failed_count（畸形/旧后端）
        compare: compareSegment({ coverage: {} as ResearchCompareJobView['coverage'] }),
        record: verification('pass'),
      }),
    )
    renderView()
    await openView()
    expect(screen.getByTestId('compare-report-coverage-unavailable')).toHaveTextContent(
      'research.compareReportCoverageUnavailable',
    )
    expect(screen.queryByTestId('compare-report-coverage-counts')).toBeNull()
    // 不得出现被凑出来的 0 计数
    expect(screen.getByTestId('compare-report-coverage')).not.toHaveTextContent(
      'research.compareReportCoverageCounts',
    )
  })

  it('degraded：显示降级文案且不冒充通过；缺 compare/verification 键时不崩溃', async () => {
    vi.mocked(getCompareReport).mockResolvedValue(REPORT)
    // 只有校验记录、没有 compare 段（例如 flag 组合/旧后端加性键缺失）
    vi.mocked(getJob).mockResolvedValue(detailJob({ record: verification('degraded') }))
    renderView()
    await openView()

    expect(screen.getByTestId('compare-report-verification-status')).toHaveAttribute(
      'data-status',
      'degraded',
    )
    expect(screen.getByTestId('compare-report-verification-status')).toHaveTextContent(
      'research.compareReportVerificationDegraded',
    )
    expect(screen.queryByText('research.compareReportVerificationPass')).toBeNull()
    expect(screen.getByTestId('compare-report-verification-findings')).toHaveTextContent(
      'research.compareReportVerificationFindings',
    )
    // 缺 compare 段 → 范围按「未记录」展示；模型回退 Job 行自身 model_id
    expect(screen.getByTestId('compare-report-scope-empty')).toHaveTextContent(
      'research.compareReportScopeEmpty',
    )
    expect(screen.getByTestId('compare-report-model-id')).toHaveTextContent('m-local')
  })

  it('partial / unavailable：各自独立文案，均不得显示为通过', async () => {
    vi.mocked(getCompareReport).mockResolvedValue(REPORT)
    vi.mocked(getJob).mockResolvedValue(detailJob({ record: verification('partial') }))
    const first = renderView()
    await openView()
    expect(screen.getByTestId('compare-report-verification-status')).toHaveTextContent(
      'research.compareReportVerificationPartial',
    )
    expect(screen.queryByText('research.compareReportVerificationPass')).toBeNull()
    first.unmount()

    vi.mocked(getJob).mockResolvedValue(detailJob({ record: verification('unavailable') }))
    renderView()
    await openView()
    expect(screen.getByTestId('compare-report-verification-status')).toHaveTextContent(
      'research.compareReportVerificationUnavailable',
    )
    expect(screen.queryByText('research.compareReportVerificationPass')).toBeNull()
  })

  it('not_run（旧 Job 无记录）：显式「未校验」，绝不渲染为通过', async () => {
    vi.mocked(getCompareReport).mockResolvedValue(REPORT)
    vi.mocked(getJob).mockResolvedValue(detailJob({ record: verification('not_run') }))
    renderView()
    await openView()

    expect(screen.getByTestId('compare-report-verification-status')).toHaveAttribute(
      'data-status',
      'not_run',
    )
    expect(screen.getByTestId('compare-report-verification-status')).toHaveTextContent(
      'research.compareReportVerificationNotRun',
    )
    expect(screen.queryByText('research.compareReportVerificationPass')).toBeNull()
  })

  it('not_recorded（非 completed）：显式「未记录」，绝不渲染为通过', async () => {
    vi.mocked(getCompareReport).mockResolvedValue(REPORT)
    vi.mocked(getJob).mockResolvedValue(detailJob({ record: verification('not_recorded') }))
    renderView()
    await openView()

    expect(screen.getByTestId('compare-report-verification-status')).toHaveAttribute(
      'data-status',
      'not_recorded',
    )
    expect(screen.getByTestId('compare-report-verification-status')).toHaveTextContent(
      'research.compareReportVerificationNotRecorded',
    )
    expect(screen.queryByText('research.compareReportVerificationPass')).toBeNull()
  })

  it('未知状态/缺 verification_record：不冒充，也不崩溃', async () => {
    vi.mocked(getCompareReport).mockResolvedValue(REPORT)
    vi.mocked(getJob).mockResolvedValue(detailJob({ record: verification('future_state') }))
    renderView()
    await openView()
    expect(screen.getByTestId('compare-report-verification-status')).toHaveTextContent(
      'research.compareReportVerificationUnknown',
    )
    cleanup()

    // Job 行也没有 model_id（旧 Job/无模型）→ 实际模型按「未记录」展示
    vi.mocked(getJob).mockResolvedValue(job({ model_id: null }))
    renderView()
    await openView()
    expect(screen.getByTestId('compare-report-verification-status')).toHaveAttribute(
      'data-status',
      'missing',
    )
    expect(screen.getByTestId('compare-report-verification-status')).toHaveTextContent(
      'research.compareReportVerificationUnknown',
    )
    expect(screen.getByTestId('compare-report-model-empty')).toHaveTextContent(
      'research.compareReportModelEmpty',
    )
  })

  it('report 410 revoked：受限占位，不渲染正文/引用', async () => {
    vi.mocked(getCompareReport).mockRejectedValue(
      axiosError(410, 'compare_report_sources_revoked'),
    )
    vi.mocked(getJob).mockResolvedValue(detailJob({ compare: compareSegment() }))
    renderView()
    fireEvent.click(screen.getByTestId('compare-report-toggle-job_cmp'))

    const restricted = await screen.findByTestId('compare-report-restricted')
    expect(restricted).toHaveTextContent('research.compareReportRestrictedRevoked')
    expect(restricted).toHaveAttribute('data-code', 'compare_report_sources_revoked')
    expect(screen.queryByTestId('compare-report-content')).toBeNull()
    expect(screen.queryByText(/结论正文/)).toBeNull()
    expect(screen.queryByTestId('research-citations')).toBeNull()
  })

  it('report 410 unverifiable：受限占位使用无法核验文案，不含正文', async () => {
    vi.mocked(getCompareReport).mockRejectedValue(
      axiosError(410, 'compare_report_sources_unverifiable'),
    )
    vi.mocked(getJob).mockResolvedValue(detailJob({}))
    renderView()
    fireEvent.click(screen.getByTestId('compare-report-toggle-job_cmp'))

    const restricted = await screen.findByTestId('compare-report-restricted')
    expect(restricted).toHaveTextContent('research.compareReportRestrictedUnverifiable')
    expect(screen.queryByTestId('compare-report-content')).toBeNull()
  })

  it('410 之后不得展示缓存/旧正文（先成功、关闭、再打开遇 410）', async () => {
    vi.mocked(getCompareReport).mockResolvedValueOnce(REPORT)
    vi.mocked(getJob).mockResolvedValue(detailJob({ record: verification('pass') }))
    renderView()
    await openView()
    expect(screen.getByText(/结论正文/)).toBeInTheDocument()

    // 关闭报告（enabled=false → hook 清空），再次打开时服务端返回 410
    fireEvent.click(screen.getByTestId('compare-report-toggle-job_cmp'))
    await waitFor(() => expect(screen.queryByTestId('compare-report-content')).toBeNull())
    vi.mocked(getCompareReport).mockRejectedValueOnce(
      axiosError(410, 'compare_report_sources_revoked'),
    )
    fireEvent.click(screen.getByTestId('compare-report-toggle-job_cmp'))
    await screen.findByTestId('compare-report-restricted')
    expect(screen.queryByText(/结论正文/)).toBeNull()
    expect(screen.queryByTestId('compare-report-content')).toBeNull()
  })

  it('report 503：可重试；重试成功后渲染正文', async () => {
    vi.mocked(getCompareReport)
      .mockRejectedValueOnce(axiosError(503, 'session_store_unavailable'))
      .mockResolvedValueOnce(REPORT)
    vi.mocked(getJob).mockResolvedValue(detailJob({ record: verification('pass') }))
    renderView()
    fireEvent.click(screen.getByTestId('compare-report-toggle-job_cmp'))

    const retryable = await screen.findByTestId('compare-report-retryable')
    expect(retryable).toHaveTextContent('research.compareReportRetryable')
    expect(screen.queryByTestId('compare-report-content')).toBeNull()

    fireEvent.click(screen.getByTestId('compare-report-retry'))
    await waitFor(() => expect(screen.getByTestId('compare-report-content')).toBeInTheDocument())
    expect(screen.getByText(/结论正文/)).toBeInTheDocument()
    expect(getCompareReport).toHaveBeenCalledTimes(2)
  })

  it('report 409 report_unavailable：保持既有错误文案（回访入口回归）', async () => {
    vi.mocked(getCompareReport).mockRejectedValue(axiosError(409, 'report_unavailable'))
    vi.mocked(getJob).mockResolvedValue(detailJob({}))
    renderView()
    fireEvent.click(screen.getByTestId('compare-report-toggle-job_cmp'))

    await waitFor(() => {
      expect(screen.getByText('research.compareReportError')).toBeInTheDocument()
    })
    expect(screen.queryByTestId('compare-report-restricted')).toBeNull()
    expect(screen.queryByTestId('compare-report-retryable')).toBeNull()
  })

  it('job detail 读取失败：正文仍可读，状态区降级为「详情不可用」提示', async () => {
    vi.mocked(getCompareReport).mockResolvedValue(REPORT)
    vi.mocked(getJob).mockRejectedValue(new Error('detail down'))
    renderView()
    await openView()

    expect(screen.getByTestId('compare-report-detail-error')).toHaveTextContent(
      'research.compareReportDetailError',
    )
    expect(screen.getByTestId('compare-report-scope-empty')).toBeInTheDocument()
    expect(screen.getByText(/结论正文/)).toBeInTheDocument()
  })

  it('未完成/无 result_ref：不渲染入口（既有语义不变）', () => {
    render(
      <CompareReportView
        job={job({ status: 'running', result_ref: null })}
      />,
    )
    expect(screen.queryByTestId('compare-report-toggle-job_cmp')).toBeNull()
  })
})
