#!/usr/bin/env node
/**
 * Before/After visual + browser-behaviour capture for Issue #1017 (D1-H
 * 多来源→基础比较与回访, fork `ComparePanel` / `CompareReportView` half).
 *
 * Synthetic harness only: real fork Next.js app (`next dev --webpack`) in
 * embedded mode inside a synthetic host iframe + route-mocked Research
 * Gateway (gateway_mock.js). No real RDLens host, database, PG, model calls,
 * files, credentials or private data; every model/source/job/report/citation
 * is synthetic (`[synthetic]` markers, synthetic project p1, viewer 1).
 *
 * Surface: legacy regression entry `/research?legacy=1` (documented dev/regress
 * entry, no new route) — `ComparePanel` main action tab + Header Activity
 * dialog. Both sides (BEFORE = fork origin/main, AFTER = implementation head)
 * use the same entry, fixtures, viewports and theme.
 *
 * Scenes (each at every requested width, fresh browser context per scene,
 * gateway reset + mode per scene):
 *   cap_off_all       capability=false, scope=all        (legacy fallback)
 *   cap_off_selected  capability=false, 2 sources selected (legacy mapping)
 *   cap_on_all        capability=true,  scope=all         (C05 declared scope)
 *   cap_on_selected   capability=true,  2 sources selected (C05 source ids)
 *   report_pass       Activity → View report, verification pass
 *   report_degraded   Activity → View report, degraded (not pass)
 *   report_partial    Activity → View report, partial (not pass)
 *   report_not_run    Activity → View report, legacy job not_run (not pass)
 *   report_410_revoked report endpoint 410 revoked → restricted placeholder
 *   report_503        report endpoint 503 → retryable + retry succeeds
 *
 * BEFORE = fork origin/main d959635; AFTER = Lead-provided head SHA.
 *
 * Usage:
 *   node capture.js --phase=before --host=http://127.0.0.1:8972/ --head=<sha>
 *   node capture.js --phase=after  --host=http://127.0.0.1:8974/ --head=<sha>
 */
const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')
const crypto = require('node:crypto')
const { chromium } = require('/home/lchen/workspace/RDLens/scripts/e2e/node_modules/playwright-core')

const CHROME = '/home/lchen/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome'
const EVIDENCE_ROOT = path.resolve(__dirname, '..')
const GATEWAY = process.env.ISSUE1017_GATEWAY || 'http://127.0.0.1:8941'
const COMPLETED_JOB_ID = 'job_cmp_1017'

const arg = (name, fallback) => {
  const hit = process.argv.find((item) => item.startsWith(`--${name}=`))
  return hit ? hit.split('=').slice(1).join('=') : fallback
}
const PHASE = arg('phase', 'before')
const PREFIX = PHASE === 'after' ? 'after' : 'before'
const IS_BEFORE = PREFIX === 'before'
const HOST = arg('host', PHASE === 'after' ? 'http://127.0.0.1:8974/' : 'http://127.0.0.1:8972/')
const HEAD = arg('head', 'unset')
const WIDTHS = (arg('widths', '1440,1024') || '')
  .split(',')
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isFinite(value) && value > 0)
const ONLY_SCENES = (arg('scenes', '') || '').split(',').filter(Boolean)
const OUT_DIR = path.resolve(arg('outdir', path.join(EVIDENCE_ROOT, 'screenshots', PHASE)))
const LOG_FILE = path.resolve(arg('logfile', path.join(EVIDENCE_ROOT, 'capture.log')))
const MANIFEST_FILE = path.resolve(
  arg('manifest', path.join(EVIDENCE_ROOT, `${PHASE}-manifest.json`)),
)
fs.mkdirSync(OUT_DIR, { recursive: true })
fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true })

const HEIGHTS = { 1440: 900, 1024: 768 }
const heightFor = (width) => HEIGHTS[width] || Math.round((width * 900) / 1440)

const shots = []
const sceneResults = []

function log(line) {
  const text = `${new Date().toISOString()} ${line}`
  console.log(text)
  fs.appendFileSync(LOG_FILE, `${text}\n`)
}
function banner(line) {
  const text = `===== ${line} =====`
  console.log(text)
  fs.appendFileSync(LOG_FILE, `${text}\n`)
}
const sha256File = (file) =>
  crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')

// ── harness control (gateway mock control endpoints) ──────────────────────
function gatewayCall(method, urlPath) {
  return new Promise((resolve, reject) => {
    const request = http.request(`${GATEWAY}${urlPath}`, { method }, (response) => {
      const chunks = []
      response.on('data', (chunk) => chunks.push(chunk))
      response.on('end', () => {
        try {
          resolve({
            status: response.statusCode,
            body: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'),
          })
        } catch {
          resolve({ status: response.statusCode, body: null })
        }
      })
    })
    request.on('error', reject)
    request.end()
  })
}

async function gatewayStats() {
  return (await gatewayCall('GET', '/__stats')).body || {}
}

async function resetHarness({ capability, report }) {
  await gatewayCall('GET', '/__reset')
  await gatewayCall(
    'GET',
    `/__mode?capability=${encodeURIComponent(capability)}&report=${encodeURIComponent(report)}`,
  )
  log(`${PREFIX} harness reset: capability=${capability} report=${report}`)
}

async function setReportMode(report) {
  await gatewayCall('GET', `/__mode?report=${encodeURIComponent(report)}`)
  log(`${PREFIX} harness report mode -> ${report}`)
}

// ── DOM hooks ─────────────────────────────────────────────────────────────
const HOOKS = {
  tabCompare: { role: 'tab', name: 'Compare' },
  compareCreate: '[data-testid="compare-create"]',
  compareEntireProject: '[data-testid="compare-entire-project"]',
  compareEmpty: '[data-testid="compare-empty"]',
  compareDeclaredAll: '[data-testid="compare-declared-all"]',
  compareSubmitted: '[data-testid="compare-submitted"]',
  activityTrigger: '[data-testid="activity-trigger"]',
  activityDialog: '[data-testid="activity-dialog"]',
  jobCard: `[data-testid="job-${COMPLETED_JOB_ID}"]`,
  reportToggle: `[data-testid="compare-report-toggle-${COMPLETED_JOB_ID}"]`,
  reportContent: '[data-testid="compare-report-content"]',
  reportReadback: '[data-testid="compare-report-readback"]',
  reportScope: '[data-testid="compare-report-scope"]',
  reportScopeEmpty: '[data-testid="compare-report-scope-empty"]',
  reportScopeResolved: '[data-testid="compare-report-scope-resolved"]',
  reportModel: '[data-testid="compare-report-model"]',
  reportModelId: '[data-testid="compare-report-model-id"]',
  reportVerification: '[data-testid="compare-report-verification"]',
  reportVerificationStatus: '[data-testid="compare-report-verification-status"]',
  reportRestricted: '[data-testid="compare-report-restricted"]',
  reportRetryable: '[data-testid="compare-report-retryable"]',
  reportRetryButton: '[data-testid="compare-report-retry"]',
  reportError: '[data-testid="compare-report"] p.text-destructive',
  markdown: '.prose',
  sourceScope: (sourceId) => `[data-testid="source-scope-${sourceId}"]`,
}

async function count(app, selector) {
  return app.locator(selector).count().catch(() => 0)
}
async function waitFor(fn, timeoutMs, intervalMs = 300) {
  const start = Date.now()
  for (;;) {
    const value = await Promise.resolve()
      .then(() => fn())
      .catch(() => false)
    if (value) return value
    if (Date.now() - start > timeoutMs) return null
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
}
async function bodyText(app) {
  return app
    .evaluate(() => (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 4000))
    .catch(() => '')
}
async function collectState(boot) {
  const { app } = boot
  const statusNode = await app
    .evaluate(() => {
      const node = document.querySelector(
        '[data-testid="compare-report-verification-status"]',
      )
      return node
        ? {
            status: node.getAttribute('data-status'),
            text: (node.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 200),
          }
        : null
    })
    .catch(() => null)
  const createDisabled = await app
    .evaluate(() => {
      const node = document.querySelector('[data-testid="compare-create"]')
      return node ? node.disabled === true || node.getAttribute('aria-disabled') === 'true' : null
    })
    .catch(() => null)
  return {
    url: app.url(),
    createDisabled,
    counts: {
      compare_create: await count(app, HOOKS.compareCreate),
      compare_entire_project: await count(app, HOOKS.compareEntireProject),
      compare_empty: await count(app, HOOKS.compareEmpty),
      compare_declared_all: await count(app, HOOKS.compareDeclaredAll),
      compare_submitted: await count(app, HOOKS.compareSubmitted),
      activity_dialog: await count(app, HOOKS.activityDialog),
      report_toggle: await count(app, HOOKS.reportToggle),
      report_content: await count(app, HOOKS.reportContent),
      report_readback: await count(app, HOOKS.reportReadback),
      report_scope: await count(app, HOOKS.reportScope),
      report_scope_empty: await count(app, HOOKS.reportScopeEmpty),
      report_scope_resolved: await count(app, HOOKS.reportScopeResolved),
      report_model: await count(app, HOOKS.reportModel),
      report_verification: await count(app, HOOKS.reportVerification),
      report_restricted: await count(app, HOOKS.reportRestricted),
      report_retryable: await count(app, HOOKS.reportRetryable),
      report_retry_button: await count(app, HOOKS.reportRetryButton),
      markdown_blocks: await count(app, HOOKS.markdown),
    },
    verification: statusNode,
    bodyText: await bodyText(app),
  }
}
const hasText = (state, needle) =>
  typeof state.bodyText === 'string' && state.bodyText.includes(needle)

async function shot(boot, name) {
  const file = path.join(OUT_DIR, `${name}.png`)
  await boot.page.screenshot({ path: file, animations: 'disabled' })
  const size = fs.statSync(file).size
  const digest = sha256File(file)
  const state = await collectState(boot)
  const stats = await gatewayStats()
  shots.push({
    file: path.basename(file),
    scene: name.replace(`${PREFIX}_`, '').replace(/_\d+$/, ''),
    width: boot.width,
    height: boot.height,
    phase: PREFIX,
    head: HEAD,
    bytes: size,
    sha256: digest,
    dom_counts: state.counts,
    create_disabled: state.createDisabled,
    verification: state.verification,
    gateway_stats: {
      capability: stats.capability,
      report: stats.report,
      create_requests: (stats.create_requests || []).length,
      report_requests: stats.report_requests,
    },
  })
  log(`SHOT ${path.basename(file)} (${size} bytes, sha256=${digest.slice(0, 16)}…)`)
  log(`SHOT-DOM ${path.basename(file)} ${JSON.stringify(state.counts)}`)
  return { file, state }
}

// ── browser boot / app helpers ────────────────────────────────────────────
const DEV_OVERLAY_CSS =
  'nextjs-portal,[data-nextjs-toast],[data-nextjs-dev-tools-button]{display:none!important;visibility:hidden!important}'

async function findAppFrame(page, timeoutMs = 60000) {
  return waitFor(() => {
    const app = page.frames().find((candidate) => candidate.url().includes('/research'))
    return app || false
  }, timeoutMs, 400)
}

async function bootApp(browser, width, height) {
  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: 1,
    colorScheme: 'light',
    locale: 'en-US',
    extraHTTPHeaders: { 'accept-language': 'en-US,en;q=0.9' },
  })
  const page = await context.newPage()
  const errors = []
  // Intentional synthetic failure modes (410/503 of the report endpoint) show
  // up as Chromium resource errors; record them separately from app errors.
  const expectedHttpErrors = []
  const EXPECTED_HTTP_STATUS =
    /Failed to load resource: the server responded with a status of (410|503)/
  page.on('pageerror', (error) => errors.push(`[pageerror] ${error.message.slice(0, 300)}`))
  page.on('console', (message) => {
    if (message.type() !== 'error') return
    const text = message.text().slice(0, 300)
    if (EXPECTED_HTTP_STATUS.test(text)) {
      expectedHttpErrors.push(text)
      return
    }
    errors.push(`[console:error] ${text}`)
  })
  await page.addInitScript(() => {
    try {
      window.__e2eHideDevOverlay = true
      window.localStorage.setItem('i18nextLng', 'en-US')
    } catch {
      /* ignore */
    }
  })
  await page.goto(HOST, { waitUntil: 'domcontentloaded' })
  const app = await findAppFrame(page)
  if (!app) throw new Error('app iframe frame not found')
  const ready = await waitFor(
    async () => (await count(app, HOOKS.activityTrigger)) > 0,
    60000,
    400,
  )
  if (!ready) throw new Error('legacy research shell did not become ready inside the iframe')
  await page.waitForTimeout(1200)
  for (const target of [page, app]) {
    await target
      .evaluate((css) => {
        const style = document.createElement('style')
        style.textContent = css
        document.head.appendChild(style)
      }, DEV_OVERLAY_CSS)
      .catch(() => {})
  }
  log(`${PREFIX} boot width=${width} host=${HOST} frame=${app.url()}`)
  return { context, page, app, errors, expectedHttpErrors, width, height }
}

async function openCompareTab(app) {
  const tab = app.getByRole('tab', { name: 'Compare', exact: true })
  await tab.waitFor({ timeout: 30000 })
  await tab.click({ timeout: 15000 })
  await app.page().waitForTimeout(900)
  const ready = await waitFor(
    async () =>
      (await count(app, HOOKS.compareCreate)) > 0 ||
      (await count(app, '[data-testid="compare-resources-error"]')) > 0,
    20000,
    300,
  )
  if (!ready) throw new Error('Compare panel did not render after switching tab')
}

async function toggleSourceForCompare(app, sourceId) {
  const selector = HOOKS.sourceScope(sourceId)
  const locator = app.locator(selector).first()
  if ((await locator.count().catch(() => 0)) === 0) {
    throw new Error(`source scope checkbox not found: ${sourceId}`)
  }
  await locator.click({ timeout: 10000 })
  await app.page().waitForTimeout(450)
}

async function selectTwoSources(app) {
  await toggleSourceForCompare(app, 'src_alpha')
  await toggleSourceForCompare(app, 'src_beta')
}

async function clickCompareCreate(app) {
  await app.locator(HOOKS.compareCreate).click({ timeout: 10000 })
  await app.page().waitForTimeout(1200)
}

async function waitForCreateRequest(timeoutMs = 15000) {
  return waitFor(async () => {
    const stats = await gatewayStats()
    return (stats.create_requests || []).length > 0 ? stats : false
  }, timeoutMs, 300)
}

async function openActivityReport(app) {
  await app.locator(HOOKS.activityTrigger).click({ timeout: 15000 })
  const dialog = await waitFor(async () => (await count(app, HOOKS.activityDialog)) > 0, 20000, 300)
  if (!dialog) throw new Error('activity dialog did not open')
  await app.page().waitForTimeout(1200)
  const toggle = await waitFor(
    async () => (await count(app, HOOKS.reportToggle)) > 0,
    20000,
    300,
  )
  if (!toggle) throw new Error('compare report toggle not rendered in activity dialog')
  await app.locator(HOOKS.reportToggle).click({ timeout: 10000 })
  await app.page().waitForTimeout(1600)
}

// ── assertion bookkeeping ─────────────────────────────────────────────────
function makeAssert(scene) {
  const items = []
  const check = (name, ok, expected, actual) => {
    items.push({ name, ok: Boolean(ok), expected, actual })
    log(
      `${PREFIX} ${scene} ASSERT ${ok ? 'PASS' : 'FAIL'} ${name} expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`,
    )
    return Boolean(ok)
  }
  return { items, check }
}

// ── scenes ────────────────────────────────────────────────────────────────
async function sceneCapabilityOffAll(browser, width, height) {
  const scene = 'cap_off_all'
  const { items, check } = makeAssert(scene)
  await resetHarness({ capability: 'off', report: 'plain' })
  const boot = await bootApp(browser, width, height)
  await openCompareTab(boot.app)
  const { state } = await shot(boot, `${PREFIX}_${scene}_${width}`)
  check('all_blocked_legacy', state.counts.compare_entire_project > 0, '>0', state.counts.compare_entire_project)
  check('create_disabled_legacy', state.createDisabled === true, true, state.createDisabled)
  const stats = await gatewayStats()
  check('no_create_request', (stats.create_requests || []).length === 0, 0, (stats.create_requests || []).length)
  await boot.context.close()
  return { scene, items }
}

async function sceneCapabilityOffSelected(browser, width, height) {
  const scene = 'cap_off_selected'
  const { items, check } = makeAssert(scene)
  await resetHarness({ capability: 'off', report: 'plain' })
  const boot = await bootApp(browser, width, height)
  await selectTwoSources(boot.app)
  await openCompareTab(boot.app)
  check('create_enabled_selected', (await count(boot.app, HOOKS.compareCreate)) > 0, true, true)
  await clickCompareCreate(boot.app)
  const stats = await waitForCreateRequest()
  check('create_request_captured', Boolean(stats), true, Boolean(stats))
  const request = stats ? stats.create_requests[0] : null
  check('legacy_header_v1', request?.header_x_research_contract === 'v1', 'v1', request?.header_x_research_contract ?? null)
  check(
    'legacy_body_document_ids',
    JSON.stringify(request?.body?.document_ids) === JSON.stringify(['doc_alpha', 'doc_beta']),
    ['doc_alpha', 'doc_beta'],
    request?.body?.document_ids ?? null,
  )
  check('legacy_body_no_source_scope', request?.body?.source_scope === undefined, true, request?.body?.source_scope !== undefined)
  check('legacy_body_no_note_ids', request?.body?.note_ids === undefined, true, request?.body?.note_ids !== undefined)
  await shot(boot, `${PREFIX}_${scene}_${width}`)
  await boot.context.close()
  return { scene, items }
}

async function sceneCapabilityOnAll(browser, width, height) {
  const scene = 'cap_on_all'
  const { items, check } = makeAssert(scene)
  await resetHarness({ capability: 'on', report: 'plain' })
  const boot = await bootApp(browser, width, height)
  await openCompareTab(boot.app)
  const first = await shot(boot, `${PREFIX}_${scene}_${width}`)
  if (IS_BEFORE) {
    // 基线代码不消费能力位：`all` 仍被 legacy 空选守卫阻断，且不发请求。
    check('all_still_blocked_before', first.state.counts.compare_entire_project > 0, '>0', first.state.counts.compare_entire_project)
    check('create_disabled_before', first.state.createDisabled === true, true, first.state.createDisabled)
    const stats = await gatewayStats()
    check('no_create_request_before', (stats.create_requests || []).length === 0, 0, (stats.create_requests || []).length)
  } else {
    // 能力 true：`all` 不再阻断；声明范围提示可见；点击提交 C05 声明范围。
    check('all_not_blocked_after', first.state.counts.compare_entire_project === 0, 0, first.state.counts.compare_entire_project)
    check('create_enabled_after', first.state.createDisabled === false, false, first.state.createDisabled)
    check('declared_scope_notice', first.state.counts.compare_declared_all > 0, '>0', first.state.counts.compare_declared_all)
    await clickCompareCreate(boot.app)
    const stats = await waitForCreateRequest()
    check('create_request_captured', Boolean(stats), true, Boolean(stats))
    const request = stats ? stats.create_requests[0] : null
    check(
      'c05_header',
      request?.header_x_research_contract === 'c05-v1',
      'c05-v1',
      request?.header_x_research_contract ?? null,
    )
    const scope = request?.body?.source_scope
    check(
      'c05_source_scope_all',
      JSON.stringify(scope) === JSON.stringify({ mode: 'all', source_ids: [], single_source_id: null }),
      { mode: 'all', source_ids: [], single_source_id: null },
      scope ?? null,
    )
    check(
      'c05_source_scope_keys',
      scope !== null && scope !== undefined && Object.keys(scope).sort().join(',') === 'mode,single_source_id,source_ids',
      'mode,single_source_id,source_ids',
      scope !== null && scope !== undefined ? Object.keys(scope).sort().join(',') : null,
    )
    check('c05_note_ids_empty', JSON.stringify(request?.body?.note_ids) === '[]', [], request?.body?.note_ids ?? null)
    check('c05_no_document_ids', request?.body?.document_ids === undefined, true, request?.body?.document_ids !== undefined)
    const second = await shot(boot, `${PREFIX}_${scene}_submitted_${width}`)
    check('submitted_notice', second.state.counts.compare_submitted > 0, '>0', second.state.counts.compare_submitted)
  }
  await boot.context.close()
  return { scene, items }
}

async function sceneCapabilityOnSelected(browser, width, height) {
  const scene = 'cap_on_selected'
  const { items, check } = makeAssert(scene)
  await resetHarness({ capability: 'on', report: 'plain' })
  const boot = await bootApp(browser, width, height)
  await selectTwoSources(boot.app)
  await openCompareTab(boot.app)
  await clickCompareCreate(boot.app)
  const stats = await waitForCreateRequest()
  check('create_request_captured', Boolean(stats), true, Boolean(stats))
  const request = stats ? stats.create_requests[0] : null
  if (IS_BEFORE) {
    check('legacy_header_v1', request?.header_x_research_contract === 'v1', 'v1', request?.header_x_research_contract ?? null)
    check(
      'legacy_body_document_ids',
      JSON.stringify(request?.body?.document_ids) === JSON.stringify(['doc_alpha', 'doc_beta']),
      ['doc_alpha', 'doc_beta'],
      request?.body?.document_ids ?? null,
    )
  } else {
    check('c05_header', request?.header_x_research_contract === 'c05-v1', 'c05-v1', request?.header_x_research_contract ?? null)
    const scope = request?.body?.source_scope
    check(
      'c05_source_scope_selected',
      JSON.stringify(scope) ===
        JSON.stringify({ mode: 'selected', source_ids: ['src_alpha', 'src_beta'], single_source_id: null }),
      { mode: 'selected', source_ids: ['src_alpha', 'src_beta'], single_source_id: null },
      scope ?? null,
    )
    check('c05_note_ids_empty', JSON.stringify(request?.body?.note_ids) === '[]', [], request?.body?.note_ids ?? null)
    check('c05_no_document_ids', request?.body?.document_ids === undefined, true, request?.body?.document_ids !== undefined)
  }
  await shot(boot, `${PREFIX}_${scene}_${width}`)
  await boot.context.close()
  return { scene, items }
}

async function runReportScene(browser, width, height, { scene, reportMode, expected }) {
  const { items, check } = makeAssert(scene)
  await resetHarness({ capability: 'on', report: reportMode })
  const boot = await bootApp(browser, width, height)
  await openActivityReport(boot.app)
  const { state } = await shot(boot, `${PREFIX}_${scene}_${width}`)
  if (reportMode === 'revoked') {
    if (IS_BEFORE) {
      check('before_no_restricted_placeholder', state.counts.report_restricted === 0, 0, state.counts.report_restricted)
      check('before_no_report_body', state.counts.report_content === 0, 0, state.counts.report_content)
      check('before_generic_error_shown', hasText(state, 'Report is not available yet'), true, hasText(state, 'Report is not available yet'))
    } else {
      check('after_restricted_placeholder', state.counts.report_restricted > 0, '>0', state.counts.report_restricted)
      check('after_no_report_body', state.counts.report_content === 0, 0, state.counts.report_content)
      check(
        'after_restricted_explains_revoke',
        hasText(state, 'no longer readable'),
        true,
        hasText(state, 'no longer readable'),
      )
      const stats = await gatewayStats()
      check('report_request_410', stats.report_requests > 0, '>0', stats.report_requests)
    }
    await boot.context.close()
    return { scene, items }
  }
  if (reportMode === 'unavailable503') {
    if (IS_BEFORE) {
      check('before_generic_error_shown', hasText(state, 'Report is not available yet'), true, hasText(state, 'Report is not available yet'))
      check('before_no_retry_button', state.counts.report_retry_button === 0, 0, state.counts.report_retry_button)
    } else {
      check('after_retryable_shown', state.counts.report_retryable > 0, '>0', state.counts.report_retryable)
      check('after_retry_button', state.counts.report_retry_button > 0, '>0', state.counts.report_retry_button)
      check('after_no_report_body', state.counts.report_content === 0, 0, state.counts.report_content)
      // 重试：服务端恢复后点击 Retry → 正文出现（503 可重试的浏览器级证据）
      await setReportMode('pass')
      await boot.app.locator(HOOKS.reportRetryButton).click({ timeout: 10000 })
      await boot.page.waitForTimeout(1600)
      const retried = await collectState(boot)
      check('after_retry_renders_report', retried.counts.report_content > 0, '>0', retried.counts.report_content)
      await shot(boot, `${PREFIX}_${scene}_retried_${width}`)
    }
    await boot.context.close()
    return { scene, items }
  }
  // report_pass / degraded / partial / not_run
  check('report_body_visible', state.counts.report_content > 0, '>0', state.counts.report_content)
  if (IS_BEFORE) {
    check('before_no_readback_section', state.counts.report_readback === 0, 0, state.counts.report_readback)
    check('before_no_verification_status', state.counts.report_verification === 0, 0, state.counts.report_verification)
  } else {
    check('after_readback_section', state.counts.report_readback > 0, '>0', state.counts.report_readback)
    check('after_scope_section', state.counts.report_scope > 0, '>0', state.counts.report_scope)
    check('after_verification_section', state.counts.report_verification > 0, '>0', state.counts.report_verification)
    check(
      'after_verification_status',
      state.verification?.status === expected.status,
      expected.status,
      state.verification?.status ?? null,
    )
    check(
      'after_verification_text',
      typeof state.verification?.text === 'string' && state.verification.text.includes(expected.text),
      expected.text,
      state.verification?.text ?? null,
    )
    if (expected.status !== 'pass') {
      check(
        'after_not_rendered_as_pass',
        typeof state.verification?.text === 'string' &&
          !state.verification.text.includes('Verified — required checks executed with no findings'),
        'no pass text',
        state.verification?.text ?? null,
      )
    }
    if (expected.status === 'not_run') {
      check('after_scope_missing_not_recorded', state.counts.report_scope_empty > 0, '>0', state.counts.report_scope_empty)
    } else {
      check('after_model_section', state.counts.report_model > 0, '>0', state.counts.report_model)
    }
  }
  await boot.context.close()
  return { scene, items }
}

const SCENES = {
  cap_off_all: sceneCapabilityOffAll,
  cap_off_selected: sceneCapabilityOffSelected,
  cap_on_all: sceneCapabilityOnAll,
  cap_on_selected: sceneCapabilityOnSelected,
  report_pass: (browser, width, height) =>
    runReportScene(browser, width, height, {
      scene: 'report_pass',
      reportMode: 'pass',
      expected: { status: 'pass', text: 'Verified — required checks executed with no findings' },
    }),
  report_degraded: (browser, width, height) =>
    runReportScene(browser, width, height, {
      scene: 'report_degraded',
      reportMode: 'degraded',
      expected: { status: 'degraded', text: 'Degraded — verification found unsupported cited claims' },
    }),
  report_partial: (browser, width, height) =>
    runReportScene(browser, width, height, {
      scene: 'report_partial',
      reportMode: 'partial',
      expected: {
        status: 'partial',
        text: 'Partially checked — some checks were skipped, so this is not a pass',
      },
    }),
  report_not_run: (browser, width, height) =>
    runReportScene(browser, width, height, {
      scene: 'report_not_run',
      reportMode: 'not_run',
      expected: {
        status: 'not_run',
        text: 'Not verified — this job ran before comparison verification existed',
      },
    }),
  report_410_revoked: (browser, width, height) =>
    runReportScene(browser, width, height, { scene: 'report_410_revoked', reportMode: 'revoked' }),
  report_503: (browser, width, height) =>
    runReportScene(browser, width, height, {
      scene: 'report_503',
      reportMode: 'unavailable503',
    }),
}

const SCENE_IDS = ONLY_SCENES.length > 0 ? ONLY_SCENES.map((id) => id.toLowerCase()) : Object.keys(SCENES)

async function main() {
  fs.writeFileSync(LOG_FILE, '')
  banner(`ISSUE #1017 VISUAL EVIDENCE — ${PREFIX.toUpperCase()} phase`)
  log(`phase=${PREFIX} host=${HOST} head=${HEAD} widths=${WIDTHS.join(',')} scenes=${SCENE_IDS.join(',')}`)
  log(`gateway=${GATEWAY} chrome=${CHROME}`)
  const browser = await chromium.launch({
    executablePath: CHROME,
    headless: true,
    args: ['--force-color-profile=srgb', '--font-render-hinting=none'],
  })
  let pass = 0
  let fail = 0
  try {
    for (const width of WIDTHS) {
      for (const sceneId of SCENE_IDS) {
        const fn = SCENES[sceneId]
        if (!fn) {
          log(`${PREFIX} unknown scene ${sceneId}`)
          fail += 1
          continue
        }
        const height = heightFor(width)
        banner(`${PREFIX} scene=${sceneId} width=${width}x${height}`)
        try {
          const result = await fn(browser, width, height)
          const ok = result.items.filter((item) => item.ok).length
          const bad = result.items.length - ok
          pass += ok
          fail += bad
          sceneResults.push({
            phase: PREFIX,
            scene: sceneId,
            width,
            height,
            ok,
            fail: bad,
            assertions: result.items,
            error: null,
          })
        } catch (error) {
          fail += 1
          const message = error instanceof Error ? error.message : String(error)
          log(`${PREFIX} scene=${sceneId} width=${width} ERROR ${message}`)
          sceneResults.push({
            phase: PREFIX,
            scene: sceneId,
            width,
            height,
            ok: 0,
            fail: 1,
            assertions: [],
            error: message,
          })
        }
      }
    }
  } finally {
    await browser.close()
  }
  const sceneErrors = sceneResults.filter((scene) => scene.error)
  const total = pass + fail
  banner(`RESULT ${PREFIX}: ${pass} PASS / ${fail} FAIL / ${sceneErrors.length} scene errors`)
  const manifest = {
    issue: 1017,
    phase: PREFIX,
    head: HEAD,
    host: HOST,
    gateway: GATEWAY,
    chrome: CHROME,
    viewports: WIDTHS.map((width) => ({ width, height: heightFor(width) })),
    theme: 'light',
    locale: 'en-US',
    started_at: new Date().toISOString(),
    summary: {
      pass,
      fail,
      total,
      scene_errors: sceneErrors.length,
      scenes: sceneResults.length,
    },
    scenes: sceneResults,
    screenshots: shots,
  }
  fs.writeFileSync(MANIFEST_FILE, JSON.stringify(manifest, null, 2))
  log(`manifest written: ${MANIFEST_FILE}`)
  if (fail > 0 || sceneErrors.length > 0) process.exitCode = 2
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
