import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react'
import { ResearchJobList } from './ResearchJobList'
import type { ResearchCompareReportResponse, ResearchJob } from '@/lib/research/types'

// #307：completed deep_compare Job 的报告查看入口——「查看报告」按钮
// 展开后读取 report 端点并渲染 markdown + citations；未完成不渲染入口。

vi.mock('@/lib/research/api', () => ({
  getCoverageReport: vi.fn(),
  getCompareReport: vi.fn(),
}))

import { getCompareReport } from '@/lib/research/api'

function job(overrides: Partial<ResearchJob> = {}): ResearchJob {
  return {
    job_id: 'job_cmp',
    project_id: 'proj_1',
    job_type: 'deep_compare',
    status: 'running',
    stage: null,
    progress: 0,
    model_id: 'm-local',
    generation_epoch: 1,
    retry_count: 0,
    last_error: null,
    result_ref: null,
    created_at: '2026-09-03T02:00:00Z',
    updated_at: '2026-09-03T02:00:00Z',
    ...overrides,
  }
}

const reportResponse: ResearchCompareReportResponse = {
  job_id: 'job_cmp',
  status: 'completed',
  report: { ref: 'job_cmp-report', markdown: '# 对比报告\n\n结论正文' },
  citations: [
    {
      canonical_citation_id: 'cid-1',
      snapshot: { doc_id: 'd1', claim: '依据', page_idx: 0 },
    },
  ],
}

const onCancel = vi.fn()

describe('ResearchJobList compare report entry（#307）', () => {
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('completed deep_compare：显示「查看报告」，展开后渲染正文 + citations', async () => {
    vi.mocked(getCompareReport).mockResolvedValue(reportResponse)
    render(
      <ResearchJobList
        jobs={[job({ status: 'completed', result_ref: 'job_cmp-report' })]}
        isCreating={false}
        onCancel={onCancel}
      />,
    )
    const toggle = screen.getByTestId('compare-report-toggle-job_cmp')
    expect(toggle).toBeTruthy()
    // 未展开前不拉取
    expect(getCompareReport).not.toHaveBeenCalled()
    fireEvent.click(toggle)
    await waitFor(() => {
      expect(screen.getByTestId('compare-report-content')).toBeTruthy()
    })
    expect(screen.getByText(/结论正文/)).toBeTruthy()
    expect(getCompareReport).toHaveBeenCalledWith('proj_1', 'job_cmp')
    expect(screen.getByTestId('research-citations')).toBeTruthy()
  })

  it('未完成 / 无 result_ref：不渲染查看入口', () => {
    render(
      <ResearchJobList
        jobs={[job({ status: 'running' })]}
        isCreating={false}
        onCancel={onCancel}
      />,
    )
    expect(screen.queryByTestId('compare-report-toggle-job_cmp')).toBeNull()
  })

  it('report 端点失败（409 report_unavailable）→ 错误文案呈现', async () => {
    vi.mocked(getCompareReport).mockRejectedValue(new Error('report_unavailable'))
    render(
      <ResearchJobList
        jobs={[job({ status: 'completed', result_ref: 'job_cmp-report' })]}
        isCreating={false}
        onCancel={onCancel}
      />,
    )
    fireEvent.click(screen.getByTestId('compare-report-toggle-job_cmp'))
    await waitFor(() => {
      expect(screen.getByText('research.compareReportError')).toBeTruthy()
    })
  })

  it('非 deep_compare 的 completed Job 仍显示 result_ref 文本', () => {
    render(
      <ResearchJobList
        jobs={[job({ job_type: 'research', status: 'completed', result_ref: 'ref-1' })]}
        isCreating={false}
        onCancel={onCancel}
      />,
    )
    expect(screen.queryByTestId('compare-report-toggle-job_cmp')).toBeNull()
    expect(screen.getByText(/ref-1/)).toBeTruthy()
  })
})
