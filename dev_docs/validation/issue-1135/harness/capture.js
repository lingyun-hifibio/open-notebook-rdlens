#!/usr/bin/env node
/**
 * Before/After visual + browser-behaviour capture for Issue #1135
 * ("受保护编辑启用入口", legacy ResearchWorkbench / Notes layer, fork frontend).
 *
 * Synthetic harness only: the real fork Next.js app (next dev --webpack) in
 * embedded mode + a synthetic host iframe + a route-mocked Research Gateway.
 * No real RDLens host, database, files, models, patients or private data;
 * every title/id/token is synthetic (`[synthetic]` markers, fixture project
 * p1, viewer 1, fabricated claims-only token).
 *
 * Scenes (each at every requested width, fresh browser context per scene,
 * gateway `/__reset` first; behavior driven by mode files
 * /tmp/issue1135-note-mode and /tmp/issue1135-enable-mode):
 *   E1  legacy unprotected note row action area (hover) — BEFORE: Edit/Delete
 *       only; AFTER: "Enable protected editing" entry visible.
 *   E2  BEFORE: old Edit form opens (unprotected fields, no revision) and the
 *       legacy save still works; AFTER: enable dialog → confirm → in-place
 *       d2-v1 Markdown editor (title/content unchanged, revision shown, save
 *       works, old form gone, catalog row refreshed to d2-v1).
 *   E3  capability `note_editor.available=false`: entry hidden, old form kept.
 *   E4  (AFTER) 403 note_access_restricted: terminal error, no retry.
 *   E5  (AFTER) 503 note_dependency_unavailable: error + retry → editor.
 *   E6  (AFTER) unknown result (enable applied, response 503): dialog shows
 *       unknown + "confirm result" replay with the SAME mutation_id → editor;
 *       `/__stats` proves same mutation_id twice and exactly one apply.
 *   E7  Admin read-only token: no write/enable entry (both phases).
 *   E8  capability read failure (/models 500): fail-closed, no enable entry
 *       (both phases).
 * BEFORE has no enable mutation at all: E4/E5/E6 are recorded as N/A baseline
 * gaps (not fabricated).
 *
 * Usage:
 *   node capture.js --phase=before --host=http://127.0.0.1:8980/ --head=<sha>
 *   node capture.js --phase=after  --host=http://127.0.0.1:8982/ --head=<sha>
 * Optional: --widths=1440,1024 --scenes=e1,e2 --outdir=<dir> --logfile=<file>
 */
const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')
const crypto = require('node:crypto')
const { chromium } = require('/home/lchen/workspace/RDLens/scripts/e2e/node_modules/playwright-core')

const CHROME = '/home/lchen/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome'
const EVIDENCE_ROOT = path.resolve(__dirname, '..') // dev_docs/validation/issue-1135
const NOTE_MODE_FILE = '/tmp/issue1135-note-mode'
const ENABLE_MODE_FILE = '/tmp/issue1135-enable-mode'
const GATEWAY = process.env.ISSUE1135_GATEWAY || 'http://127.0.0.1:8951'

const arg = (name, fallback) => {
  const hit = process.argv.find((item) => item.startsWith(`--${name}=`))
  return hit ? hit.split('=').slice(1).join('=') : fallback
}
const PHASE = arg('phase', 'before')
const PREFIX = PHASE === 'after' ? 'after' : 'before'
const HOST = arg('host', PHASE === 'after' ? 'http://127.0.0.1:8982/' : 'http://127.0.0.1:8980/')
const HEAD = arg('head', 'unset')
const WIDTHS = (arg('widths', '1440,1024') || '1440,1024')
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
if (!fs.existsSync(LOG_FILE)) fs.writeFileSync(LOG_FILE, '')

const HEIGHTS = { 1440: 900, 1024: 768 }
const heightFor = (width) => HEIGHTS[width] || Math.round((width * 900) / 1440)
const GATEWAY_ORIGIN = (() => {
  try {
    return new URL(GATEWAY).origin
  } catch {
    return GATEWAY
  }
})()

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
const stamp = () => `${Date.now() % 1000000}`
const sha256File = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')

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
const stats = async () => (await gatewayCall('GET', '/__stats')).body || {}
const currentNote = async (noteId) =>
  (await gatewayCall('GET', `/__note?note_id=${encodeURIComponent(noteId)}`)).body

async function resetHarness({ noteMode = 'editor_on', enableMode = 'success' } = {}) {
  fs.writeFileSync(NOTE_MODE_FILE, noteMode)
  fs.writeFileSync(ENABLE_MODE_FILE, enableMode)
  await gatewayCall('GET', '/__reset')
  log(`${PREFIX} harness reset: note_mode=${noteMode} enable_mode=${enableMode}`)
}

function statsSummary(raw) {
  if (!raw) return null
  return {
    note_mode: raw.note_mode,
    enable_mode: raw.enable_mode,
    models_requests: raw.models_requests,
    enable_semantic_changes: raw.enable_semantic_changes,
    enable_requests: (raw.enable_requests || []).map((entry) => ({
      note_id: entry.note_id,
      mutation_id: entry.mutation_id,
      mode: entry.mode,
      outcome: entry.outcome,
      status: entry.status,
    })),
    enable_applies: (raw.enable_applies || []).map((entry) => ({
      note_id: entry.note_id,
      mutation_id: entry.mutation_id,
      applied_revision: entry.applied_revision,
    })),
    saves: (raw.saves || []).map((entry) => ({
      note_id: entry.note_id,
      mutation_id: entry.mutation_id,
      expected_revision: entry.expected_revision,
      status: entry.status,
    })),
    notes: (raw.notes || []).map(
      (note) => `${note.note_id}@${note.revision === null ? 'legacy' : `r${note.revision}`}:${note.edit_schema ?? 'legacy'}`,
    ),
    note_requests: (raw.note_requests || []).length,
  }
}

// ── DOM hooks ─────────────────────────────────────────────────────────────
const HOOKS = {
  groupNav: ['[data-testid="workbench-group-nav"]'],
  catalog: ['[data-testid="note-catalog"]'],
  listRows: ['[data-testid="note-list-rows"]'],
  editor: ['[data-testid="note-editor"]'],
  content: [
    'textarea.w-md-editor-text-input',
    '#note-editor-markdown',
    '[data-testid="note-editor-content"] textarea.w-md-editor-text-input',
  ],
  title: ['[data-testid="note-editor-title"]'],
  revision: ['[data-testid="note-editor-revision"]'],
  saveNow: ['[data-testid="note-editor-save-now"]'],
  saveStatus: ['[data-testid="note-save-status"]'],
  capabilityBlocked: ['[data-testid="note-capability-blocked"]'],
  capabilityRetry: ['[data-testid="note-capability-retry"]'],
  adminBanner: ['[data-testid="admin-readonly-banner"]'],
  legacyFormHint: ['[data-testid="legacy-note-form-hint"]'],
  legacyTitle: ['#note-title'],
  legacyContent: ['#note-content'],
  row: (noteId) => `[data-testid="note-catalog-row-${noteId}"]`,
  rowEnablePrefix: '[data-testid^="note-enable-"]',
  enable: (noteId) => `[data-testid="note-enable-${noteId}"]`,
  dialog: ['[data-testid="note-enable-dialog"]'],
  confirm: ['[data-testid="note-enable-confirm"]'],
  cancel: ['[data-testid="note-enable-cancel"]'],
  error: ['[data-testid="note-enable-error"]'],
  retry: ['[data-testid="note-enable-retry"]'],
  // "Confirm result" (research.notes.enable.confirmResult) — the implementation
  // may use a dedicated testid or reuse the retry slot with a different label.
  confirmResult: [
    '[data-testid="note-enable-confirm-result"]',
    '[data-testid="note-enable-confirm-result-button"]',
    '[data-testid="note-enable-unknown-confirm"]',
  ],
}

async function count(app, selector) {
  return app.locator(selector).count().catch(() => 0)
}
async function findFirst(app, selectors) {
  for (const selector of selectors) {
    const locator = app.locator(selector).first()
    if ((await locator.count().catch(() => 0)) > 0) return { selector, locator }
  }
  return { selector: null, locator: null }
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
const missing = (scene, what) => log(`${PREFIX} ${scene} HOOK-MISSING ${what}`)

/** All per-screenshot evidence: testid counts + editor/dialog text presence. */
async function collectState(boot) {
  const { app } = boot
  const counts = {
    note_enable: 0,
    note_enable_dialog: 0,
    note_enable_error: 0,
    note_enable_retry: 0,
    note_enable_confirm: 0,
    note_enable_cancel: 0,
    note_capability_blocked: 0,
    admin_readonly_banner: 0,
    note_editor: 0,
    note_editor_revision: 0,
    note_editor_save_now: 0,
    legacy_note_form_hint: 0,
    note_save_status: 0,
    note_catalog: 0,
    workbench_group_nav: 0,
  }
  counts.note_enable = await count(app, HOOKS.rowEnablePrefix)
  counts.note_enable_dialog = await count(app, HOOKS.dialog[0])
  counts.note_enable_error = await count(app, HOOKS.error[0])
  counts.note_enable_retry = await count(app, HOOKS.retry[0])
  counts.note_enable_confirm = await count(app, HOOKS.confirm[0])
  counts.note_enable_cancel = await count(app, HOOKS.cancel[0])
  const simpleCounts = {
    note_capability_blocked: 'capabilityBlocked',
    admin_readonly_banner: 'adminBanner',
    note_editor: 'editor',
    note_editor_revision: 'revision',
    note_editor_save_now: 'saveNow',
    legacy_note_form_hint: 'legacyFormHint',
    note_save_status: 'saveStatus',
    note_catalog: 'catalog',
    workbench_group_nav: 'groupNav',
  }
  for (const [key, hookName] of Object.entries(simpleCounts)) {
    for (const selector of HOOKS[hookName]) counts[key] += await count(app, selector)
  }
  const enableTestids = await app
    .evaluate(() =>
      [...document.querySelectorAll('[data-testid^="note-enable-"]')]
        .map((node) => node.getAttribute('data-testid'))
        .slice(0, 20),
    )
    .catch(() => [])
  const enableError = await app
    .evaluate(() => {
      const node = document.querySelector('[data-testid="note-enable-error"]')
      return node
        ? {
            failure_kind: node.getAttribute('data-failure-kind'),
            text: (node.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 300),
          }
        : null
    })
    .catch(() => null)
  const dialogText = await app
    .evaluate(() => {
      const node = document.querySelector('[data-testid="note-enable-dialog"]')
      return node ? (node.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 600) : null
    })
    .catch(() => null)
  const dialogPhase = await app
    .evaluate(() => {
      const node = document.querySelector('[data-testid="note-enable-dialog"]')
      return node ? node.getAttribute('data-phase') : null
    })
    .catch(() => null)
  const retryLabel = await app
    .evaluate(() => {
      const node =
        document.querySelector('[data-testid="note-enable-retry"]') ||
        document.querySelector('[data-testid="note-enable-confirm-result"]')
      return node ? (node.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 160) : null
    })
    .catch(() => null)
  const editorState = await app
    .evaluate(() => {
      const titleNode = document.querySelector('[data-testid="note-editor-title"]')
      const revisionNode = document.querySelector('[data-testid="note-editor-revision"]')
      const contentNode = document.querySelector('textarea.w-md-editor-text-input')
      const saveNow = document.querySelector('[data-testid="note-editor-save-now"]')
      return {
        title: titleNode ? titleNode.value ?? titleNode.textContent : null,
        revision: revisionNode
          ? (revisionNode.textContent || '').replace(/\s+/g, ' ').trim()
          : null,
        contentTail: contentNode ? contentNode.value.slice(-500) : null,
        contentContainsFixture: contentNode
          ? contentNode.value.includes('Legacy note created before d2-v1 editing protection')
          : false,
        saveNowDisabled: saveNow ? Boolean(saveNow.disabled) : null,
      }
    })
    .catch(() => null)
  const saveStatus = await app
    .evaluate(() => {
      const node = document.querySelector('[data-testid="note-save-status"]')
      return node
        ? {
            status: node.getAttribute('data-status'),
            text: (node.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 160),
          }
        : null
    })
    .catch(() => null)
  const rows = await app
    .evaluate(() => {
      const result = {}
      for (const id of ['note_legacy', 'note_d1']) {
        const row = document.querySelector(`[data-testid="note-catalog-row-${id}"]`)
        result[id] = row
          ? {
              edit_schema: row.getAttribute('data-edit-schema'),
              revision_testid: Boolean(
                row.querySelector(`[data-testid="note-revision-${id}"]`),
              ),
              legacy_badge: Boolean(row.querySelector(`[data-testid="note-legacy-${id}"]`)),
              enable_button: Boolean(row.querySelector(`[data-testid="note-enable-${id}"]`)),
              row_buttons: [...row.querySelectorAll('button')].map((node) =>
                (node.getAttribute('aria-label') || node.textContent || '').replace(/\s+/g, ' ').trim(),
              ),
            }
          : null
      }
      return result
    })
    .catch(() => ({}))
  const bodyText = await app
    .evaluate(() => (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 2500))
    .catch(() => '')
  return {
    url: app.url(),
    counts,
    enableTestids,
    enableError,
    dialogText,
    dialogPhase,
    retryLabel,
    editor: editorState,
    saveStatus,
    rows,
    bodyText,
  }
}

const hasText = (state, needle) =>
  typeof state.bodyText === 'string' && state.bodyText.toLowerCase().includes(needle.toLowerCase())
const editorHas = (state, needle) =>
  typeof state.editor?.contentTail === 'string' &&
  state.editor.contentTail.toLowerCase().includes(needle.toLowerCase())

async function shot(boot, name) {
  const file = path.join(OUT_DIR, `${name}.png`)
  await boot.page.screenshot({ path: file, animations: 'disabled' })
  const size = fs.statSync(file).size
  const digest = sha256File(file)
  const gatewayStats = statsSummary(await stats())
  const state = await collectState(boot)
  shots.push({
    file: path.basename(file),
    bytes: size,
    sha256: digest,
    dom_counts: state.counts,
    enable_testids: state.enableTestids,
    enable_error: state.enableError,
    enable_retry_label: state.retryLabel,
    dialog_text: state.dialogText,
    dialog_phase: state.dialogPhase,
    editor: state.editor,
    save_status: state.saveStatus,
    rows: state.rows,
    gateway_stats: gatewayStats,
  })
  log(`SHOT ${path.basename(file)} (${size} bytes, sha256=${digest.slice(0, 16)}…)`)
  log(`SHOT-DOM ${path.basename(file)} ${JSON.stringify(state.counts)}`)
  log(`SHOT-STATS ${path.basename(file)} ${JSON.stringify(gatewayStats)}`)
  return file
}

// ── browser boot / app helpers ────────────────────────────────────────────
const DEV_OVERLAY_CSS =
  'nextjs-portal,[data-nextjs-toast],[data-nextjs-dev-tools-button]{display:none!important;visibility:hidden!important}'

async function findAppFrame(page, timeoutMs = 60000) {
  const frame = await waitFor(() => {
    const app = page.frames().find((candidate) => candidate.url().includes('/research'))
    return app || false
  }, timeoutMs, 400)
  return frame
}

async function waitForWorkspace(app, timeoutMs = 90000) {
  return waitFor(async () => (await count(app, HOOKS.groupNav[0])) > 0, timeoutMs, 400)
}

async function bootApp(browser, width, height, { role = null } = {}) {
  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: 1,
    colorScheme: 'light',
    locale: 'en-US',
  })
  const page = await context.newPage()
  // `errors` = unexpected page/console errors (asserted 0).
  // `expectedHttpErrors` = Chromium's own "Failed to load resource: ... status
  // of 4xx/5xx" console entries for the *intentional* synthetic failure modes
  // of this harness (403/404/409/500/503). Recorded separately as evidence of
  // the driven mode, not app errors.
  const errors = []
  const expectedHttpErrors = []
  const EXPECTED_HTTP_STATUS =
    /Failed to load resource: the server responded with a status of (400|403|404|409|422|428|500|503)/
  const net = { enablePosts: [], enableResponses: [], models: 0, calls: [] }
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
  page.on('dialog', async (dialog) => {
    log(`${PREFIX} dialog type=${dialog.type()} message=${JSON.stringify(dialog.message().slice(0, 120))} -> accept`)
    await dialog.accept().catch(() => {})
  })
  page.on('request', (request) => {
    const url = request.url()
    if (!url.startsWith(GATEWAY_ORIGIN)) return
    const method = request.method()
    const urlPath = url.replace(/^https?:\/\/[^/]+/, '')
    net.calls.push(`${method} ${urlPath}`)
    if (method === 'POST' && /\/notes\/[^/]+\/editing$/.test(url.split('?')[0])) {
      let body = null
      try {
        body = JSON.parse(request.postData() || 'null')
      } catch {
        body = null
      }
      net.enablePosts.push({
        path: urlPath,
        mutation_id: body && body.mutation_id ? body.mutation_id : null,
        at: Date.now(),
      })
    }
    if (/\/models$/.test(url.split('?')[0])) net.models += 1
  })
  page.on('response', (response) => {
    const url = response.url()
    if (!url.startsWith(GATEWAY_ORIGIN)) return
    if (!/\/notes\/[^/]+\/editing$/.test(url.split('?')[0])) return
    net.enableResponses.push({
      status: response.status(),
      path: url.replace(/^https?:\/\/[^/]+/, ''),
    })
  })
  await page.addInitScript(() => {
    try {
      window.__e2eHideDevOverlay = true
    } catch {
      /* ignore */
    }
  })
  const hostUrl = role === null ? HOST : `${HOST}?role=${encodeURIComponent(role)}`
  await page.goto(hostUrl, { waitUntil: 'domcontentloaded' })
  const app = await findAppFrame(page)
  if (!app) throw new Error('app iframe frame not found')
  const ready = await waitForWorkspace(app)
  if (!ready) throw new Error('workbench did not become ready inside the iframe')
  await page.waitForTimeout(1500)
  for (const target of [page, app]) {
    await target
      .evaluate((css) => {
        const style = document.createElement('style')
        style.textContent = css
        document.head.appendChild(style)
      }, DEV_OVERLAY_CSS)
      .catch(() => {})
  }
  log(`${PREFIX} boot width=${width} host=${hostUrl} frame=${app.url()} role=${role || 'owner'}`)
  return { context, page, app, errors, expectedHttpErrors, net, width, height, role }
}

async function openNotes(app) {
  const nav = app.locator(HOOKS.groupNav[0])
  await nav.waitFor({ timeout: 40000 })
  await app.getByRole('button', { name: 'Notes', exact: true }).click({ timeout: 20000 })
  await app
    .locator('[data-testid="note-catalog"], [data-testid="note-list-rows"]')
    .first()
    .waitFor({ timeout: 30000 })
  await app.page().waitForTimeout(1200)
}

async function hoverRow(app, noteId) {
  const row = app.locator(HOOKS.row(noteId)).first()
  if ((await row.count().catch(() => 0)) === 0) return false
  await row.hover({ timeout: 10000 })
  await app.page().waitForTimeout(500)
  return true
}

async function afterEditorReady(app, timeoutMs = 30000) {
  return waitFor(async () => {
    const editor = await count(app, HOOKS.editor[0])
    const content = await count(app, 'textarea.w-md-editor-text-input')
    return editor > 0 && content > 0
  }, timeoutMs, 300)
}

async function clickRowAction(app, noteId, label) {
  const row = app.locator(HOOKS.row(noteId)).first()
  const button = row.getByRole('button', { name: label, exact: true }).first()
  const found = (await button.count().catch(() => 0)) > 0
  if (!found) return { clicked: false, reason: `button ${label} not found in row ${noteId}` }
  await button.click({ timeout: 15000 })
  await app.page().waitForTimeout(800)
  return { clicked: true }
}

async function clickEnableEntry(app, noteId) {
  await hoverRow(app, noteId)
  const selector = HOOKS.enable(noteId)
  const entry = app.locator(selector).first()
  if ((await entry.count().catch(() => 0)) === 0) return { clicked: false, reason: 'enable entry absent' }
  await entry.click({ timeout: 15000 })
  await app.page().waitForTimeout(900)
  return { clicked: true, selector }
}

async function clickDialogButton(app, selectors, fallbackLabel = null) {
  for (const selector of selectors) {
    const locator = app.locator(selector).first()
    if ((await locator.count().catch(() => 0)) > 0) {
      await locator.click({ timeout: 15000 })
      await app.page().waitForTimeout(1200)
      return { clicked: true, selector }
    }
  }
  if (fallbackLabel !== null) {
    const dialog = app.locator(HOOKS.dialog[0]).first()
    if ((await dialog.count().catch(() => 0)) > 0) {
      const buttons = dialog.getByRole('button')
      const total = await buttons.count().catch(() => 0)
      for (let index = 0; index < total; index += 1) {
        const button = buttons.nth(index)
        const text = ((await button.textContent().catch(() => '')) || '').trim()
        if (fallbackLabel.test(text)) {
          await button.click({ timeout: 15000 })
          await app.page().waitForTimeout(1200)
          return { clicked: true, selector: `dialog-button-text:${text}` }
        }
      }
    }
  }
  return { clicked: false, selector: null }
}

async function scrollEditorIntoView(app) {
  await app
    .evaluate(() => {
      const node = document.querySelector('[data-testid="note-editor"]')
      if (node instanceof HTMLElement) node.scrollIntoView({ block: 'start' })
    })
    .catch(() => {})
  await app.page().waitForTimeout(450)
}

async function typeIntoEditor(app, text) {
  const found = await findFirst(app, HOOKS.content)
  if (found.locator === null) return false
  await found.locator.click({ timeout: 10000 })
  await found.locator.press('End')
  await found.locator.type(text, { delay: 35 })
  return true
}

async function editorState(app) {
  return app
    .evaluate(() => {
      const titleNode = document.querySelector('[data-testid="note-editor-title"]')
      const revisionNode = document.querySelector('[data-testid="note-editor-revision"]')
      const contentNode = document.querySelector('textarea.w-md-editor-text-input')
      const saveNow = document.querySelector('[data-testid="note-editor-save-now"]')
      return {
        title: titleNode ? titleNode.value ?? titleNode.textContent : null,
        revision: revisionNode
          ? (revisionNode.textContent || '').replace(/\s+/g, ' ').trim()
          : null,
        content: contentNode ? contentNode.value : null,
        saveNowDisabled: saveNow ? Boolean(saveNow.disabled) : null,
      }
    })
    .catch(() => null)
}

async function saveStatus(app) {
  return app
    .evaluate(() => {
      const node = document.querySelector('[data-testid="note-save-status"]')
      if (!node) return null
      return {
        status: node.getAttribute('data-status'),
        text: (node.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 160),
      }
    })
    .catch(() => null)
}

async function trackSaveStatus(app, { targets = [], timeoutMs = 20000 } = {}) {
  const seen = []
  const start = Date.now()
  let last = null
  while (Date.now() - start < timeoutMs) {
    const info = await saveStatus(app)
    if (info) {
      last = info
      const key = `${info.status}|${info.text}`
      if (seen.length === 0 || seen[seen.length - 1].key !== key) {
        seen.push({ key, ...info, atMs: Date.now() - start })
      }
      if (info.status && targets.includes(info.status)) break
    }
    await app.page().waitForTimeout(150)
  }
  return { seen: seen.map(({ key, ...rest }) => rest), last }
}

// ── assertion bookkeeping ─────────────────────────────────────────────────
function makeAssert() {
  const items = []
  const check = (name, ok, expected, actual) => {
    items.push({ name, ok: Boolean(ok), expected, actual })
    log(`${PREFIX} ASSERT ${ok ? 'PASS' : 'FAIL'} ${name} expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`)
    return Boolean(ok)
  }
  return { items, check }
}

const FIXTURE = {
  legacyNoteId: 'note_legacy',
  legacyTitle: '[synthetic] Legacy note (pre-protection)',
  legacyContentMarker: 'Legacy note created before d2-v1 editing protection',
  d2NoteId: 'note_d1',
  d2Revision: 3,
}

// ── BEFORE scenes (baseline: no enable entry) ─────────────────────────────
async function sceneE1(browser, width, height) {
  const scene = 'E1'
  const { items, check } = makeAssert()
  await resetHarness({ noteMode: 'editor_on', enableMode: 'success' })
  const boot = await bootApp(browser, width, height)
  const app = boot.app
  await openNotes(app)
  const rowExists = (await count(app, HOOKS.row(FIXTURE.legacyNoteId))) >= 1
  check('e1.legacy_row_present', rowExists, 'note-catalog-row-note_legacy present', rowExists)
  const row = await collectState(boot)
  check(
    'e1.legacy_row_is_unprotected',
    row.rows[FIXTURE.legacyNoteId] && row.rows[FIXTURE.legacyNoteId].edit_schema === 'legacy',
    'legacy row data-edit-schema="legacy"',
    row.rows[FIXTURE.legacyNoteId],
  )
  const hovered = await hoverRow(app, FIXTURE.legacyNoteId)
  check('e1.row_hovered', hovered, 'legacy row hover works', hovered)
  await shot(boot, `${PREFIX}_e1_row_actions_${width}`)
  const state = await collectState(boot)
  const legacyButtons = (state.rows[FIXTURE.legacyNoteId] || {}).row_buttons || []
  if (PHASE === 'before') {
    check(
      'e1.before_legacy_edit_delete_actions',
      legacyButtons.includes('Edit') && legacyButtons.includes('Delete'),
      'legacy row action area shows Edit and Delete',
      legacyButtons,
    )
    check(
      'e1.before_no_enable_entry',
      state.counts.note_enable === 0,
      '0 note-enable-* testids in the legacy row action area (baseline gap)',
      { enable: state.counts.note_enable, testids: state.enableTestids },
    )
  } else {
    check(
      'e1.after_enable_entry_visible',
      state.counts.note_enable >= 1 &&
        (await count(app, `[data-testid="note-enable-${FIXTURE.legacyNoteId}"]`)) >= 1,
      'note-enable-note_legacy present in the hovered legacy row',
      { enable: state.counts.note_enable, testids: state.enableTestids },
    )
    const entry = app.locator(HOOKS.enable(FIXTURE.legacyNoteId)).first()
    check(
      'e1.after_enable_entry_visible_after_hover',
      await entry.isVisible().catch(() => false),
      'enable entry is visible after hovering the row',
      await entry.isVisible().catch(() => false),
    )
    check(
      'e1.after_legacy_edit_delete_kept',
      legacyButtons.includes('Edit') && legacyButtons.includes('Delete'),
      'legacy Edit/Delete actions remain next to the enable entry',
      legacyButtons,
    )
    check(
      'e1.after_no_dialog_before_click',
      state.counts.note_enable_dialog === 0,
      'no enable dialog before clicking the entry',
      state.counts.note_enable_dialog,
    )
  }
  const raw = await stats()
  check(
    'e1.no_enable_request_on_row_view',
    (raw.enable_requests || []).length === 0,
    'no POST .../editing request merely by viewing/hovering the row',
    (raw.enable_requests || []).length,
  )
  log(`${PREFIX} ${scene} console-errors=${JSON.stringify(boot.errors)} expected-http-errors=${JSON.stringify(boot.expectedHttpErrors)}`)
  check('e1.no_console_or_page_errors', boot.errors.length === 0, [], boot.errors)
  await boot.context.close()
  return { id: scene, width, note_mode: 'editor_on', enable_mode: 'success', stats: statsSummary(raw), assertions: items }
}

async function sceneE2Before(browser, width, height) {
  const scene = 'E2'
  const { items, check } = makeAssert()
  await resetHarness({ noteMode: 'editor_on', enableMode: 'success' })
  const boot = await bootApp(browser, width, height)
  const app = boot.app
  await openNotes(app)
  await hoverRow(app, FIXTURE.legacyNoteId)
  const clicked = await clickRowAction(app, FIXTURE.legacyNoteId, 'Edit')
  check('e2.before_edit_action_clicked', clicked.clicked, 'legacy row Edit button clicked', clicked)
  const formOpen = await waitFor(async () => (await count(app, HOOKS.legacyFormHint[0])) > 0, 15000)
  check('e2.before_legacy_form_opened', Boolean(formOpen), 'legacy-note-form-hint >= 1', formOpen)
  const formState = await app
    .evaluate(() => {
      const title = document.querySelector('#note-title')
      const content = document.querySelector('#note-content')
      return {
        title: title ? title.value : null,
        content: content ? content.value : null,
      }
    })
    .catch(() => null)
  check(
    'e2.before_legacy_form_prefilled',
    formState &&
      formState.title === FIXTURE.legacyTitle &&
      typeof formState.content === 'string' &&
      formState.content.includes(FIXTURE.legacyContentMarker),
    'old form prefilled with the legacy note title/content',
    formState && { title: formState.title, contentPrefix: formState.content?.slice(0, 60) },
  )
  const state = await collectState(boot)
  check(
    'e2.before_no_protected_editor_or_revision',
    state.counts.note_editor === 0 && state.counts.note_editor_revision === 0,
    'no protected d2-v1 editor / revision display for the legacy note (baseline gap)',
    { editor: state.counts.note_editor, revision: state.counts.note_editor_revision },
  )
  check(
    'e2.before_no_enable_entry',
    state.counts.note_enable === 0,
    '0 note-enable-* testids (baseline gap)',
    { enable: state.counts.note_enable, testids: state.enableTestids },
  )
  await shot(boot, `${PREFIX}_e2_legacy_form_${width}`)

  // Baseline old-form behavior stays valid: edit the title and save through the
  // legacy PATCH route, then observe the catalog note updated.
  const marker = `[synthetic] E2 legacy save marker ${stamp()}`
  const titleInput = app.locator('#note-title').first()
  await titleInput.click({ timeout: 10000 })
  await titleInput.press('End')
  await titleInput.type(` ${marker}`, { delay: 25 })
  const saveButton = app.getByRole('button', { name: 'Save', exact: true }).first()
  await saveButton.click({ timeout: 15000 })
  await boot.page.waitForTimeout(2000)
  const raw = await stats()
  const legacySave = (raw.saves || []).find(
    (entry) => entry.note_id === FIXTURE.legacyNoteId && entry.selected === false,
  )
  check(
    'e2.before_legacy_save_succeeds',
    Boolean(legacySave) && legacySave.status === 200,
    'legacy (unprotected) PATCH save returns 200',
    legacySave || (raw.saves || []),
  )
  const updatedNote = await currentNote(FIXTURE.legacyNoteId)
  check(
    'e2.before_legacy_save_updates_note',
    Boolean(updatedNote) && String(updatedNote.title).includes(marker),
    'server-side legacy note title updated through the old form',
    updatedNote && { title: updatedNote.title, edit_schema: updatedNote.edit_schema },
  )
  check(
    'e2.before_note_stays_unprotected',
    updatedNote && updatedNote.edit_schema === null,
    'legacy note remains unprotected (edit_schema null) after the old-form save',
    updatedNote && updatedNote.edit_schema,
  )
  await shot(boot, `${PREFIX}_e2_legacy_saved_${width}`)
  log(`${PREFIX} ${scene} console-errors=${JSON.stringify(boot.errors)} expected-http-errors=${JSON.stringify(boot.expectedHttpErrors)}`)
  check('e2.no_console_or_page_errors', boot.errors.length === 0, [], boot.errors)
  await boot.context.close()
  return { id: scene, width, note_mode: 'editor_on', enable_mode: 'success', marker, stats: statsSummary(raw), assertions: items }
}

async function sceneE2After(browser, width, height) {
  const scene = 'E2'
  const { items, check } = makeAssert()
  await resetHarness({ noteMode: 'editor_on', enableMode: 'success' })
  const boot = await bootApp(browser, width, height)
  const app = boot.app
  await openNotes(app)
  const clicked = await clickEnableEntry(app, FIXTURE.legacyNoteId)
  check('e2.enable_entry_clicked', clicked.clicked, 'note-enable-note_legacy clicked', clicked)
  const dialogOpen = await waitFor(async () => (await count(app, HOOKS.dialog[0])) > 0, 15000)
  check('e2.enable_dialog_opened', Boolean(dialogOpen), 'note-enable-dialog >= 1', dialogOpen)
  const dialogState = await collectState(boot)
  check(
    'e2.dialog_has_confirm_and_cancel',
    dialogState.counts.note_enable_confirm >= 1 && dialogState.counts.note_enable_cancel >= 1,
    'dialog exposes note-enable-confirm and note-enable-cancel',
    {
      confirm: dialogState.counts.note_enable_confirm,
      cancel: dialogState.counts.note_enable_cancel,
    },
  )
  check(
    'e2.dialog_mentions_enabling_protected_editing',
    hasText(dialogState, 'protect') || hasText(dialogState, 'enable'),
    'dialog text mentions enabling protected editing',
    dialogState.dialogText,
  )
  check(
    'e2.dialog_phase_confirming',
    dialogState.dialogPhase === 'confirming',
    'dialog data-phase=confirming before the user confirms',
    dialogState.dialogPhase,
  )
  await shot(boot, `${PREFIX}_e2_enable_dialog_${width}`)

  const confirmed = await clickDialogButton(app, HOOKS.confirm)
  check('e2.confirm_clicked', confirmed.clicked, 'note-enable-confirm clicked', confirmed)
  const editorReady = await afterEditorReady(app, 40000)
  check('e2.editor_opened_in_place', Boolean(editorReady), 'd2-v1 Markdown editor opened after confirm', Boolean(editorReady))
  await boot.page.waitForTimeout(1500)
  await scrollEditorIntoView(app)
  const opened = await collectState(boot)
  log(`${PREFIX} ${scene} opened=${JSON.stringify(opened.counts)} editor=${JSON.stringify(opened.editor)} rows=${JSON.stringify(opened.rows)}`)
  await shot(boot, `${PREFIX}_e2_editor_opened_${width}`)
  check(
    'e2.editor_title_unchanged',
    opened.editor && opened.editor.title === FIXTURE.legacyTitle,
    `editor title equals fixture "${FIXTURE.legacyTitle}"`,
    opened.editor && opened.editor.title,
  )
  check(
    'e2.editor_content_unchanged',
    opened.editor && opened.editor.contentContainsFixture,
    'editor content still contains the legacy fixture body',
    opened.editor && opened.editor.contentTail,
  )
  check(
    'e2.editor_revision_shown',
    opened.counts.note_editor_revision >= 1 && /revision/i.test((opened.editor || {}).revision || ''),
    'editor displays Revision',
    opened.editor && opened.editor.revision,
  )
  check(
    'e2.save_available',
    opened.counts.note_editor_save_now >= 1 && opened.editor && opened.editor.saveNowDisabled === false,
    'Save now button present and enabled',
    opened.editor && { saveNow: opened.counts.note_editor_save_now, disabled: opened.editor.saveNowDisabled },
  )
  check(
    'e2.old_legacy_form_gone',
    opened.counts.legacy_note_form_hint === 0,
    'legacy (unprotected) form not rendered after enabling',
    opened.counts.legacy_note_form_hint,
  )
  check(
    'e2.enable_entry_gone_after_enable',
    opened.counts.note_enable === 0,
    'enable entry no longer offered once the note is protected',
    opened.enableTestids,
  )
  check(
    'e2.catalog_row_refreshed_to_d2_v1',
    opened.rows[FIXTURE.legacyNoteId] &&
      opened.rows[FIXTURE.legacyNoteId].edit_schema === 'd2-v1' &&
      opened.rows[FIXTURE.legacyNoteId].revision_testid === true &&
      opened.rows[FIXTURE.legacyNoteId].legacy_badge === false,
    'catalog row refreshed: data-edit-schema=d2-v1, revision shown, legacy badge gone',
    opened.rows[FIXTURE.legacyNoteId],
  )
  check(
    'e2.dialog_closed_after_success',
    opened.counts.note_enable_dialog === 0,
    'enable dialog closed after success',
    opened.counts.note_enable_dialog,
  )

  // Save through the in-place d2-v1 editor (revision-aware PATCH) — proves the
  // enabled note is really editable, not just rendered.
  const marker = `[synthetic] E2 enabled save marker ${stamp()}`
  const typed = await typeIntoEditor(app, `\n\n${marker}`)
  check('e2.typed_into_enabled_editor', typed, true, typed)
  const tracked = await trackSaveStatus(app, { targets: ['saved', 'failed', 'unknown'], timeoutMs: 25000 })
  log(`${PREFIX} ${scene} save-statuses=${JSON.stringify(tracked.seen)}`)
  check(
    'e2.enabled_editor_saves',
    tracked.last && tracked.last.status === 'saved',
    'save status saved after editing the enabled note',
    tracked.last,
  )
  await boot.page.waitForTimeout(800)
  await scrollEditorIntoView(app)
  const saved = await collectState(boot)
  await shot(boot, `${PREFIX}_e2_editor_saved_${width}`)
  const raw = await stats()
  check(
    'e2.exactly_one_enable_request',
    (raw.enable_requests || []).length === 1,
    '1 POST .../editing request for the enable',
    (raw.enable_requests || []).map((entry) => ({ outcome: entry.outcome, status: entry.status })),
  )
  check(
    'e2.enable_request_succeeded',
    (raw.enable_requests || [])[0] &&
      (raw.enable_requests || [])[0].outcome === 'success' &&
      (raw.enable_requests || [])[0].status === 200,
    'enable request outcome success / status 200',
    (raw.enable_requests || [])[0],
  )
  const enabledNote = await currentNote(FIXTURE.legacyNoteId)
  check(
    'e2.server_note_now_protected',
    enabledNote && enabledNote.edit_schema === 'd2-v1' && enabledNote.revision >= 1,
    'server note edit_schema=d2-v1 with a revision',
    enabledNote && { edit_schema: enabledNote.edit_schema, revision: enabledNote.revision },
  )
  check(
    'e2.enabled_note_saved_content',
    enabledNote && String(enabledNote.content).includes(marker),
    'enabled note content saved through the d2-v1 editor',
    enabledNote && { revision: enabledNote.revision, containsMarker: String(enabledNote.content).includes(marker) },
  )
  check(
    'e2.save_request_was_d2',
    (raw.saves || []).some((entry) => entry.note_id === FIXTURE.legacyNoteId && entry.selected === true && entry.status === 200),
    'in-place editor used the d2-v1 revision-aware PATCH (selected=true, 200)',
    (raw.saves || []).map((entry) => ({ note_id: entry.note_id, selected: entry.selected, status: entry.status })),
  )
  log(`${PREFIX} ${scene} console-errors=${JSON.stringify(boot.errors)} expected-http-errors=${JSON.stringify(boot.expectedHttpErrors)}`)
  check('e2.no_console_or_page_errors', boot.errors.length === 0, [], boot.errors)
  await boot.context.close()
  return { id: scene, width, note_mode: 'editor_on', enable_mode: 'success', marker, stats: statsSummary(raw), assertions: items }
}

async function sceneE3(browser, width, height) {
  const scene = 'E3'
  const { items, check } = makeAssert()
  await resetHarness({ noteMode: 'editor_off', enableMode: 'success' })
  const boot = await bootApp(browser, width, height)
  const app = boot.app
  await openNotes(app)
  const hovered = await hoverRow(app, FIXTURE.legacyNoteId)
  check('e3.row_hovered', hovered, 'legacy row hover works', hovered)
  const state = await collectState(boot)
  check(
    'e3.capability_off_known',
    state.counts.note_catalog >= 1,
    'Notes catalog rendered with the capability projection loaded',
    state.counts.note_catalog,
  )
  const raw = await stats()
  check(
    'e3.models_request_seen',
    (raw.models_requests || 0) >= 1,
    '/models capability projection requested',
    raw.models_requests,
  )
  if (PHASE === 'before') {
    check(
      'e3.before_no_enable_entry',
      state.counts.note_enable === 0,
      '0 note-enable-* testids with note_editor.available=false (baseline gap)',
      { enable: state.counts.note_enable, testids: state.enableTestids },
    )
  } else {
    check(
      'e3.after_no_enable_entry_when_capability_off',
      state.counts.note_enable === 0,
      'enable entry hidden when note_editor.available=false',
      { enable: state.counts.note_enable, testids: state.enableTestids },
    )
  }
  // Old unprotected note form stays valid when the capability is off.
  const clicked = await clickRowAction(app, FIXTURE.legacyNoteId, 'Edit')
  check('e3.legacy_edit_action_clicked', clicked.clicked, 'legacy row Edit button clicked', clicked)
  const formOpen = await waitFor(async () => (await count(app, HOOKS.legacyFormHint[0])) > 0, 15000)
  check('e3.legacy_form_kept', Boolean(formOpen), 'legacy-note-form-hint >= 1 (old form unchanged)', formOpen)
  const formState = await app
    .evaluate(() => {
      const title = document.querySelector('#note-title')
      const content = document.querySelector('#note-content')
      return { title: title ? title.value : null, content: content ? content.value : null }
    })
    .catch(() => null)
  check(
    'e3.legacy_form_prefilled',
    formState &&
      formState.title === FIXTURE.legacyTitle &&
      typeof formState.content === 'string' &&
      formState.content.includes(FIXTURE.legacyContentMarker),
    'old form prefilled with the legacy note content',
    formState && { title: formState.title, contentPrefix: formState.content?.slice(0, 60) },
  )
  check(
    'e3.no_protected_editor_with_form',
    state.counts.note_editor === 0,
    'no d2-v1 protected editor for the legacy note in this flow',
    state.counts.note_editor,
  )
  await shot(boot, `${PREFIX}_e3_capability_off_legacy_form_${width}`)
  log(`${PREFIX} ${scene} console-errors=${JSON.stringify(boot.errors)} expected-http-errors=${JSON.stringify(boot.expectedHttpErrors)}`)
  check('e3.no_console_or_page_errors', boot.errors.length === 0, [], boot.errors)
  await boot.context.close()
  return { id: scene, width, note_mode: 'editor_off', enable_mode: 'success', stats: statsSummary(raw), assertions: items }
}

// ── AFTER-only error/unknown scenes ───────────────────────────────────────
async function sceneE4(browser, width, height) {
  const scene = 'E4'
  const { items, check } = makeAssert()
  await resetHarness({ noteMode: 'editor_on', enableMode: 'restricted403' })
  const boot = await bootApp(browser, width, height)
  const app = boot.app
  await openNotes(app)
  const clicked = await clickEnableEntry(app, FIXTURE.legacyNoteId)
  check('e4.enable_entry_clicked', clicked.clicked, 'enable entry clicked', clicked)
  await waitFor(async () => (await count(app, HOOKS.dialog[0])) > 0, 15000)
  const confirmed = await clickDialogButton(app, HOOKS.confirm)
  check('e4.confirm_clicked', confirmed.clicked, 'confirm clicked', confirmed)
  const errorShown = await waitFor(async () => (await count(app, HOOKS.error[0])) > 0, 25000)
  check('e4.error_state_shown', Boolean(errorShown), 'note-enable-error >= 1 (403 restricted)', Boolean(errorShown))
  const state = await collectState(boot)
  log(`${PREFIX} ${scene} state=${JSON.stringify({ counts: state.counts, error: state.enableError })}`)
  check(
    'e4.error_has_failure_kind',
    state.enableError && typeof state.enableError.failure_kind === 'string' && state.enableError.failure_kind.length > 0,
    'note-enable-error exposes a non-empty data-failure-kind',
    state.enableError,
  )
  check(
    'e4.error_kind_is_restricted',
    state.enableError && state.enableError.failure_kind === 'restricted',
    'note-enable-error data-failure-kind=restricted',
    state.enableError,
  )
  check(
    'e4.error_dialog_stays_open',
    state.counts.note_enable_dialog >= 1 && state.dialogPhase === 'error',
    'error stays in the dialog (data-phase=error) so the user sees the terminal reason',
    { dialog: state.counts.note_enable_dialog, phase: state.dialogPhase },
  )
  check(
    'e4.no_retry_for_terminal_error',
    state.counts.note_enable_retry === 0,
    'terminal 403 exposes no retry action',
    { retry: state.counts.note_enable_retry, testids: state.enableTestids },
  )
  await shot(boot, `${PREFIX}_e4_restricted_error_${width}`)
  const raw = await stats()
  check(
    'e4.single_restricted_request',
    (raw.enable_requests || []).length === 1 &&
      (raw.enable_requests || [])[0].status === 403 &&
      (raw.enable_requests || [])[0].outcome === 'restricted',
    '1 POST .../editing → 403 restricted',
    (raw.enable_requests || []).map((entry) => ({ outcome: entry.outcome, status: entry.status })),
  )
  check(
    'e4.no_semantic_change',
    (raw.enable_applies || []).length === 0,
    '0 applied enable changes on failure',
    (raw.enable_applies || []).length,
  )
  const note = await currentNote(FIXTURE.legacyNoteId)
  check(
    'e4.note_still_unprotected',
    note && note.edit_schema === null,
    'note stays unprotected after the 403',
    note && note.edit_schema,
  )
  log(`${PREFIX} ${scene} console-errors=${JSON.stringify(boot.errors)} expected-http-errors=${JSON.stringify(boot.expectedHttpErrors)}`)
  check('e4.no_console_or_page_errors', boot.errors.length === 0, [], boot.errors)
  await boot.context.close()
  return { id: scene, width, note_mode: 'editor_on', enable_mode: 'restricted403', stats: statsSummary(raw), assertions: items }
}

async function sceneE5(browser, width, height) {
  const scene = 'E5'
  const { items, check } = makeAssert()
  await resetHarness({ noteMode: 'editor_on', enableMode: 'dependency503' })
  const boot = await bootApp(browser, width, height)
  const app = boot.app
  await openNotes(app)
  const clicked = await clickEnableEntry(app, FIXTURE.legacyNoteId)
  check('e5.enable_entry_clicked', clicked.clicked, 'enable entry clicked', clicked)
  await waitFor(async () => (await count(app, HOOKS.dialog[0])) > 0, 15000)
  const confirmed = await clickDialogButton(app, HOOKS.confirm)
  check('e5.confirm_clicked', confirmed.clicked, 'confirm clicked', confirmed)
  const errorShown = await waitFor(async () => (await count(app, HOOKS.error[0])) > 0, 25000)
  check('e5.error_state_shown', Boolean(errorShown), 'note-enable-error >= 1 (503 dependency)', Boolean(errorShown))
  const errorState = await collectState(boot)
  check(
    'e5.error_kind_is_unavailable',
    errorState.enableError && errorState.enableError.failure_kind === 'unavailable',
    'note-enable-error data-failure-kind=unavailable (retryable dependency)',
    errorState.enableError,
  )
  check(
    'e5.error_dialog_stays_open',
    errorState.counts.note_enable_dialog >= 1 && errorState.dialogPhase === 'error',
    'error stays in the dialog (data-phase=error) with the retry action',
    { dialog: errorState.counts.note_enable_dialog, phase: errorState.dialogPhase },
  )
  check(
    'e5.retry_offered',
    errorState.counts.note_enable_retry >= 1,
    'retry action offered for the retryable 503',
    errorState.counts.note_enable_retry,
  )
  await shot(boot, `${PREFIX}_e5_dependency_error_${width}`)
  const retried = await clickDialogButton(app, HOOKS.retry)
  check('e5.retry_clicked', retried.clicked, 'note-enable-retry clicked', retried)
  const editorReady = await afterEditorReady(app, 40000)
  check('e5.editor_opened_after_retry', Boolean(editorReady), 'editor opened after retrying the 503', Boolean(editorReady))
  await boot.page.waitForTimeout(1200)
  await scrollEditorIntoView(app)
  await shot(boot, `${PREFIX}_e5_retry_editor_${width}`)
  const opened = await collectState(boot)
  check(
    'e5.editor_title_unchanged',
    opened.editor && opened.editor.title === FIXTURE.legacyTitle,
    'editor title unchanged after retry success',
    opened.editor && opened.editor.title,
  )
  check(
    'e5.editor_revision_shown',
    opened.counts.note_editor_revision >= 1,
    'revision shown after retry success',
    opened.counts.note_editor_revision,
  )
  const raw = await stats()
  check(
    'e5.two_attempts_recorded',
    (raw.enable_requests || []).length === 2,
    '2 POST .../editing attempts recorded (failure + retry)',
    (raw.enable_requests || []).map((entry) => ({ outcome: entry.outcome, status: entry.status })),
  )
  check(
    'e5.first_retryable_second_success',
    (raw.enable_requests || [])[0] &&
      (raw.enable_requests || [])[0].status === 503 &&
      (raw.enable_requests || [])[1] &&
      (raw.enable_requests || [])[1].status === 200,
    'first attempt 503, retry 200',
    (raw.enable_requests || []).map((entry) => entry.status),
  )
  check(
    'e5.exactly_one_semantic_change',
    (raw.enable_applies || []).length === 1,
    'exactly one applied enable change',
    (raw.enable_applies || []).length,
  )
  log(`${PREFIX} ${scene} console-errors=${JSON.stringify(boot.errors)} expected-http-errors=${JSON.stringify(boot.expectedHttpErrors)}`)
  check('e5.no_console_or_page_errors', boot.errors.length === 0, [], boot.errors)
  await boot.context.close()
  return { id: scene, width, note_mode: 'editor_on', enable_mode: 'dependency503', stats: statsSummary(raw), assertions: items }
}

async function sceneE6(browser, width, height) {
  const scene = 'E6'
  const { items, check } = makeAssert()
  await resetHarness({ noteMode: 'editor_on', enableMode: 'unknown503_apply' })
  const boot = await bootApp(browser, width, height)
  const app = boot.app
  await openNotes(app)
  const clicked = await clickEnableEntry(app, FIXTURE.legacyNoteId)
  check('e6.enable_entry_clicked', clicked.clicked, 'enable entry clicked', clicked)
  await waitFor(async () => (await count(app, HOOKS.dialog[0])) > 0, 15000)
  const confirmed = await clickDialogButton(app, HOOKS.confirm)
  check('e6.confirm_clicked', confirmed.clicked, 'confirm clicked', confirmed)
  const unknownShown = await waitFor(async () => (await count(app, HOOKS.error[0])) > 0, 25000)
  check('e6.unknown_state_shown', Boolean(unknownShown), 'note-enable-error >= 1 (unknown result)', Boolean(unknownShown))
  const unknownState = await collectState(boot)
  log(`${PREFIX} ${scene} unknown=${JSON.stringify({ counts: unknownState.counts, error: unknownState.enableError, retryLabel: unknownState.retryLabel })}`)
  check(
    'e6.unknown_kind_reported',
    unknownState.enableError && unknownState.enableError.failure_kind === 'unknown',
    'note-enable-error data-failure-kind=unknown (outcome could not be confirmed)',
    unknownState.enableError,
  )
  check(
    'e6.unknown_dialog_stays_open',
    unknownState.counts.note_enable_dialog >= 1 && unknownState.dialogPhase === 'error',
    'unknown result stays in the dialog (data-phase=error)',
    { dialog: unknownState.counts.note_enable_dialog, phase: unknownState.dialogPhase },
  )
  // The unknown path's action label is the "Confirm result" copy
  // (research.notes.enable.confirmResult); it may be a dedicated testid or the
  // retry slot with a different label — both are accepted here.
  const confirmResultSelector =
    (await findFirst(app, HOOKS.confirmResult)).selector ||
    (unknownState.counts.note_enable_retry >= 1 ? HOOKS.retry[0] : null)
  check(
    'e6.confirm_result_action_present',
    Boolean(confirmResultSelector),
    'unknown state exposes a "confirm result" action',
    { selector: confirmResultSelector, testids: unknownState.enableTestids, retryLabel: unknownState.retryLabel },
  )
  check(
    'e6.confirm_result_label_is_dedicated',
    confirmResultSelector !== null &&
      (HOOKS.confirmResult.includes(confirmResultSelector) ||
        /confirm result/i.test(unknownState.retryLabel || '')),
    'the unknown-state action uses the dedicated confirmResult copy ("Confirm result")',
    unknownState.retryLabel,
  )
  await shot(boot, `${PREFIX}_e6_unknown_result_${width}`)
  const firstStats = await stats()
  check(
    'e6.first_attempt_recorded_unknown',
    (firstStats.enable_requests || []).length === 1 &&
      (firstStats.enable_requests || [])[0].status === 503 &&
      (firstStats.enable_requests || [])[0].outcome === 'unknown_applied',
    'first attempt applied the enable but returned 503 (unknown)',
    (firstStats.enable_requests || []).map((entry) => ({ outcome: entry.outcome, status: entry.status })),
  )
  check(
    'e6.mutation_id_present',
    (firstStats.enable_requests || [])[0] &&
      typeof (firstStats.enable_requests || [])[0].mutation_id === 'string' &&
      (firstStats.enable_requests || [])[0].mutation_id.length > 0,
    'first attempt carries a mutation_id',
    (firstStats.enable_requests || [])[0] && (firstStats.enable_requests || [])[0].mutation_id,
  )
  const firstMutationId = (firstStats.enable_requests || [])[0]?.mutation_id || null

  const confirmResult = await clickDialogButton(app, HOOKS.confirmResult, /confirm/i)
  check('e6.confirm_result_clicked', confirmResult.clicked, 'confirm-result action clicked', confirmResult)
  const editorReady = await afterEditorReady(app, 40000)
  check('e6.editor_opened_after_confirm_result', Boolean(editorReady), 'editor opened after confirming the unknown result', Boolean(editorReady))
  await boot.page.waitForTimeout(1200)
  await scrollEditorIntoView(app)
  await shot(boot, `${PREFIX}_e6_confirmed_editor_${width}`)
  const opened = await collectState(boot)
  check(
    'e6.editor_title_unchanged',
    opened.editor && opened.editor.title === FIXTURE.legacyTitle,
    'editor title unchanged after confirming the unknown result',
    opened.editor && opened.editor.title,
  )
  check(
    'e6.editor_content_unchanged',
    opened.editor && opened.editor.contentContainsFixture,
    'editor content unchanged after confirming the unknown result',
    opened.editor && opened.editor.contentTail,
  )
  check(
    'e6.editor_revision_is_one',
    /revision\s*1\b/i.test((opened.editor || {}).revision || ''),
    'revision stays 1 (single semantic change)',
    opened.editor && opened.editor.revision,
  )
  const raw = await stats()
  const requests = raw.enable_requests || []
  check(
    'e6.two_requests_recorded',
    requests.length === 2,
    '2 POST .../editing requests recorded',
    requests.map((entry) => ({ outcome: entry.outcome, status: entry.status })),
  )
  check(
    'e6.same_mutation_id_replayed',
    requests.length === 2 &&
      requests[0].mutation_id === firstMutationId &&
      requests[1].mutation_id === firstMutationId,
    'both attempts used the SAME mutation_id',
    requests.map((entry) => entry.mutation_id),
  )
  check(
    'e6.second_attempt_replayed_receipt',
    requests[1] && requests[1].outcome === 'replayed' && requests[1].status === 200,
    'second attempt is a receipt replay (200 replayed)',
    requests[1],
  )
  check(
    'e6.exactly_one_semantic_change',
    (raw.enable_applies || []).length === 1 && raw.enable_semantic_changes === 1,
    'exactly one semantic enable change (no double apply)',
    { applies: (raw.enable_applies || []).length, semantic_changes: raw.enable_semantic_changes },
  )
  const note = await currentNote(FIXTURE.legacyNoteId)
  check(
    'e6.final_state_single_protected_document',
    note && note.edit_schema === 'd2-v1' && note.revision === 1,
    'final state: the SAME note id is protected at revision 1 (no duplicate document)',
    note && { note_id: note.note_id, edit_schema: note.edit_schema, revision: note.revision },
  )
  const createdNotes = (raw.notes || []).length
  check(
    'e6.no_duplicate_note_created',
    createdNotes === 2,
    'store still contains exactly the 2 fixture notes (no duplicate document)',
    raw.notes,
  )
  log(`${PREFIX} ${scene} console-errors=${JSON.stringify(boot.errors)} expected-http-errors=${JSON.stringify(boot.expectedHttpErrors)}`)
  check('e6.no_console_or_page_errors', boot.errors.length === 0, [], boot.errors)
  await boot.context.close()
  return {
    id: scene,
    width,
    note_mode: 'editor_on',
    enable_mode: 'unknown503_apply',
    mutation_ids: requests.map((entry) => entry.mutation_id),
    stats: statsSummary(raw),
    assertions: items,
  }
}

// ── E7 Admin read-only (both phases) ──────────────────────────────────────
async function sceneE7(browser, width, height) {
  const scene = 'E7'
  const { items, check } = makeAssert()
  await resetHarness({ noteMode: 'editor_on', enableMode: 'success' })
  const boot = await bootApp(browser, width, height, { role: 'admin_readonly' })
  const app = boot.app
  await openNotes(app)
  await hoverRow(app, FIXTURE.legacyNoteId)
  const state = await collectState(boot)
  log(`${PREFIX} ${scene} state=${JSON.stringify({ counts: state.counts, rows: state.rows })}`)
  check(
    'e7.admin_banner_visible',
    state.counts.admin_readonly_banner >= 1,
    'admin-readonly-banner visible for the synthetic admin_readonly token',
    state.counts.admin_readonly_banner,
  )
  check(
    'e7.no_enable_entry_for_admin',
    state.counts.note_enable === 0,
    'no note-enable-* entry for an Admin read-only session',
    { enable: state.counts.note_enable, testids: state.enableTestids },
  )
  const legacyButtons = (state.rows[FIXTURE.legacyNoteId] || {}).row_buttons || []
  check(
    'e7.no_legacy_write_actions_for_admin',
    !legacyButtons.includes('Edit') && !legacyButtons.includes('Delete'),
    'admin read-only session exposes no legacy Edit/Delete write actions',
    legacyButtons,
  )
  check(
    'e7.no_catalog_create_for_admin',
    (await count(app, '[data-testid="note-catalog-new"]')) === 0,
    'admin read-only session exposes no New note button',
    await count(app, '[data-testid="note-catalog-new"]'),
  )
  await shot(boot, `${PREFIX}_e7_admin_readonly_${width}`)
  const raw = await stats()
  check(
    'e7.no_enable_request_for_admin',
    (raw.enable_requests || []).length === 0,
    'no editing request emitted by an Admin read-only session',
    (raw.enable_requests || []).length,
  )
  log(`${PREFIX} ${scene} console-errors=${JSON.stringify(boot.errors)} expected-http-errors=${JSON.stringify(boot.expectedHttpErrors)}`)
  check('e7.no_console_or_page_errors', boot.errors.length === 0, [], boot.errors)
  await boot.context.close()
  return { id: scene, width, note_mode: 'editor_on', role: 'admin_readonly', stats: statsSummary(raw), assertions: items }
}

// ── E8 capability read failure (both phases) ──────────────────────────────
async function sceneE8(browser, width, height) {
  const scene = 'E8'
  const { items, check } = makeAssert()
  await resetHarness({ noteMode: 'models_error', enableMode: 'success' })
  const boot = await bootApp(browser, width, height)
  const app = boot.app
  await openNotes(app)
  const blocked = await waitFor(async () => (await count(app, HOOKS.capabilityBlocked[0])) > 0, 30000)
  check(
    'e8.capability_blocked_shown',
    Boolean(blocked),
    'note-capability-blocked fail-closed hint rendered when /models fails',
    Boolean(blocked),
  )
  await hoverRow(app, FIXTURE.legacyNoteId)
  const state = await collectState(boot)
  log(`${PREFIX} ${scene} state=${JSON.stringify({ counts: state.counts, rows: state.rows })}`)
  check(
    'e8.no_enable_entry_on_capability_failure',
    state.counts.note_enable === 0,
    'no enable entry when the capability projection cannot be read (fail-closed)',
    { enable: state.counts.note_enable, testids: state.enableTestids },
  )
  check(
    'e8.capability_retry_offered',
    state.counts.note_capability_blocked >= 1 &&
      (await count(app, HOOKS.capabilityRetry[0])) >= 1,
    'capability blocked state offers a retry for the projection',
    {
      blocked: state.counts.note_capability_blocked,
      retry: await count(app, HOOKS.capabilityRetry[0]),
    },
  )
  await shot(boot, `${PREFIX}_e8_capability_error_${width}`)
  const raw = await stats()
  check(
    'e8.models_request_failed_and_observed',
    (raw.models_requests || 0) >= 1,
    '/models request attempted and failed (synthetic 500)',
    raw.models_requests,
  )
  check(
    'e8.no_enable_request',
    (raw.enable_requests || []).length === 0,
    'no editing request emitted while capabilities are unreadable',
    (raw.enable_requests || []).length,
  )
  log(`${PREFIX} ${scene} console-errors=${JSON.stringify(boot.errors)} expected-http-errors=${JSON.stringify(boot.expectedHttpErrors)}`)
  check('e8.no_unexpected_console_or_page_errors', boot.errors.length === 0, [], boot.errors)
  await boot.context.close()
  return { id: scene, width, note_mode: 'models_error', stats: statsSummary(raw), assertions: items }
}

const BEFORE_SCENES = { e1: sceneE1, e2: sceneE2Before, e3: sceneE3, e7: sceneE7, e8: sceneE8 }
const AFTER_SCENES = {
  e1: sceneE1,
  e2: sceneE2After,
  e3: sceneE3,
  e4: sceneE4,
  e5: sceneE5,
  e6: sceneE6,
  e7: sceneE7,
  e8: sceneE8,
}
/** Scenes the baseline cannot exercise (no enable mutation at all). */
const BEFORE_NA_SCENES = {
  e4: 'N/A — baseline has no enable entry/mutation, so a 403 restricted test of the enable flow does not exist',
  e5: 'N/A — baseline has no enable entry/mutation, so a 503 dependency + retry test of the enable flow does not exist',
  e6: 'N/A — baseline has no enable entry/mutation, so the unknown-result / same-mutation replay test does not exist',
}

const SCENES = PHASE === 'before' ? BEFORE_SCENES : AFTER_SCENES
const SCENE_IDS = ONLY_SCENES.length > 0 ? ONLY_SCENES.map((id) => id.toLowerCase()) : Object.keys(SCENES)

async function main() {
  banner(`Issue #1135 ${PHASE} capture — head=${HEAD} host=${HOST} widths=${WIDTHS.join(',')}`)
  log(`${PREFIX} env: node=${process.version} chrome=${CHROME} gateway=${GATEWAY} evidence=${EVIDENCE_ROOT}`)
  log(`${PREFIX} before_na_scenes=${JSON.stringify(PHASE === 'before' ? BEFORE_NA_SCENES : {})}`)
  const browser = await chromium.launch({
    executablePath: CHROME,
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--force-color-profile=srgb'],
  })
  try {
    for (const width of WIDTHS) {
      const height = heightFor(width)
      for (const sceneId of SCENE_IDS) {
        const fn = SCENES[sceneId]
        if (!fn) {
          log(`${PREFIX} unknown scene ${sceneId}`)
          continue
        }
        banner(`scene ${sceneId.toUpperCase()} @ ${width}x${height}`)
        const started = Date.now()
        try {
          const result = await fn(browser, width, height)
          result.duration_ms = Date.now() - started
          sceneResults.push(result)
        } catch (error) {
          log(`${PREFIX} ${sceneId} SCENE-ERROR ${String(error && error.stack ? error.stack : error).slice(0, 1200)}`)
          sceneResults.push({
            id: sceneId.toUpperCase(),
            width,
            error: String(error && error.message ? error.message : error).slice(0, 500),
            assertions: [],
          })
        }
      }
    }
  } finally {
    await browser.close()
  }

  const allAssertions = sceneResults.flatMap((scene) =>
    (scene.assertions || []).map((item) => ({ scene: scene.id, width: scene.width, ...item })),
  )
  const pass = allAssertions.filter((item) => item.ok).length
  const fail = allAssertions.length - pass
  const scenesWithErrors = sceneResults.filter((scene) => scene.error)

  const manifest = {
    ticket: 'HiFiBiO-Therapeutics/RDLens#1135',
    title: '受保护编辑启用入口（旧未保护 Note → d2-v1 原地启用）— fork visual evidence',
    evidence_kind: 'synthetic',
    synthetic_declaration:
      'Real fork Next.js app (next dev --webpack, embedded iframe) + synthetic host page + route-mocked Research Gateway. No real RDLens host, PostgreSQL, SurrealDB, files, models, Feishu content, users or private data. All note titles/ids/content are [synthetic] fixtures (project p1, viewer 1, fabricated claims-only token).',
    phase: PHASE,
    head: HEAD,
    baseline: 'fork origin/main 34f531d (post-#1136)',
    captured_at: new Date().toISOString(),
    host_url: HOST,
    gateway: GATEWAY,
    note_mode_file: NOTE_MODE_FILE,
    enable_mode_file: ENABLE_MODE_FILE,
    before_na_scenes: PHASE === 'before' ? BEFORE_NA_SCENES : {},
    env: {
      chrome: CHROME,
      node: process.version,
      widths: WIDTHS,
      viewports: Object.fromEntries(WIDTHS.map((width) => [String(width), `${width}x${heightFor(width)}`])),
      device_scale_factor: 1,
      color_scheme: 'light',
      locale: 'en-US',
      fresh_browser_context_per_scene: true,
      harness_only_config_patch:
        'frontend/src/lib/embedded/config.ts static NEXT_PUBLIC_* member access (Next dev does not inline dynamic env lookups); reverted after capture',
    },
    scenes: sceneResults,
    totals: {
      scenes: sceneResults.length,
      scene_errors: scenesWithErrors.length,
      assertions: allAssertions.length,
      assertions_pass: pass,
      assertions_fail: fail,
    },
    screenshots: shots,
  }
  fs.writeFileSync(MANIFEST_FILE, `${JSON.stringify(manifest, null, 2)}\n`)
  banner(`RESULT ${PHASE}: ${pass} PASS / ${fail} FAIL / ${scenesWithErrors.length} scene errors`)
  log(`${PREFIX} manifest=${MANIFEST_FILE}`)
  log(`${PREFIX} screenshots=${shots.length} (${shots.map((item) => item.file).join(', ')})`)
  log(`${PREFIX} assertions-json=${JSON.stringify(allAssertions.map(({ name, ok }) => ({ name, ok })))}`)
  if (fail > 0 || scenesWithErrors.length > 0) process.exitCode = 2
}

main().catch((error) => {
  log(`${PREFIX} FATAL ${String(error && error.stack ? error.stack : error)}`)
  process.exit(1)
})
