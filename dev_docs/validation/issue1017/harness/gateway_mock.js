#!/usr/bin/env node
/**
 * Synthetic Research Gateway route mock for Issue #1017 (D1-H) fork
 * Before/After visual evidence.
 *
 * Route-mocked Gateway over HTTP with permissive CORS so the real fork Next.js
 * app (embedded iframe on another local port) can call it. No database, no
 * model calls, no credentials: every model/source/job/report/citation value is
 * synthetic (`[synthetic]` markers). The only non-synthetic thing in the
 * harness is the fork app code under test.
 *
 * Endpoints that matter for the captured scenes:
 * - GET  .../models                  → c05 capability block; `compare.execution_ready`
 *                                      is driven by the capability mode file
 * - GET  .../sources                 → 3 synthetic ready sources
 * - GET  .../jobs                    → synthetic job list (Activity rendering)
 * - GET  .../jobs/{id}               → completed compare job detail with the
 *                                      additive `compare` segment + top-level
 *                                      `verification_record` (readback scenes)
 * - GET  .../jobs/{id}/report        → report 200 / 410 revoked / 410
 *                                      unverifiable / 503 (report mode file)
 * - POST .../compare/jobs            → **captured** create request (headers +
 *                                      body) so the capture can assert legacy
 *                                      `document_ids`+`v1` vs C05 declared
 *                                      `source_scope`+`c05-v1` on the wire
 *
 * Harness control endpoints (never called by the app):
 * - GET /__reset                     reset counters / created jobs
 * - GET /__stats                     counters + captured create requests
 * - GET /__mode?capability=on|off&report=<mode>
 * - GET /__health                    readiness probe
 *
 * Modes:
 *   capability: off | on
 *   report:     pass | degraded | partial | not_run | revoked | unverifiable
 *               | unavailable503 | plain
 *     plain          → report readable, no readback facts needed (legacy body)
 *     unavailable503 → 503 session_store_unavailable (retryable)
 */
const http = require('node:http')

const PORT = Number(process.argv[2] || 8941)
const PROJECT = 'p1'
const API = `/v1/research/projects/${PROJECT}`

// ── synthetic fixtures ─────────────────────────────────────────────────────
const MODEL = {
  model_id: 'm-local-qwen',
  display_name: 'Local Qwen 27B (synthetic)',
  provider_id: 'local-sglang',
  data_egress: false,
  interactive_context_levels: ['focused', 'document', 'workspace'],
}

const SOURCES = [
  ['src_alpha', 'doc_alpha', 'v1', 'Synthetic D1 cohort report'],
  ['src_beta', 'doc_beta', 'v1', 'Synthetic D1 cohort deck'],
  ['src_gamma', 'doc_gamma', 'v2', 'Synthetic translational memo'],
].map(([sourceId, documentId, version, title]) => ({
  source_id: sourceId,
  document_id: documentId,
  document_version: version,
  status: 'ready',
  content_hash: `synthetic-hash-${documentId}-${version}`,
  synced_at: '2026-11-01T08:00:00+00:00',
  last_error: null,
  title,
}))

const SOURCE_DETAILS = Object.fromEntries(
  SOURCES.map((source) => [
    source.source_id,
    {
      ...source,
      source_type: 'pdf',
      file_available: false,
      markdown_chunks: [
        {
          chunk_id: `chunk_${source.source_id}_0`,
          chunk_ordinal: 0,
          page_idx: 0,
          content_hash: `synthetic-chunk-${source.source_id}`,
          markdown: `[synthetic] ${source.title}: ORR was 42% (21/50).`,
        },
      ],
    },
  ]),
)

const PREFERENCES = {
  project_id: PROJECT,
  default_context_level: 'focused',
  preferred_model_id: MODEL.model_id,
  updated_by: 1,
  updated_at: '2026-11-01T08:00:00+00:00',
}

const CONSENT = {
  consent: null,
  required_scope: {
    policy_version: '1',
    provider_destinations: [],
    data_categories: [],
    scope_hash: 'synthetic-scope-hash',
  },
}

const PREVIEW = {
  source_count: SOURCES.length,
  chunk_count: SOURCES.length,
  note_count: 0,
  token_estimate: 900,
  direct_or_background: 'direct',
  needs_consent: false,
  coverage: {},
  warnings: [],
}

/** Synthetic completed compare job used by the readback scenes. */
const COMPLETED_JOB = {
  job_id: 'job_cmp_1017',
  project_id: PROJECT,
  job_type: 'deep_compare',
  status: 'completed',
  stage: null,
  progress: 1,
  model_id: MODEL.model_id,
  generation_epoch: 1,
  retry_count: 0,
  last_error: null,
  result_ref: 'art_cmp_1017',
  created_at: '2026-11-11T08:00:00+00:00',
  updated_at: '2026-11-11T08:05:00+00:00',
}

const SYNTHETIC_MARKDOWN = [
  '# [synthetic] D1 cohort comparison',
  '',
  '## Agreement',
  '- Both sources report ORR of 42% (21/50) in the synthetic D1 cohort.',
  '',
  '## Conflicts',
  '- None observed in this synthetic fixture.',
  '',
  '## Incomparable conditions',
  '- Synthetic endpoint definitions differ between the report and the deck.',
  '',
  '## Limitations and insufficient evidence',
  '- This is synthetic fixture text used only for UI evidence; it is not a real analysis.',
].join('\n')

const CITATIONS = [
  {
    canonical_citation_id: 'citation_alpha_1',
    snapshot: {
      doc_id: 'doc_alpha',
      document_id: 'doc_alpha',
      document_version: 'v1',
      chunk_id: 'chunk_src_alpha_0',
      claim: '[synthetic] ORR 42% (21/50)',
      page_idx: 0,
    },
  },
]

function capabilityBlock(capabilityMode) {
  const ready = capabilityMode === 'on'
  const entry = (executionReady, modes, executionModes, reason) => ({
    scope_modes: executionReady ? modes : [],
    execution_modes: executionReady ? executionModes : [],
    context_levels: executionReady ? ['workspace', 'focused'] : [],
    preview_supported: false,
    execution_ready: executionReady,
    unavailable_reason: executionReady ? null : reason,
  })
  return {
    contract: 'c05-v1',
    enabled: true,
    preview_supported: false,
    entries: {
      search: entry(false, [], [], 'synthetic_search_not_wired'),
      chat: entry(false, [], [], 'synthetic_chat_not_wired'),
      coverage: entry(false, [], [], 'synthetic_coverage_not_wired'),
      // #1017：能力位唯一驱动 compare 的声明范围派发（off → 既有 legacy）
      compare: ready
        ? entry(true, ['all', 'selected'], ['job'], null)
        : entry(false, [], [], 'synthetic_compare_not_ready'),
      ai_insight: entry(false, [], [], 'synthetic_ai_insight_not_wired'),
      transformation: entry(false, [], [], 'synthetic_transformation_not_wired'),
    },
  }
}

function modelsResponse(capabilityMode) {
  return {
    models: [MODEL],
    capabilities: {
      coverage_all_selected: false,
      local_model: { available: true, reason: null, message: null },
      c05: capabilityBlock(capabilityMode),
    },
  }
}

function reportModeDetail(reportMode) {
  const job = { ...COMPLETED_JOB }
  if (reportMode === 'not_run') {
    return {
      ...job,
      // D1-H 之前的旧 Job：无 compare 段，读回 not_run（不补记）
      verification_record: {
        schema_version: 1,
        status: 'not_run',
        executor: 'none',
        deterministic: { executed: false, checks: [], findings: [] },
        repair: { attempted: false, outcome: 'not_needed', failure_code: null },
      },
    }
  }
  const verificationByMode = {
    pass: {
      status: 'pass',
      deterministic: { executed: true, checks: ['citation_membership', 'version_match', 'number_support'], findings: [] },
    },
    degraded: {
      status: 'degraded',
      deterministic: { executed: true, checks: ['number_support'], findings: [{ check: 'number_support', fixable: true }] },
    },
    partial: {
      status: 'partial',
      deterministic: { executed: false, checks: ['citation_membership'], findings: [] },
    },
    plain: {
      status: 'pass',
      deterministic: { executed: true, checks: ['number_support'], findings: [] },
    },
  }
  const verification =
    verificationByMode[reportMode] ?? verificationByMode.plain
  return {
    ...job,
    compare: {
      scope: {
        contract_version: 'c05-v1',
        requested_mode: 'all',
        source_ids: [],
        resolved_refs: SOURCES.map((source) => ({
          document_id: source.document_id,
          document_version: source.document_version,
        })),
        resolved_count: SOURCES.length,
        warnings: [],
      },
      coverage: { included_count: SOURCES.length, failed_count: 0 },
      model: {
        model_id: MODEL.model_id,
        provider_id: MODEL.provider_id,
        execution_revision: 'rev-synthetic-9',
      },
      result: { ref: COMPLETED_JOB.result_ref },
    },
    verification_record: {
      schema_version: 1,
      executor: 'compare_verifier',
      repair: { attempted: false, outcome: 'not_needed', failure_code: null },
      ...verification,
    },
  }
}

// ── mutable harness state ─────────────────────────────────────────────────
const state = {
  capability: 'off',
  report: 'plain',
  createdJobs: [],
  createRequests: [],
  reportRequests: 0,
  detailRequests: 0,
}

function resetState() {
  state.capability = 'off'
  state.report = 'plain'
  state.createdJobs = []
  state.createRequests = []
  state.reportRequests = 0
  state.detailRequests = 0
}

const nowIso = () => new Date().toISOString()

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'))
      } catch {
        resolve(null)
      }
    })
    req.on('error', () => resolve(null))
  })
}

function corsHeaders() {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
    'access-control-allow-headers': '*',
    'access-control-expose-headers':
      'content-type, content-length, content-disposition, cache-control, x-request-id, x-research-contract',
    'access-control-max-age': '86400',
  }
}

function sendJson(res, body, status = 200, extraHeaders = {}) {
  res.writeHead(status, {
    ...corsHeaders(),
    'content-type': 'application/json; charset=utf-8',
    ...extraHeaders,
  })
  res.end(JSON.stringify(body))
}

const listPage = (items) => ({ items, next_cursor: null })

function jobsList() {
  return listPage([...state.createdJobs, COMPLETED_JOB])
}

function jobDetail(jobId) {
  if (jobId === COMPLETED_JOB.job_id) return reportModeDetail(state.report)
  const created = state.createdJobs.find((job) => job.job_id === jobId)
  return created ?? null
}

function reportPayload() {
  return {
    job_id: COMPLETED_JOB.job_id,
    status: 'completed',
    report: { ref: COMPLETED_JOB.result_ref, markdown: SYNTHETIC_MARKDOWN },
    citations: CITATIONS,
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`)
  const pathname = url.pathname

  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders())
    res.end()
    return
  }

  // ── harness control endpoints ───────────────────────────────────────────
  if (pathname === '/__reset') {
    resetState()
    return sendJson(res, { ok: true })
  }
  if (pathname === '/__health') return sendJson(res, { ok: true })
  if (pathname === '/__mode') {
    const capability = url.searchParams.get('capability')
    if (capability === 'on' || capability === 'off') state.capability = capability
    const report = url.searchParams.get('report')
    if (report !== null) state.report = report
    return sendJson(res, { ok: true, capability: state.capability, report: state.report })
  }
  if (pathname === '/__stats') {
    return sendJson(res, {
      capability: state.capability,
      report: state.report,
      create_requests: state.createRequests,
      report_requests: state.reportRequests,
      detail_requests: state.detailRequests,
      created_job_ids: state.createdJobs.map((job) => job.job_id),
      at: nowIso(),
    })
  }

  // ── create compare job: capture the exact wire request ───────────────────
  if (pathname === `${API}/compare/jobs` && req.method === 'POST') {
    const body = await readBody(req)
    state.createRequests.push({
      method: req.method,
      path: pathname,
      header_x_research_contract: req.headers['x-research-contract'] ?? null,
      header_idempotency_key:
        typeof req.headers['idempotency-key'] === 'string'
          ? req.headers['idempotency-key'].slice(0, 12)
          : null,
      body,
      at: nowIso(),
    })
    const jobId = `job_cmp_new_${state.createRequests.length}`
    state.createdJobs.push({
      job_id: jobId,
      project_id: PROJECT,
      job_type: 'deep_compare',
      status: 'queued',
      stage: null,
      progress: 0,
      model_id: MODEL.model_id,
      generation_epoch: 1,
      retry_count: 0,
      last_error: null,
      result_ref: null,
      created_at: nowIso(),
      updated_at: nowIso(),
    })
    return sendJson(
      res,
      { request_id: `synthetic-request-${state.createRequests.length}`, job_id: jobId, status: 'queued' },
      202,
      { 'x-research-contract': req.headers['x-research-contract'] ?? 'v1' },
    )
  }

  // ── report endpoint (readback scenes) ───────────────────────────────────
  const reportMatch = pathname.match(/\/jobs\/([^/]+)\/report$/)
  if (reportMatch !== null && req.method === 'GET') {
    state.reportRequests += 1
    const reportMode = state.report
    if (reportMode === 'revoked') {
      return sendJson(
        res,
        {
          detail: {
            code: 'compare_report_sources_revoked',
            message:
              'the comparison report is no longer readable because one or more of its sources have been revoked',
            job_id: COMPLETED_JOB.job_id,
            status: 'completed',
          },
        },
        410,
      )
    }
    if (reportMode === 'unverifiable') {
      return sendJson(
        res,
        {
          detail: {
            code: 'compare_report_sources_unverifiable',
            message:
              'the comparison report cannot be read because current access to one or more of its sources could not be verified',
            job_id: COMPLETED_JOB.job_id,
            status: 'completed',
          },
        },
        410,
      )
    }
    if (reportMode === 'unavailable503') {
      return sendJson(
        res,
        {
          detail: {
            code: 'session_store_unavailable',
            message: 'authority rows could not be read (synthetic)',
          },
        },
        503,
      )
    }
    return sendJson(res, reportPayload())
  }

  // ── job detail (compare segment + verification record) ─────────────────
  const jobMatch = pathname.match(/\/jobs\/([^/]+)$/)
  if (jobMatch !== null && req.method === 'GET') {
    state.detailRequests += 1
    const detail = jobDetail(decodeURIComponent(jobMatch[1]))
    if (detail === null) return sendJson(res, { detail: 'Job not found' }, 404)
    return sendJson(res, detail)
  }

  // ── workspace chrome (synthetic, unchanged by #1017) ───────────────────
  if (pathname.endsWith('/models')) return sendJson(res, modelsResponse(state.capability))
  if (pathname.endsWith('/execution-preferences')) return sendJson(res, PREFERENCES)
  if (pathname.endsWith('/external-egress-consent')) return sendJson(res, CONSENT)
  if (pathname.endsWith('/context-preview') || pathname.endsWith('/c05/preview')) {
    return sendJson(res, PREVIEW)
  }
  if (pathname.endsWith('/workspace-status')) {
    return sendJson(res, { enabled: true, contract: 'research-session-v1' })
  }
  const sourceDetail = pathname.match(/\/sources\/([^/]+)$/)
  if (sourceDetail !== null) {
    const detail = SOURCE_DETAILS[decodeURIComponent(sourceDetail[1])]
    if (detail === undefined) return sendJson(res, { detail: 'Source not found' }, 404)
    return sendJson(res, detail)
  }
  if (pathname.endsWith('/sources') && req.method === 'GET') {
    return sendJson(res, listPage(SOURCES))
  }
  if (pathname.endsWith('/jobs') && req.method === 'GET') {
    return sendJson(res, jobsList())
  }
  if (pathname.endsWith('/notes') && req.method === 'GET') {
    return sendJson(res, listPage([]))
  }
  const sessionDetail = pathname.match(/\/chat\/sessions\/([^/]+)$/)
  if (sessionDetail !== null) {
    if (req.method === 'PUT') {
      const body = await readBody(req)
      return sendJson(res, {
        session_ref: null,
        editor_revision: 1,
        editor_state: body && body.editor_state ? body.editor_state : {},
        saved_at: nowIso(),
      })
    }
    return sendJson(res, { detail: 'session not found' }, 404)
  }
  if (pathname.endsWith('/chat/sessions') && req.method === 'GET') {
    return sendJson(res, listPage([]))
  }
  if (
    pathname.endsWith('/insights') ||
    pathname.endsWith('/transformations') ||
    pathname.endsWith('/search-records') ||
    pathname.endsWith('/topic-overview')
  ) {
    return sendJson(res, listPage([]))
  }

  // Unknown route: harmless empty JSON so a synthetic chrome route the app
  // probes optimistically cannot crash the page (recorded in the log).
  console.log(`[gateway-mock] unmatched ${req.method} ${pathname}`)
  return sendJson(res, {})
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`synthetic gateway mock (#1017): http://127.0.0.1:${PORT}`)
})
