import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { ResearchJobList } from './ResearchJobList'
import type { ResearchJob } from '@/lib/research/types'

// COV-09：Jobs 页 Coverage 段——research_coverage Job 展示逐文档状态/
// verification/outcome_unknown 重试/固定 snapshot（§12.3）；普通 Job 不变。

vi.mock('@/lib/research/api', () => ({
  getCoverageReport: vi.fn(),
}))

function job(overrides: Partial<ResearchJob> = {}): ResearchJob {
  return {
    job_id: 'job_1',
    project_id: 'proj_1',
    job_type: 'deep_compare',
    status: 'running',
    stage: 'retrieval',
    progress: 0.3,
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

const onCancel = vi.fn()
const onRetry = vi.fn(async () => true)

describe('ResearchJobList coverage section（COV-09）', () => {
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('research_coverage Job：渲染 CoverageJobDetails（逐文档状态/固定 snapshot）', () => {
    const coverageJob = job({
      job_id: 'job_cov',
      job_type: 'research_coverage',
      coverage: {
        synthesis_scope: 'all_selected',
        contract_version: 'v1',
        execution_plan_version: 'v2',
        prompt_bundle_version: 'v1',
        generation_id: 'gen_1',
        manifest: { entries: [{ source_id: 'src-1', document_id: 'doc-1', document_revision: 'v1' }] },
        target_results: [
          { target_kind: 'source', document_id: 'doc-1', document_revision: 'v1', status: 'failed', failure_code: 'document_unit_terminal' },
        ],
        target_coverage: { requested: 1, analyzed: 0, failed: 1, status: 'failed' },
        verification_status: 'degraded',
      },
    })
    render(
      <ResearchJobList
        jobs={[coverageJob]}
        isCreating={false}
        onCancel={onCancel}
        onCoverageRetry={onRetry}
      />,
    )
    expect(screen.getByTestId('coverage-job-details')).toBeInTheDocument()
    expect(screen.getByTestId('coverage-target-coverage')).toHaveTextContent('requested: 1')
    expect(screen.getByTestId('coverage-target-doc-1')).toHaveTextContent('document_unit_terminal')
    expect(screen.getByTestId('coverage-manifest')).toHaveTextContent('revision: v1')
    expect(screen.getByTestId('coverage-verification')).toBeInTheDocument()
  })

  it('普通 deep_compare Job：不渲染 coverage 段', () => {
    render(
      <ResearchJobList
        jobs={[job()]}
        isCreating={false}
        onCancel={onCancel}
        onCoverageRetry={onRetry}
      />,
    )
    expect(screen.queryByTestId('coverage-job-details')).not.toBeInTheDocument()
  })
})
