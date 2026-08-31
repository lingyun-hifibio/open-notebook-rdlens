import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { CoverageJobDetails } from './CoverageJobDetails'
import { getCoverageReport } from '@/lib/research/api'
import type { ResearchJob } from '@/lib/research/types'

// COV-09：Coverage Job 详情（§12.3）——stage/progress、requested/
// analyzed/failed、逐文档状态、verification_status、outcome_unknown
// 人工重试（§12.2）、固定 revision snapshot、最终报告与 Citation。

vi.mock('@/lib/research/api', () => ({
  getCoverageReport: vi.fn(),
}))

function job(overrides: Partial<ResearchJob> = {}): ResearchJob {
  return {
    job_id: 'job_cov',
    project_id: 'proj_1',
    job_type: 'research_coverage',
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
    ...overrides,
  }
}

function coverageJob(overrides: Partial<ResearchJob> = {}): ResearchJob {
  return job({
    status: 'running',
    stage: 'per_doc_analysis',
    progress: 0.5,
    coverage: {
      synthesis_scope: 'all_selected',
      contract_version: 'v1',
      execution_plan_version: 'v2',
      prompt_bundle_version: 'v1',
      generation_id: 'gen_1',
      stages: [
        { name: 'validate_manifest', status: 'completed' },
        { name: 'retrieval', status: 'completed' },
        { name: 'per_doc_analysis', status: 'running' },
      ],
      manifest: {
        entries: [
          { source_id: 'src-1', document_id: 'doc-1', document_revision: 'v1' },
          { source_id: 'src-2', document_id: 'doc-2', document_revision: 'v1' },
        ],
      },
      target_results: [
        { target_kind: 'source', document_id: 'doc-1', document_revision: 'v1', status: 'analyzed', failure_code: null },
        { target_kind: 'source', document_id: 'doc-2', document_revision: 'v1', status: 'failed', failure_code: 'document_unit_terminal' },
      ],
      target_coverage: { requested: 2, analyzed: 1, failed: 1, status: 'partial' },
      verification_status: 'critic_issues',
      critic_issues: [{ code: 'unsupported_claim' }],
    },
    ...overrides,
  })
}

const onRetry = vi.fn(async () => true)

describe('CoverageJobDetails', () => {
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('job 未回源（undefined）→ 同步中占位', () => {
    render(<CoverageJobDetails job={undefined} onRetry={onRetry} />)
    expect(screen.getByTestId('coverage-syncing')).toBeInTheDocument()
  })

  it('排队中：状态/stage 展示，无 target_results 时不渲染计数段', () => {
    render(<CoverageJobDetails job={job({ coverage: { synthesis_scope: 'all_selected', contract_version: 'v1', execution_plan_version: 'v2', prompt_bundle_version: 'v1', generation_id: 'gen_1' } })} onRetry={onRetry} />)
    expect(screen.getByTestId('coverage-status')).toHaveTextContent('queued')
    expect(screen.queryByTestId('coverage-target-coverage')).not.toBeInTheDocument()
  })

  it('运行中：stage/progress、requested/analyzed/failed、逐文档状态、verification、固定 snapshot', () => {
    render(<CoverageJobDetails job={coverageJob()} onRetry={onRetry} />)
    expect(screen.getByTestId('coverage-stage')).toHaveTextContent('per_doc_analysis')
    expect(screen.getByTestId('coverage-progress')).toBeInTheDocument()
    // 计数（文字表达，不只颜色）
    expect(screen.getByTestId('coverage-target-coverage')).toHaveTextContent('requested: 2')
    expect(screen.getByTestId('coverage-target-coverage')).toHaveTextContent('analyzed: 1')
    expect(screen.getByTestId('coverage-target-coverage')).toHaveTextContent('failed: 1')
    // 逐文档状态 + 失败原因码
    const doc2 = screen.getByTestId('coverage-target-doc-2')
    expect(doc2).toHaveTextContent('document_unit_terminal')
    // verification_status 文字
    expect(screen.getByTestId('coverage-verification')).toHaveTextContent(/critic_issues|Critic/i)
    // 固定 snapshot：提交时 revision
    const manifest = screen.getByTestId('coverage-manifest')
    expect(manifest).toHaveTextContent('src-1')
    expect(manifest).toHaveTextContent('revision: v1')
  })

  it('outcome_unknown：人工提示 + 确认计费风险后才重试', async () => {
    const unknownJob = coverageJob({
      status: 'failed',
      coverage: {
        ...coverageJob().coverage!,
        generation: { generation_id: 'gen_1', state: 'outcome_unknown', failure_code: null },
      },
    })
    render(<CoverageJobDetails job={unknownJob} onRetry={onRetry} />)
    expect(screen.getByTestId('coverage-outcome-unknown')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('coverage-retry-trigger'))
    expect(await screen.findByTestId('coverage-retry-description')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('coverage-retry-confirm'))
    expect(onRetry).toHaveBeenCalledWith('job_cov')
  })

  it('确定性 failed（非 outcome_unknown）：无重试入口', () => {
    const failedJob = coverageJob({
      status: 'failed',
      coverage: {
        ...coverageJob().coverage!,
        generation: { generation_id: 'gen_1', state: 'failed', failure_code: 'quota_exceeded' },
      },
    })
    render(<CoverageJobDetails job={failedJob} onRetry={onRetry} />)
    expect(screen.queryByTestId('coverage-retry-trigger')).not.toBeInTheDocument()
  })

  it('completed + report_ref：读取最终报告并渲染 markdown 与 Citation', async () => {
    vi.mocked(getCoverageReport).mockResolvedValue({
      job_id: 'job_cov',
      generation_id: 'gen_1',
      status: 'completed',
      verification_status: 'critic_issues',
      report: { ref: 'job_cov-covreport', markdown: '# Coverage Report\n\n结论正文' },
      citations: [
        {
          canonical_citation_id: 'cid-1',
          snapshot: {
            citation_id: 1, claim: '结论引用', doc_id: 'doc-1', doc_version: 'v1',
            page_idx: 0, original_text: '原文', citation_type: 'direct', confidence: 'high',
          },
        },
      ],
      target_coverage: { requested: 2, analyzed: 1, failed: 1, status: 'partial' },
      manifest: { entries: [{ source_id: 'src-1', document_id: 'doc-1', document_revision: 'v1' }] },
    })
    const completed = coverageJob({
      status: 'completed',
      progress: 1,
      coverage: { ...coverageJob().coverage!, report_ref: 'job_cov-covreport' },
    })
    render(<CoverageJobDetails job={completed} onRetry={onRetry} />)
    expect(await screen.findByText('结论正文')).toBeInTheDocument()
    expect(screen.getByText('结论引用')).toBeInTheDocument()
    expect(getCoverageReport).toHaveBeenCalledWith('proj_1', 'job_cov')
  })
})
