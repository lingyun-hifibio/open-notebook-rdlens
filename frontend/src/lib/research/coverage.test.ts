import { describe, expect, it } from 'vitest'
import {
  coverageVerificationStatus,
  isCoverageOutcomeUnknown,
  isCoverageReportAvailable,
  targetCoverageCounts,
} from './coverage'
import type { ResearchCoverageJobView, ResearchJob } from './types'

// COV-09：Coverage 状态纯函数（契约 §6.3/§6.4/§12.2）——outcome_unknown
// 的稳定表达、报告可读门禁、target_coverage 计数与 verification_status。

function job(overrides: Partial<ResearchJob> = {}): ResearchJob {
  return {
    job_id: 'job_1',
    project_id: 'proj_1',
    job_type: 'research_coverage',
    status: 'queued',
    stage: null,
    progress: 0,
    model_id: null,
    generation_epoch: 1,
    retry_count: 0,
    last_error: null,
    result_ref: null,
    created_at: '2026-08-06T02:00:00Z',
    updated_at: '2026-08-06T02:00:00Z',
    ...overrides,
  }
}

function coverage(overrides: Partial<ResearchCoverageJobView> = {}): ResearchCoverageJobView {
  return {
    synthesis_scope: 'all_selected',
    contract_version: 'v1',
    execution_plan_version: 'v2',
    prompt_bundle_version: 'v1',
    generation_id: 'gen_1',
    ...overrides,
  }
}

describe('isCoverageOutcomeUnknown', () => {
  it('Job failed + Generation outcome_unknown → true（需人工重试）', () => {
    const j = job({
      status: 'failed',
      coverage: coverage({ generation: { generation_id: 'gen_1', state: 'outcome_unknown', failure_code: null } }),
    })
    expect(isCoverageOutcomeUnknown(j)).toBe(true)
  })

  it('确定性 failed（非 outcome_unknown）→ false', () => {
    const j = job({
      status: 'failed',
      coverage: coverage({ generation: { generation_id: 'gen_1', state: 'failed', failure_code: 'quota_exceeded' } }),
    })
    expect(isCoverageOutcomeUnknown(j)).toBe(false)
  })

  it('queued/running → false', () => {
    const j = job({ status: 'running', coverage: coverage() })
    expect(isCoverageOutcomeUnknown(j)).toBe(false)
  })

  it('无 coverage 段 → false（非 Coverage Job 防御）', () => {
    expect(isCoverageOutcomeUnknown(job({ status: 'failed' }))).toBe(false)
  })
})

describe('isCoverageReportAvailable', () => {
  it('completed + report_ref → true', () => {
    const j = job({ status: 'completed', coverage: coverage({ report_ref: 'job_1-covreport' }) })
    expect(isCoverageReportAvailable(j)).toBe(true)
  })

  it('completed 但无 report_ref → false（render 未完成）', () => {
    expect(isCoverageReportAvailable(job({ status: 'completed', coverage: coverage() }))).toBe(false)
  })

  it('running 有 report_ref → false', () => {
    const j = job({ status: 'running', coverage: coverage({ report_ref: 'job_1-covreport' }) })
    expect(isCoverageReportAvailable(j)).toBe(false)
  })
})

describe('targetCoverageCounts', () => {
  it('优先使用服务端 target_coverage（完整/partial/failed 映射）', () => {
    const j = job({
      coverage: coverage({
        target_coverage: { requested: 5, analyzed: 4, failed: 1, status: 'partial' },
      }),
    })
    expect(targetCoverageCounts(j)).toEqual({ requested: 5, analyzed: 4, failed: 1, status: 'partial' })
  })

  it('无 target_coverage 时从 target_results 推导（analyzed+failed=requested）', () => {
    const j = job({
      coverage: coverage({
        target_results: [
          { target_kind: 'source', document_id: 'doc-1', document_revision: 'v1', status: 'analyzed', failure_code: null },
          { target_kind: 'source', document_id: 'doc-2', document_revision: 'v1', status: 'failed', failure_code: 'document_unit_terminal' },
        ],
      }),
    })
    expect(targetCoverageCounts(j)).toEqual({ requested: 2, analyzed: 1, failed: 1, status: 'partial' })
  })

  it('全部 analyzed → complete；全部 failed → failed', () => {
    const all = job({
      coverage: coverage({
        target_results: [
          { target_kind: 'source', document_id: 'doc-1', document_revision: 'v1', status: 'analyzed', failure_code: null },
        ],
      }),
    })
    expect(targetCoverageCounts(all)!.status).toBe('complete')
    const none = job({
      coverage: coverage({
        target_results: [
          { target_kind: 'source', document_id: 'doc-1', document_revision: 'v1', status: 'failed', failure_code: 'document_unit_terminal' },
        ],
      }),
    })
    expect(targetCoverageCounts(none)!.status).toBe('failed')
  })

  it('无任何数据 → null（不猜测）', () => {
    expect(targetCoverageCounts(job({ coverage: coverage() }))).toBeNull()
  })
})

describe('coverageVerificationStatus', () => {
  it('三态透传', () => {
    expect(coverageVerificationStatus(coverage({ verification_status: 'verified' }))).toBe('verified')
    expect(coverageVerificationStatus(coverage({ verification_status: 'critic_issues' }))).toBe('critic_issues')
    expect(coverageVerificationStatus(coverage({ verification_status: 'degraded' }))).toBe('degraded')
  })

  it('未校验 → null', () => {
    expect(coverageVerificationStatus(coverage())).toBeNull()
  })
})
