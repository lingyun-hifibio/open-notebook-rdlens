#!/usr/bin/env node
/**
 * Before/After visual + browser-behaviour capture for Issue #1136
 * ("应用内父级导航的离开保护", ResearchWorkbench layer, fork frontend).
 *
 * Synthetic harness only: the real fork Next.js app (next dev --webpack) in
 * embedded mode + a synthetic host iframe + a route-mocked Research Gateway.
 * No real RDLens host, database, files, models, patients or private data;
 * every title/id/token is synthetic (`[synthetic]` markers, fixture project
 * p1/p2, viewer 1).
 *
 * Scenes (each at every requested width, fresh browser context per scene,
 * gateway `/__reset` first, save mode driven by /tmp/issue1046-save-mode):
 *   R1 pane-switch with unsaved content that cannot be saved (unknown503)
 *   R2 project switch p1 -> p2 -> p1 with the same unsaved-failure state
 *   R3 full host page reload with the same unsaved-failure state
 *   R4 version conflict state (save mode conflict), then pane switch away/back
 *   R5 steady-state control: successful autosave, then pane switch away/back
 *
 * BEFORE = fork origin/main a4a76170c (PR4 editor, no parent-navigation
 * recovery surface). AFTER = implementation head (Lead-provided SHA).
 *
 * Usage:
 *   node capture.js --phase=before --host=http://127.0.0.1:8972/ --head=<sha>
 *   node capture.js --phase=after  --host=http://127.0.0.1:8974/ --head=<sha>
 * Optional: --widths=1440,1024 --scenes=r1,r5 --outdir=<dir> --logfile=<file>
 */
const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')
const crypto = require('node:crypto')
const { chromium } = require('/home/lchen/workspace/RDLens/scripts/e2e/node_modules/playwright-core')

const CHROME = '/home/lchen/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome'
const EVIDENCE_ROOT = path.resolve(__dirname, '..') // dev_docs/validation/issue-1136
const NOTE_MODE_FILE = '/tmp/issue1046-note-mode'
const SAVE_MODE_FILE = '/tmp/issue1046-save-mode'
const GATEWAY = process.env.ISSUE1136_GATEWAY || 'http://127.0.0.1:8941'
const NOTE_CACHE_PREFIX = 'rdlens.research.note.v1'

const arg = (name, fallback) => {
  const hit = process.argv.find((item) => item.startsWith(`--${name}=`))
  return hit ? hit.split('=').slice(1).join('=') : fallback
}
const PHASE = arg('phase', 'before')
const PREFIX = PHASE === 'after' ? 'after' : 'before'
const HOST = arg('host', PHASE === 'after' ? 'http://127.0.0.1:8974/' : 'http://127.0.0.1:8972/')
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
const stamp = () => `${Date.now() % 1000000}`
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
const stats = async () => (await gatewayCall('GET', '/__stats')).body || {}
const currentNote = async (noteId) =>
  (await gatewayCall('GET', `/__note?note_id=${encodeURIComponent(noteId)}`)).body
const bumpNote = async (noteId) =>
  (await gatewayCall('GET', `/__bump?note_id=${encodeURIComponent(noteId)}`)).body

async function resetHarness(saveMode, noteMode = 'editor_on') {
  fs.writeFileSync(NOTE_MODE_FILE, noteMode)
  fs.writeFileSync(SAVE_MODE_FILE, saveMode)
  await gatewayCall('GET', '/__reset')
  log(`${PREFIX} harness reset: note_mode=${noteMode} save_mode=${saveMode}`)
}

function statsSummary(raw) {
  if (!raw) return null
  return {
    models_requests: raw.models_requests,
    creates: raw.creates,
    copies: (raw.copies || []).length,
    saves: (raw.saves || []).map((entry) => ({
      note_id: entry.note_id,
      mutation_id: entry.mutation_id,
      expected_revision: entry.expected_revision,
      mode: entry.mode,
      status: entry.status,
    })),
    notes: (raw.notes || []).map((note) => `${note.note_id}@r${note.revision}`),
    note_requests: (raw.note_requests || []).length,
  }
}

// ── DOM hooks (BEFORE has no inbox; AFTER may add inbox hooks) ────────────
const HOOKS = {
  groupNav: ['[data-testid="workbench-group-nav"]'],
  catalog: ['[data-testid="note-catalog"]'],
  editor: ['[data-testid="note-editor"]'],
  content: [
    'textarea.w-md-editor-text-input',
    '#note-editor-markdown',
    '[data-testid="note-editor-content"] textarea.w-md-editor-text-input',
  ],
  title: ['[data-testid="note-editor-title"]'],
  saveStatus: ['[data-testid="note-save-status"]'],
  draftRestored: ['[data-testid="note-draft-restored"]'],
  draftBanner: ['[data-testid="note-draft-recovery-banner"]'],
  conflict: ['[data-testid="note-conflict-dialog"]'],
  conflictKeepEditing: ['[data-testid="note-conflict-keep-editing"]'],
  leaveGuard: ['[data-testid="note-leave-guard-dialog"]'],
  leaveStay: ['[data-testid="note-leave-stay"]'],
  projectName: ['[data-testid="rdlens-target-project-name"]'],
  recoveryInbox: [
    '[data-testid="note-recovery-inbox"]',
    '[data-testid="note-recovery-banner"]',
    '[data-testid="note-catalog-recovery"]',
  ],
  openButton: (noteId) => `[data-testid="note-open-${noteId}"]`,
  recoveryRow: (noteId) => `[data-testid="note-recovery-row-${noteId}"]`,
  recoveryTitle: (noteId) => `[data-testid="note-recovery-title-${noteId}"]`,
  recoveryOpen: (noteId) => `[data-testid="note-recovery-open-${noteId}"]`,
  recoveryCopy: (noteId) => `[data-testid="note-recovery-copy-${noteId}"]`,
  recoveryDownload: (noteId) => `[data-testid="note-recovery-download-${noteId}"]`,
  recoveryRowPrefix: '[data-testid^="note-recovery-row-"]',
  recoveryTitlePrefix: '[data-testid^="note-recovery-title-"]',
  recoveryOpenPrefix: '[data-testid^="note-recovery-open-"]',
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

/** All per-screenshot evidence: testid counts + text/content presence. */
async function collectState(boot) {
  const { app, page } = boot
  const counts = {
    note_recovery_inbox: 0,
    note_recovery_rows: 0,
    note_recovery_titles: 0,
    note_recovery_opens: 0,
    note_draft_restored: 0,
    note_draft_recovery_banner: 0,
    note_editor: 0,
    note_catalog: 0,
    note_conflict_dialog: 0,
    note_save_status: 0,
    workbench_group_nav: 0,
  }
  for (const selector of HOOKS.recoveryInbox) counts.note_recovery_inbox += await count(app, selector)
  counts.note_recovery_rows = await count(app, HOOKS.recoveryRowPrefix)
  counts.note_recovery_titles = await count(app, HOOKS.recoveryTitlePrefix)
  counts.note_recovery_opens = await count(app, HOOKS.recoveryOpenPrefix)
  const simpleCounts = {
    note_draft_restored: 'draftRestored',
    note_draft_recovery_banner: 'draftBanner',
    note_editor: 'editor',
    note_catalog: 'catalog',
    note_conflict_dialog: 'conflict',
    note_save_status: 'saveStatus',
    workbench_group_nav: 'groupNav',
  }
  for (const [key, hookName] of Object.entries(simpleCounts)) {
    for (const selector of HOOKS[hookName]) counts[key] += await count(app, selector)
  }
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
  const editorContent = await app
    .evaluate(() => {
      const node = document.querySelector('textarea.w-md-editor-text-input')
      return node ? node.value.slice(-400) : null
    })
    .catch(() => null)
  const inboxTestids = await app
    .evaluate(() =>
      [...document.querySelectorAll('[data-testid^="note-recovery-"]')]
        .map((node) => node.getAttribute('data-testid'))
        .slice(0, 20),
    )
    .catch(() => [])
  const projectName = await app
    .evaluate(() => {
      const node = document.querySelector('[data-testid="rdlens-target-project-name"]')
      return node
        ? {
            text: (node.textContent || '').trim(),
            source: node.getAttribute('data-project-source'),
          }
        : null
    })
    .catch(() => null)
  const storageKeys = await app
    .evaluate((prefix) => Object.keys(window.localStorage || {}).filter((key) => key.startsWith(prefix)),
      NOTE_CACHE_PREFIX,
    )
    .catch(() => [])
  const bodyText = await app
    .evaluate(() => (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 2500))
    .catch(() => '')
  return {
    url: app.url(),
    counts,
    inboxTestids,
    saveStatus,
    editorContentTail: editorContent,
    projectName,
    noteDraftStorageKeys: storageKeys,
    bodyText,
  }
}

const hasText = (state, needle) =>
  typeof state.bodyText === 'string' && state.bodyText.toLowerCase().includes(needle.toLowerCase())
const editorHas = (state, needle) =>
  typeof state.editorContentTail === 'string' &&
  state.editorContentTail.toLowerCase().includes(needle.toLowerCase())

async function shot(boot, name) {
  const file = path.join(OUT_DIR, `${name}.png`)
  await boot.page.screenshot({ path: file, animations: 'disabled' })
  const size = fs.statSync(file).size
  const digest = sha256File(file)
  // Gateway counters at screenshot time (per-shot request-count evidence).
  const gatewayStats = statsSummary(await stats())
  const state = await collectState(boot)
  shots.push({
    file: path.basename(file),
    bytes: size,
    sha256: digest,
    dom_counts: state.counts,
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

async function findAppFrame(page, timeoutMs = 45000) {
  const frame = await waitFor(() => {
    const app = page.frames().find((candidate) => candidate.url().includes('/research'))
    return app || false
  }, timeoutMs, 400)
  return frame
}

async function waitForWorkspace(app, timeoutMs = 60000) {
  return waitFor(async () => (await count(app, HOOKS.groupNav[0])) > 0, timeoutMs, 400)
}

async function bootApp(browser, width, height) {
  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: 1,
    colorScheme: 'light',
  })
  const page = await context.newPage()
  // `errors` = unexpected page/console errors (asserted 0).
  // `expectedHttpErrors` = Chromium's own "Failed to load resource: ... status
  // of 503/409" console entries for the *intentional* synthetic save-failure
  // modes of this harness (unknown503 / conflict). They are evidence of the
  // driven failure mode, not app errors, and are recorded separately.
  const errors = []
  const expectedHttpErrors = []
  const EXPECTED_HTTP_STATUS = /Failed to load resource: the server responded with a status of (503|409|428|403)/
  const net = { patches: [], noteGets: [], models: 0, calls: [] }
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
    // Uncommitted-save beforeunload prompts (R3 reload) are answered like a
    // user choosing "Leave"; every dialog is logged.
    log(`${PREFIX} dialog type=${dialog.type()} message=${JSON.stringify(dialog.message().slice(0, 120))} -> accept`)
    await dialog.accept().catch(() => {})
  })
  page.on('request', (request) => {
    const url = request.url()
    if (!url.includes('127.0.0.1:8941')) return
    const method = request.method()
    net.calls.push(`${method} ${url.replace(/^https?:\/\/[^/]+/, '')}`)
    if (method === 'PATCH' && /\/notes\/[^/]+$/.test(url.split('?')[0])) {
      let body = null
      try {
        body = JSON.parse(request.postData() || 'null')
      } catch {
        body = null
      }
      net.patches.push({ body, at: Date.now() })
    }
    if (/\/models$/.test(url.split('?')[0])) net.models += 1
    if (method === 'GET' && /\/notes\/[^/]+$/.test(url.split('?')[0])) {
      net.noteGets.push(url.replace(/^https?:\/\/[^/]+/, ''))
    }
  })
  await page.addInitScript(() => {
    try {
      window.__e2eHideDevOverlay = true
    } catch {
      /* ignore */
    }
  })
  await page.goto(HOST, { waitUntil: 'domcontentloaded' })
  const app = await findAppFrame(page)
  if (!app) throw new Error('app iframe frame not found')
  const ready = await waitForWorkspace(app)
  if (!ready) throw new Error('workbench did not become ready inside the iframe')
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
  return { context, page, app, errors, expectedHttpErrors, net, width, height }
}

async function openNotes(app) {
  const nav = app.locator(HOOKS.groupNav[0])
  await nav.waitFor({ timeout: 30000 })
  await app.getByRole('button', { name: 'Notes', exact: true }).click({ timeout: 15000 })
  await app
    .locator('[data-testid="note-catalog"], [data-testid="note-list-rows"]')
    .first()
    .waitFor({ timeout: 20000 })
  await app.page().waitForTimeout(1000)
}

async function openNoteFromCatalog(app, noteId) {
  const selector = HOOKS.openButton(noteId)
  const locator = app.locator(selector).first()
  if ((await locator.count().catch(() => 0)) === 0) return { opened: false, selector }
  await locator.click({ timeout: 10000 })
  await app.page().waitForTimeout(1000)
  return { opened: true, selector }
}

async function afterEditorReady(app, timeoutMs = 15000) {
  return waitFor(async () => {
    const editor = await count(app, HOOKS.editor[0])
    const content = await count(app, 'textarea.w-md-editor-text-input')
    return editor > 0 && content > 0
  }, timeoutMs, 300)
}

async function typeIntoEditor(app, text) {
  const found = await findFirst(app, HOOKS.content)
  if (found.locator === null) return false
  await found.locator.click({ timeout: 10000 })
  await found.locator.press('End')
  await found.locator.type(text, { delay: 35 })
  return true
}

async function switchPane(app, label) {
  log(`${PREFIX} pane click: ${label}`)
  await app.getByRole('button', { name: label, exact: true }).click({ timeout: 15000 })
  await app.page().waitForTimeout(1200)
}

/** Scroll the markdown textarea into view (draft-text-visible supporting shot). */
async function scrollEditorContentIntoView(app) {
  await app
    .evaluate(() => {
      const node =
        document.querySelector('#note-editor-markdown') ||
        document.querySelector('textarea.w-md-editor-text-input')
      if (node instanceof HTMLElement) node.scrollIntoView({ block: 'center' })
    })
    .catch(() => {})
  await app.page().waitForTimeout(450)
}

/** Scroll the (left-pane) editor into view so draft/banner are visible in shots. */
async function scrollEditorIntoView(app) {
  await app
    .evaluate(() => {
      const node = document.querySelector('[data-testid="note-editor"]')
      if (node instanceof HTMLElement) node.scrollIntoView({ block: 'start' })
    })
    .catch(() => {})
  await app.page().waitForTimeout(450)
}

/**
 * PR4's editor-level leave guard auto-opens when the save result is unknown
 * (`leaveBlockReason='unknown'`). It is a Radix modal and would cover the
 * parent pane-navigation buttons, so the user must first answer it (here:
 * "Stay" = keep editing with the text still local). Parent navigation itself
 * is never blocked by this dialog. Logged as part of the real UI flow.
 */
async function dismissLeaveGuardIfOpen(app, scene) {
  const opened = await count(app, HOOKS.leaveGuard[0])
  if (opened === 0) return { opened: 0, stayClicked: false, dismissed: true }
  const stay = await findFirst(app, HOOKS.leaveStay)
  let stayClicked = false
  if (stay.locator) {
    await stay.locator.click({ timeout: 8000 }).catch(() => {})
    stayClicked = true
    await app.page().waitForTimeout(600)
  }
  const remaining = await count(app, HOOKS.leaveGuard[0])
  log(`${PREFIX} ${scene} editor-leave-guard opened=${opened} stay-clicked=${stayClicked} remaining=${remaining}`)
  return { opened, stayClicked, dismissed: remaining === 0 }
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

async function trackSaveStatus(app, { targets = [], timeoutMs = 15000 } = {}) {
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

async function projectName(app) {
  return app
    .evaluate(() => {
      const node = document.querySelector('[data-testid="rdlens-target-project-name"]')
      return node
        ? {
            text: (node.textContent || '').trim(),
            source: node.getAttribute('data-project-source'),
          }
        : null
    })
    .catch(() => null)
}

async function waitForProject(app, projectLabel, timeoutMs = 30000) {
  return waitFor(async () => {
    const info = await projectName(app)
    return info && info.text.includes(projectLabel) ? info : false
  }, timeoutMs, 400)
}

/** Open the AFTER recovery row for a note (inbox hook), if present. */
async function openFromRecoveryInbox(app, noteId) {
  for (const selector of [HOOKS.recoveryOpen(noteId), HOOKS.recoveryRow(noteId), HOOKS.recoveryTitle(noteId)]) {
    const locator = app.locator(selector).first()
    if ((await locator.count().catch(() => 0)) > 0) {
      await locator.click({ timeout: 10000 })
      await app.page().waitForTimeout(1200)
      return { opened: true, selector }
    }
  }
  return { opened: false, selector: null }
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

// ── scenes ────────────────────────────────────────────────────────────────
async function sceneR1(browser, width, height) {
  const scene = 'R1'
  const { items, check } = makeAssert()
  await resetHarness('unknown503')
  const boot = await bootApp(browser, width, height)
  const app = boot.app
  await openNotes(app)
  const opened = await openNoteFromCatalog(app, 'note_d1')
  check('r1.note_opened', opened.opened, 'catalog note-open-note_d1 resolves', opened)
  await afterEditorReady(app)
  const marker = `[synthetic] R1 pane-switch unsaved recovery marker ${stamp()}`
  const typed = await typeIntoEditor(app, `\n\n${marker}`)
  check('r1.typed', typed, true, typed)
  const tracked = await trackSaveStatus(app, { targets: ['unknown', 'failed'], timeoutMs: 20000 })
  log(`${PREFIX} ${scene} save-statuses=${JSON.stringify(tracked.seen)}`)
  check(
    'r1.unsaved_failure_state',
    ['unknown', 'failed', 'pending', 'saving'].includes(tracked.last && tracked.last.status),
    'save status unknown/failed/pending/saving (cannot be saved)',
    tracked.last,
  )
  const beforeSwitch = await collectState(boot)
  log(`${PREFIX} ${scene} editor-state=${JSON.stringify(beforeSwitch.saveStatus)} drafts=${JSON.stringify(beforeSwitch.noteDraftStorageKeys)}`)
  // PR4's editor-level guard auto-opens on the unknown save result; answer it
  // with "Stay" so the parent pane-navigation buttons are reachable (the
  // parent navigation itself is what this ticket changes, not the editor guard).
  if (PHASE === 'before' && (await count(app, HOOKS.leaveGuard[0])) > 0) {
    // Evidence: the existing PR4 editor-level guard auto-opened on the unknown
    // save result (issue #1136 gap is the *parent* navigation, not this dialog).
    await shot(boot, `${PREFIX}_r1_editor_guard_${width}`)
  }
  const guardBefore = await dismissLeaveGuardIfOpen(app, scene)
  check(
    'r1.editor_level_guard_auto_opened',
    guardBefore.opened >= 1,
    'PR4 editor-level leave guard auto-opens on unknown save result (dismissed with Stay to reach parent nav)',
    guardBefore,
  )

  // Real UI: leave the Notes pane for Sources, then come back to Notes.
  await switchPane(app, 'Sources')
  await switchPane(app, 'Notes')
  await boot.page.waitForTimeout(800)
  const catalog = await collectState(boot)
  log(`${PREFIX} ${scene} catalog-state=${JSON.stringify(catalog.counts)} inbox-testids=${JSON.stringify(catalog.inboxTestids)}`)
  await shot(boot, `${PREFIX}_r1_pane_switch_${width}`)

  if (PHASE === 'before') {
    check(
      'r1.before_no_recovery_inbox_in_catalog',
      catalog.counts.note_recovery_inbox === 0 && catalog.counts.note_recovery_rows === 0,
      'catalog view has 0 recovery inbox testids (baseline gap)',
      { inbox: catalog.counts.note_recovery_inbox, rows: catalog.counts.note_recovery_rows },
    )
    check(
      'r1.before_draft_survives_in_storage',
      catalog.noteDraftStorageKeys.length >= 1,
      '>=1 rdlens.research.note.v1 draft key after pane switch',
      catalog.noteDraftStorageKeys.length,
    )
    // Baseline limitation illustration: recovery only appears after manually
    // reopening the exact note (PR4 behavior).
    const reopened = await openNoteFromCatalog(app, 'note_d1')
    await afterEditorReady(app)
    await boot.page.waitForTimeout(1500)
    const guardManual = await dismissLeaveGuardIfOpen(app, scene)
    await boot.page.waitForTimeout(500)
    await scrollEditorIntoView(app)
    const manual = await collectState(boot)
    log(`${PREFIX} ${scene} manual-reopen=${JSON.stringify(manual.counts)} status=${JSON.stringify(manual.saveStatus)}`)
    await shot(boot, `${PREFIX}_r1_manual_reopen_${width}`)
    check(
      'r1.before_manual_reopen_shows_recovery_banner',
      manual.counts.note_draft_restored >= 1,
      'note-draft-restored >= 1 after manually reopening the same note',
      manual.counts.note_draft_restored,
    )
    check(
      'r1.before_manual_reopen_draft_text_present',
      editorHas(manual, marker),
      'editor content contains the typed unsaved marker',
      { marker, present: editorHas(manual, marker) },
    )
    check(
      'r1.before_manual_reopen_unsaved_status',
      ['unknown', 'failed'].includes(manual.saveStatus && manual.saveStatus.status),
      'save status still unknown/failed after reopen',
      manual.saveStatus,
    )
    check('r1.before_note_reopened', reopened.opened, 'manual reopen works', reopened)
    check(
      'r1.before_manual_reopen_guard_auto_opened',
      guardManual.opened >= 1,
      'editor-level guard auto-opens again on reopen of the unknown draft',
      guardManual,
    )
  } else {
    check(
      'r1.after_recovery_inbox_in_catalog',
      catalog.counts.note_recovery_inbox >= 1,
      'catalog view shows >=1 note-recovery-inbox',
      catalog.counts.note_recovery_inbox,
    )
    check(
      'r1.after_recovery_row_for_note',
      catalog.counts.note_recovery_rows >= 1 &&
        (await count(app, HOOKS.recoveryRow('note_d1'))) >= 1,
      'note-recovery-row-note_d1 present in catalog',
      { rows: catalog.counts.note_recovery_rows, noteRow: await count(app, HOOKS.recoveryRow('note_d1')) },
    )
    check(
      'r1.after_recovery_title_for_note',
      (await count(app, HOOKS.recoveryTitle('note_d1'))) >= 1,
      'note-recovery-title-note_d1 present in catalog',
      await count(app, HOOKS.recoveryTitle('note_d1')),
    )
    check(
      'r1.after_recovery_copy_action',
      (await count(app, HOOKS.recoveryCopy('note_d1'))) >= 1,
      'note-recovery-copy-note_d1 present in catalog inbox row',
      await count(app, HOOKS.recoveryCopy('note_d1')),
    )
    check(
      'r1.after_recovery_download_action',
      (await count(app, HOOKS.recoveryDownload('note_d1'))) >= 1,
      'note-recovery-download-note_d1 present in catalog inbox row',
      await count(app, HOOKS.recoveryDownload('note_d1')),
    )
    const fromInbox = await openFromRecoveryInbox(app, 'note_d1')
    check('r1.after_recovery_open_button', fromInbox.opened, 'inbox open-note action resolves', fromInbox)
    await afterEditorReady(app)
    await boot.page.waitForTimeout(1500)
    const guardRestored = await dismissLeaveGuardIfOpen(app, scene)
    await boot.page.waitForTimeout(500)
    await scrollEditorIntoView(app)
    const restored = await collectState(boot)
    log(`${PREFIX} ${scene} restored=${JSON.stringify(restored.counts)} status=${JSON.stringify(restored.saveStatus)} get-notes=${JSON.stringify(boot.net.noteGets)}`)
    await shot(boot, `${PREFIX}_r1_restored_${width}`)
    check(
      'r1.after_restored_editor_recovery_banner',
      restored.counts.note_draft_restored >= 1,
      'note-draft-restored >= 1 after opening from the recovery inbox',
      restored.counts.note_draft_restored,
    )
    check(
      'r1.after_restored_draft_text_present',
      editorHas(restored, marker),
      'restored editor content contains the typed unsaved marker',
      { marker, present: editorHas(restored, marker) },
    )
    check(
      'r1.after_restored_guard_auto_opened',
      guardRestored.opened >= 1,
      'editor-level guard auto-opens when restoring the unknown draft from the inbox',
      guardRestored,
    )
    check(
      'r1.after_restored_unsaved_status',
      ['unknown', 'failed'].includes(restored.saveStatus && restored.saveStatus.status),
      'save status unknown/failed (still not saved)',
      restored.saveStatus,
    )
    await scrollEditorContentIntoView(app)
    const restoredDraft = await collectState(boot)
    await shot(boot, `${PREFIX}_r1_restored_draft_${width}`)
    check(
      'r1.after_restored_draft_text_visible',
      editorHas(restoredDraft, marker),
      'editor textarea in view contains the restored unsaved marker',
      { marker, present: editorHas(restoredDraft, marker) },
    )
  }

  const raw = await stats()
  log(`${PREFIX} ${scene} stats=${JSON.stringify(statsSummary(raw))}`)
  log(`${PREFIX} ${scene} console-errors=${JSON.stringify(boot.errors)} expected-http-errors=${JSON.stringify(boot.expectedHttpErrors)}`)
  check('r1.no_console_or_page_errors', boot.errors.length === 0, [], boot.errors)
  const patches = (raw.saves || []).length
  check('r1.save_attempts_recorded', patches >= 1, '>=1 gateway PATCH attempt', patches)
  check(
    'r1.note_not_saved_on_server',
    ((raw.notes || []).find((note) => note.note_id === 'note_d1') || {}).revision === 3,
    'note_d1 server revision stays 3 (save did not succeed)',
    (raw.notes || []).find((note) => note.note_id === 'note_d1'),
  )
  const note = await currentNote('note_d1')
  log(`${PREFIX} ${scene} server-note-revision=${note && note.revision}`)
  await boot.context.close()
  return { id: scene, width, save_mode: 'unknown503', marker, stats: statsSummary(raw), assertions: items }
}

async function sceneR2(browser, width, height) {
  const scene = 'R2'
  const { items, check } = makeAssert()
  await resetHarness('unknown503')
  const boot = await bootApp(browser, width, height)
  const app = boot.app
  const projectRequests = (segment) =>
    boot.net.calls.filter((call) => call.includes(`/projects/${segment}/`)).length
  await openNotes(app)
  const opened = await openNoteFromCatalog(app, 'note_d1')
  check('r2.note_opened', opened.opened, 'catalog note-open-note_d1 resolves', opened)
  await afterEditorReady(app)
  const marker = `[synthetic] R2 project-switch unsaved recovery marker ${stamp()}`
  const typed = await typeIntoEditor(app, `\n\n${marker}`)
  check('r2.typed', typed, true, typed)
  const tracked = await trackSaveStatus(app, { targets: ['unknown', 'failed'], timeoutMs: 20000 })
  check(
    'r2.unsaved_failure_state',
    ['unknown', 'failed', 'pending', 'saving'].includes(tracked.last && tracked.last.status),
    'save status unknown/failed (cannot be saved)',
    tracked.last,
  )
  const p1RequestsBefore = projectRequests('p1')
  log(`${PREFIX} ${scene} p1-requests-before=${p1RequestsBefore}`)

  // Host-contract project switch: re-post a research-v0 token with
  // project_id=p2 on the SAME channel/nonce (documented synthetic-host dev
  // hook `window.__hostSendToken`, exactly the real host token re-post path),
  // then back to p1. The legacy shell has no project-name element (W1 #1104
  // moved project identity to the host page), so the switch is asserted by
  // (a) the host hook result, (b) new /projects/<id>/ gateway requests, and
  // (c) the workspace tree remounting back to the default Sources pane.
  const toP2 = await boot.page.evaluate(() => window.__hostSendToken('p2'))
  log(`${PREFIX} ${scene} host-send-token-p2=${JSON.stringify(toP2)}`)
  check('r2.host_token_switch_p2_accepted', Boolean(toP2 && toP2.ok), 'host hook reports ok', toP2)
  const remountedP2 = await waitFor(
    async () => {
      const nav = await count(app, HOOKS.groupNav[0])
      const catalog = await count(app, HOOKS.catalog[0])
      return nav > 0 && catalog === 0 && projectRequests('p2') > 0
    },
    30000,
    500,
  )
  log(`${PREFIX} ${scene} p2-requests=${projectRequests('p2')} remount=${Boolean(remountedP2)}`)
  check(
    'r2.workspace_remounted_on_p2',
    Boolean(remountedP2),
    'group nav alive, Notes catalog gone (default Sources pane), >=1 gateway request under /projects/p2/',
    { p2Requests: projectRequests('p2') },
  )
  // On P2 the Notes pane must NOT show the P1 draft (draft cache is scoped by
  // owner+project+tab). The synthetic mock serves the same fixture projection
  // for any project path (data isolation is not under test here).
  await openNotes(app)
  await boot.page.waitForTimeout(800)
  const p2catalog = await collectState(boot)
  log(`${PREFIX} ${scene} p2-catalog-state=${JSON.stringify(p2catalog.counts)} drafts=${JSON.stringify(p2catalog.noteDraftStorageKeys)}`)
  await shot(boot, `${PREFIX}_r2_project_p2_${width}`)
  check(
    'r2.no_p1_recovery_inbox_while_on_p2',
    p2catalog.counts.note_recovery_inbox === 0 && p2catalog.counts.note_recovery_rows === 0,
    'no recovery inbox row while the workspace is bound to p2 (draft is p1-scoped)',
    { inbox: p2catalog.counts.note_recovery_inbox, rows: p2catalog.counts.note_recovery_rows },
  )

  const back = await boot.page.evaluate(() => window.__hostSendToken('p1'))
  log(`${PREFIX} ${scene} host-send-token-p1=${JSON.stringify(back)}`)
  check('r2.host_token_switch_p1_back_accepted', Boolean(back && back.ok), 'host hook reports ok', back)
  const remountedP1 = await waitFor(
    async () => {
      const nav = await count(app, HOOKS.groupNav[0])
      const catalog = await count(app, HOOKS.catalog[0])
      return nav > 0 && catalog === 0 && projectRequests('p1') > p1RequestsBefore
    },
    30000,
    500,
  )
  log(`${PREFIX} ${scene} p1-requests-after=${projectRequests('p1')} remount=${Boolean(remountedP1)}`)
  check(
    'r2.workspace_remounted_back_on_p1',
    Boolean(remountedP1),
    'fresh /projects/p1/ gateway requests after switching back and default Sources pane',
    { p1Requests: projectRequests('p1') },
  )
  await openNotes(app)
  await boot.page.waitForTimeout(800)
  const catalog = await collectState(boot)
  log(`${PREFIX} ${scene} catalog-state=${JSON.stringify(catalog.counts)} inbox-testids=${JSON.stringify(catalog.inboxTestids)}`)
  await shot(boot, `${PREFIX}_r2_project_switch_${width}`)
  check(
    'r2.draft_survives_project_switch_storage',
    catalog.noteDraftStorageKeys.length >= 1,
    '>=1 draft key present after p1->p2->p1',
    catalog.noteDraftStorageKeys.length,
  )
  if (PHASE === 'before') {
    check(
      'r2.before_no_recovery_inbox_in_catalog',
      catalog.counts.note_recovery_inbox === 0 && catalog.counts.note_recovery_rows === 0,
      'catalog view has 0 recovery inbox testids (baseline gap)',
      { inbox: catalog.counts.note_recovery_inbox, rows: catalog.counts.note_recovery_rows },
    )
  } else {
    check(
      'r2.after_recovery_inbox_in_catalog',
      catalog.counts.note_recovery_inbox >= 1,
      'catalog view shows >=1 note-recovery-inbox after returning to p1',
      catalog.counts.note_recovery_inbox,
    )
    check(
      'r2.after_recovery_row_for_note',
      (await count(app, HOOKS.recoveryRow('note_d1'))) >= 1,
      'note-recovery-row-note_d1 present after returning to p1',
      await count(app, HOOKS.recoveryRow('note_d1')),
    )
    check(
      'r2.after_recovery_row_was_absent_on_p2',
      p2catalog.counts.note_recovery_rows === 0,
      'inbox row only appears after returning to p1 (project-scoped draft cache)',
      { onP2: p2catalog.counts.note_recovery_rows, onP1: catalog.counts.note_recovery_rows },
    )
    const fromInbox = await openFromRecoveryInbox(app, 'note_d1')
    check('r2.after_recovery_open_button', fromInbox.opened, 'inbox open-note action resolves', fromInbox)
    await afterEditorReady(app)
    await boot.page.waitForTimeout(2000)
    const guardRestored = await dismissLeaveGuardIfOpen(app, scene)
    await boot.page.waitForTimeout(500)
    await scrollEditorIntoView(app)
    const restored = await collectState(boot)
    log(`${PREFIX} ${scene} restored=${JSON.stringify(restored.counts)} status=${JSON.stringify(restored.saveStatus)} get-notes=${JSON.stringify(boot.net.noteGets)}`)
    await shot(boot, `${PREFIX}_r2_restored_${width}`)
    check(
      'r2.after_restored_editor_recovery_banner',
      restored.counts.note_draft_restored >= 1,
      'note-draft-restored >= 1 after opening the p1 draft from the inbox',
      restored.counts.note_draft_restored,
    )
    check(
      'r2.after_restored_draft_text_present',
      editorHas(restored, marker),
      'restored editor contains the typed unsaved marker',
      { marker, present: editorHas(restored, marker) },
    )
    check(
      'r2.after_restored_unsaved_status',
      ['unknown', 'failed'].includes(restored.saveStatus && restored.saveStatus.status),
      'save status unknown/failed after restore (still not saved)',
      restored.saveStatus,
    )
    check(
      'r2.after_restore_permission_confirmed_get',
      boot.net.noteGets.some((path) => path.includes('/projects/p1/') && path.includes('/notes/note_d1')),
      'permission-confirming GET /projects/p1/notes/note_d1 observed before draft restore',
      boot.net.noteGets,
    )
    check(
      'r2.after_restored_guard_auto_opened',
      guardRestored.opened >= 1,
      'PR4 editor-level guard auto-opens for the unknown draft (dismissed with Stay)',
      guardRestored,
    )
    await scrollEditorContentIntoView(app)
    const restoredDraft = await collectState(boot)
    await shot(boot, `${PREFIX}_r2_restored_draft_${width}`)
    check(
      'r2.after_restored_draft_text_visible',
      editorHas(restoredDraft, marker),
      'editor textarea in view contains the restored unsaved marker',
      { marker, present: editorHas(restoredDraft, marker) },
    )
  }
  const raw = await stats()
  log(`${PREFIX} ${scene} stats=${JSON.stringify(statsSummary(raw))}`)
  log(`${PREFIX} ${scene} console-errors=${JSON.stringify(boot.errors)} expected-http-errors=${JSON.stringify(boot.expectedHttpErrors)}`)
  check('r2.no_console_or_page_errors', boot.errors.length === 0, [], boot.errors)
  await boot.context.close()
  return {
    id: scene,
    width,
    save_mode: 'unknown503',
    driving_method:
      'window.__hostSendToken(projectId) re-posts research-v0 token on the same channel/nonce; legacy shell (iframe ?legacy=1) has no project-name element, switch asserted by host hook result + /projects/<id>/ gateway requests + workspace remount',
    marker,
    project_requests: { p1: projectRequests('p1'), p2: projectRequests('p2') },
    stats: statsSummary(raw),
    assertions: items,
  }
}

async function sceneR3(browser, width, height) {
  const scene = 'R3'
  const { items, check } = makeAssert()
  await resetHarness('unknown503')
  const boot = await bootApp(browser, width, height)
  let app = boot.app
  await openNotes(app)
  const opened = await openNoteFromCatalog(app, 'note_d1')
  check('r3.note_opened', opened.opened, 'catalog note-open-note_d1 resolves', opened)
  await afterEditorReady(app)
  const marker = `[synthetic] R3 reload unsaved recovery marker ${stamp()}`
  const typed = await typeIntoEditor(app, `\n\n${marker}`)
  check('r3.typed', typed, true, typed)
  const tracked = await trackSaveStatus(app, { targets: ['unknown', 'failed'], timeoutMs: 20000 })
  check(
    'r3.unsaved_failure_state',
    ['unknown', 'failed', 'pending', 'saving'].includes(tracked.last && tracked.last.status),
    'save status unknown/failed (cannot be saved)',
    tracked.last,
  )
  const preReload = await collectState(boot)
  log(`${PREFIX} ${scene} pre-reload-drafts=${JSON.stringify(preReload.noteDraftStorageKeys)}`)

  // Full host page reload (real browser navigation; beforeunload prompt, if
  // any, is accepted as "Leave" and logged).
  await boot.page.reload({ waitUntil: 'domcontentloaded' }).catch((error) => {
    log(`${PREFIX} ${scene} reload-error=${JSON.stringify(String(error).slice(0, 200))}`)
  })
  app = await findAppFrame(boot.page)
  check('r3.app_frame_after_reload', Boolean(app), 'research iframe present after reload', Boolean(app))
  if (!app) {
    await boot.context.close()
    return { id: scene, width, save_mode: 'unknown503', marker, error: 'no app frame after reload', assertions: items }
  }
  await waitForWorkspace(app)
  await boot.page.waitForTimeout(1800)
  boot.app = app
  await openNotes(app)
  await boot.page.waitForTimeout(800)
  const catalog = await collectState(boot)
  log(`${PREFIX} ${scene} catalog-state=${JSON.stringify(catalog.counts)} inbox-testids=${JSON.stringify(catalog.inboxTestids)}`)
  await shot(boot, `${PREFIX}_r3_reload_${width}`)
  check(
    'r3.draft_survives_reload_storage',
    catalog.noteDraftStorageKeys.length >= 1,
    '>=1 draft key present after full page reload',
    catalog.noteDraftStorageKeys.length,
  )
  if (PHASE === 'before') {
    check(
      'r3.before_no_recovery_inbox_in_catalog',
      catalog.counts.note_recovery_inbox === 0 && catalog.counts.note_recovery_rows === 0,
      'catalog view has 0 recovery inbox testids after reload (baseline gap)',
      { inbox: catalog.counts.note_recovery_inbox, rows: catalog.counts.note_recovery_rows },
    )
  } else {
    check(
      'r3.after_recovery_inbox_in_catalog',
      catalog.counts.note_recovery_inbox >= 1,
      'catalog view shows >=1 note-recovery-inbox after reload',
      catalog.counts.note_recovery_inbox,
    )
    check(
      'r3.after_recovery_row_for_note',
      (await count(app, HOOKS.recoveryRow('note_d1'))) >= 1,
      'note-recovery-row-note_d1 present after reload',
      await count(app, HOOKS.recoveryRow('note_d1')),
    )
    const fromInbox = await openFromRecoveryInbox(app, 'note_d1')
    check('r3.after_recovery_open_button', fromInbox.opened, 'inbox open-note action resolves', fromInbox)
    await afterEditorReady(app)
    await boot.page.waitForTimeout(2000)
    const guardRestored = await dismissLeaveGuardIfOpen(app, scene)
    await boot.page.waitForTimeout(500)
    await scrollEditorIntoView(app)
    const restored = await collectState(boot)
    log(`${PREFIX} ${scene} restored=${JSON.stringify(restored.counts)} status=${JSON.stringify(restored.saveStatus)} get-notes=${JSON.stringify(boot.net.noteGets)}`)
    await shot(boot, `${PREFIX}_r3_restored_${width}`)
    check(
      'r3.after_restored_editor_recovery_banner',
      restored.counts.note_draft_restored >= 1,
      'note-draft-restored >= 1 after opening the reloaded draft from the inbox',
      restored.counts.note_draft_restored,
    )
    check(
      'r3.after_restored_draft_text_present',
      editorHas(restored, marker),
      'restored editor contains the typed unsaved marker after reload',
      { marker, present: editorHas(restored, marker) },
    )
    check(
      'r3.after_restored_unsaved_status',
      ['unknown', 'failed'].includes(restored.saveStatus && restored.saveStatus.status),
      'save status unknown/failed after restore (still not saved)',
      restored.saveStatus,
    )
    check(
      'r3.after_restore_permission_confirmed_get',
      boot.net.noteGets.some((path) => path.includes('/projects/p1/') && path.includes('/notes/note_d1')),
      'permission-confirming GET /projects/p1/notes/note_d1 observed before draft restore',
      boot.net.noteGets,
    )
    check(
      'r3.after_restored_guard_auto_opened',
      guardRestored.opened >= 1,
      'PR4 editor-level guard auto-opens for the unknown draft (dismissed with Stay)',
      guardRestored,
    )
    await scrollEditorContentIntoView(app)
    const restoredDraft = await collectState(boot)
    await shot(boot, `${PREFIX}_r3_restored_draft_${width}`)
    check(
      'r3.after_restored_draft_text_visible',
      editorHas(restoredDraft, marker),
      'editor textarea in view contains the restored unsaved marker',
      { marker, present: editorHas(restoredDraft, marker) },
    )
  }
  const raw = await stats()
  log(`${PREFIX} ${scene} stats=${JSON.stringify(statsSummary(raw))}`)
  log(`${PREFIX} ${scene} console-errors=${JSON.stringify(boot.errors)} expected-http-errors=${JSON.stringify(boot.expectedHttpErrors)}`)
  check('r3.no_console_or_page_errors', boot.errors.length === 0, [], boot.errors)
  const note = await currentNote('note_d1')
  check(
    'r3.note_not_saved_on_server',
    (note && note.revision) === 3,
    'note_d1 server revision stays 3 after reload (save still not succeeded)',
    note && note.revision,
  )
  await boot.context.close()
  return { id: scene, width, save_mode: 'unknown503', marker, stats: statsSummary(raw), assertions: items }
}

async function sceneR4(browser, width, height) {
  const scene = 'R4'
  const { items, check } = makeAssert()
  await resetHarness('conflict')
  const boot = await bootApp(browser, width, height)
  const app = boot.app
  await openNotes(app)
  const opened = await openNoteFromCatalog(app, 'note_d1')
  check('r4.note_opened', opened.opened, 'catalog note-open-note_d1 resolves', opened)
  await afterEditorReady(app)
  // Another tab advances the server revision: the next autosave is a 409.
  const bumped = await bumpNote('note_d1')
  log(`${PREFIX} ${scene} bumped=${JSON.stringify(bumped && bumped.revision)}`)
  const marker = `[synthetic] R4 conflict recovery marker ${stamp()}`
  const typed = await typeIntoEditor(app, `\n\n${marker}`)
  check('r4.typed', typed, true, typed)
  const tracked = await trackSaveStatus(app, { targets: ['conflict'], timeoutMs: 25000 })
  log(`${PREFIX} ${scene} save-statuses=${JSON.stringify(tracked.seen)}`)
  check(
    'r4.conflict_state_reached',
    tracked.last && tracked.last.status === 'conflict',
    'save status conflict',
    tracked.last,
  )
  const conflicts = await count(app, HOOKS.conflict[0])
  check('r4.conflict_dialog_present', conflicts >= 1, 'note-conflict-dialog >= 1', conflicts)
  // Dismiss the conflict dialog with "Keep editing" (conflict state persists),
  // then perform the parent-navigation pane switch through real UI clicks.
  const keep = await findFirst(app, HOOKS.conflictKeepEditing)
  if (keep.locator) {
    await keep.locator.click({ timeout: 8000 }).catch(() => {})
    await boot.page.waitForTimeout(700)
  } else {
    missing('R4', 'note-conflict-keep-editing')
  }
  await switchPane(app, 'Sources')
  await switchPane(app, 'Notes')
  await boot.page.waitForTimeout(800)
  const catalog = await collectState(boot)
  log(`${PREFIX} ${scene} catalog-state=${JSON.stringify(catalog.counts)} inbox-testids=${JSON.stringify(catalog.inboxTestids)}`)
  await shot(boot, `${PREFIX}_r4_conflict_${width}`)
  if (PHASE === 'before') {
    check(
      'r4.before_no_recovery_inbox_in_catalog',
      catalog.counts.note_recovery_inbox === 0 && catalog.counts.note_recovery_rows === 0,
      'catalog view has 0 recovery inbox testids (baseline gap)',
      { inbox: catalog.counts.note_recovery_inbox, rows: catalog.counts.note_recovery_rows },
    )
  } else {
    check(
      'r4.after_recovery_inbox_in_catalog',
      catalog.counts.note_recovery_inbox >= 1,
      'catalog view shows >=1 note-recovery-inbox after conflict + pane switch',
      catalog.counts.note_recovery_inbox,
    )
    check(
      'r4.after_recovery_row_for_note',
      (await count(app, HOOKS.recoveryRow('note_d1'))) >= 1,
      'note-recovery-row-note_d1 present',
      await count(app, HOOKS.recoveryRow('note_d1')),
    )
    const fromInbox = await openFromRecoveryInbox(app, 'note_d1')
    check('r4.after_recovery_open_button', fromInbox.opened, 'inbox open-note action resolves', fromInbox)
    await afterEditorReady(app)
    await boot.page.waitForTimeout(2000)
    const restored = await collectState(boot)
    log(`${PREFIX} ${scene} restored=${JSON.stringify(restored.counts)} status=${JSON.stringify(restored.saveStatus)}`)
    await shot(boot, `${PREFIX}_r4_conflict_restored_${width}`)
    check(
      'r4.after_restored_editor_recovery_banner',
      restored.counts.note_draft_restored >= 1,
      'note-draft-restored >= 1 after opening from the recovery inbox',
      restored.counts.note_draft_restored,
    )
    check(
      'r4.after_restored_draft_text_present',
      editorHas(restored, marker),
      'restored editor content contains the typed unsaved marker',
      { marker, present: editorHas(restored, marker) },
    )
    check(
      'r4.after_conflict_ui_present_after_open',
      restored.counts.note_conflict_dialog >= 1 ||
        (restored.saveStatus && restored.saveStatus.status === 'conflict'),
      'conflict dialog or conflict save status shown after opening draft',
      { dialog: restored.counts.note_conflict_dialog, status: restored.saveStatus },
    )
    check(
      'r4.after_restore_permission_confirmed_get',
      boot.net.noteGets.some((path) => path.includes('/projects/p1/') && path.includes('/notes/note_d1')),
      'permission-confirming GET /projects/p1/notes/note_d1 observed before draft restore',
      boot.net.noteGets,
    )
    // Dismiss the conflict dialog with "Keep editing" to reveal the restored
    // editor + PR4 recovery banner + conflict save-status bar underneath.
    const keepRestored = await findFirst(app, HOOKS.conflictKeepEditing)
    if (keepRestored.locator) {
      await keepRestored.locator.click({ timeout: 8000 }).catch(() => {})
      await boot.page.waitForTimeout(800)
    }
    await scrollEditorIntoView(app)
    const restoredEditor = await collectState(boot)
    log(`${PREFIX} ${scene} restored-editor=${JSON.stringify(restoredEditor.counts)} status=${JSON.stringify(restoredEditor.saveStatus)}`)
    await shot(boot, `${PREFIX}_r4_conflict_restored_editor_${width}`)
    check(
      'r4.after_restored_editor_conflict_status',
      restoredEditor.saveStatus && restoredEditor.saveStatus.status === 'conflict',
      'save-status bar shows conflict after dismissing the dialog',
      restoredEditor.saveStatus,
    )
    check(
      'r4.after_restored_editor_draft_text_present',
      editorHas(restoredEditor, marker),
      'editor textarea still contains the restored unsaved marker',
      { marker, present: editorHas(restoredEditor, marker) },
    )
  }
  const raw = await stats()
  log(`${PREFIX} ${scene} stats=${JSON.stringify(statsSummary(raw))}`)
  log(`${PREFIX} ${scene} console-errors=${JSON.stringify(boot.errors)} expected-http-errors=${JSON.stringify(boot.expectedHttpErrors)}`)
  check('r4.no_console_or_page_errors', boot.errors.length === 0, [], boot.errors)
  check(
    'r4.save_conflict_recorded',
    (raw.saves || []).some((entry) => entry.status === 409),
    '>=1 gateway PATCH returned 409',
    (raw.saves || []).map((entry) => entry.status),
  )
  await boot.context.close()
  return { id: scene, width, save_mode: 'conflict', marker, stats: statsSummary(raw), assertions: items }
}

async function sceneR5(browser, width, height) {
  const scene = 'R5'
  const { items, check } = makeAssert()
  await resetHarness('success')
  const boot = await bootApp(browser, width, height)
  const app = boot.app
  await openNotes(app)
  const opened = await openNoteFromCatalog(app, 'note_d1')
  check('r5.note_opened', opened.opened, 'catalog note-open-note_d1 resolves', opened)
  await afterEditorReady(app)
  const marker = `[synthetic] R5 steady-state saved marker ${stamp()}`
  const typed = await typeIntoEditor(app, `\n\n${marker}`)
  check('r5.typed', typed, true, typed)
  const tracked = await trackSaveStatus(app, { targets: ['saved'], timeoutMs: 25000 })
  log(`${PREFIX} ${scene} save-statuses=${JSON.stringify(tracked.seen)}`)
  check(
    'r5.autosave_reached_saved',
    tracked.last && tracked.last.status === 'saved',
    'save status saved',
    tracked.last,
  )
  await boot.page.waitForTimeout(1200)
  await switchPane(app, 'Sources')
  await switchPane(app, 'Notes')
  await boot.page.waitForTimeout(1000)
  const catalog = await collectState(boot)
  log(`${PREFIX} ${scene} catalog-state=${JSON.stringify(catalog.counts)} inbox-testids=${JSON.stringify(catalog.inboxTestids)}`)
  await shot(boot, `${PREFIX}_r5_steady_state_${width}`)
  check(
    'r5.no_recovery_inbox_after_successful_autosave',
    catalog.counts.note_recovery_inbox === 0 && catalog.counts.note_recovery_rows === 0,
    'both sides show 0 recovery inbox (no stale recovery after saved)',
    { inbox: catalog.counts.note_recovery_inbox, rows: catalog.counts.note_recovery_rows },
  )
  check(
    'r5.no_stale_draft_cache_after_saved',
    catalog.noteDraftStorageKeys.length === 0,
    '0 draft cache keys after successful autosave + ACK cleanup',
    catalog.noteDraftStorageKeys,
  )
  const raw = await stats()
  log(`${PREFIX} ${scene} stats=${JSON.stringify(statsSummary(raw))}`)
  log(`${PREFIX} ${scene} console-errors=${JSON.stringify(boot.errors)} expected-http-errors=${JSON.stringify(boot.expectedHttpErrors)}`)
  check('r5.no_console_or_page_errors', boot.errors.length === 0, [], boot.errors)
  const note = await currentNote('note_d1')
  check(
    'r5.saved_content_on_server',
    note && typeof note.content === 'string' && note.content.includes(marker),
    'server-side synthetic note content contains the saved marker',
    { revision: note && note.revision, containsMarker: Boolean(note && note.content.includes(marker)) },
  )
  check(
    'r5.server_revision_advanced',
    note && note.revision > 3,
    'note_d1 revision advanced beyond 3',
    note && note.revision,
  )
  await boot.context.close()
  return { id: scene, width, save_mode: 'success', marker, stats: statsSummary(raw), assertions: items }
}

const SCENES = { r1: sceneR1, r2: sceneR2, r3: sceneR3, r4: sceneR4, r5: sceneR5 }
const SCENE_IDS = ONLY_SCENES.length > 0 ? ONLY_SCENES.map((id) => id.toLowerCase()) : Object.keys(SCENES)

async function main() {
  banner(`Issue #1136 ${PHASE} capture — head=${HEAD} host=${HOST} widths=${WIDTHS.join(',')}`)
  log(`${PREFIX} env: node=${process.version} chrome=${CHROME} gateway=${GATEWAY} evidence=${EVIDENCE_ROOT}`)
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
    ticket: 'HiFiBiO-Therapeutics/RDLens#1136',
    title: '应用内父级导航的离开保护（ResearchWorkbench 层）— fork visual evidence',
    evidence_kind: 'synthetic',
    synthetic_declaration:
      'Real fork Next.js app (next dev --webpack, embedded iframe) + synthetic host page + route-mocked Research Gateway. No real RDLens host, PostgreSQL, SurrealDB, files, models, Feishu content, users or private data. All note titles/ids/content are [synthetic] fixtures (project p1/p2, viewer 1).',
    phase: PHASE,
    head: HEAD,
    baseline: 'fork origin/main a4a76170c5016d0c4cfefae505aa8369be568a96',
    captured_at: new Date().toISOString(),
    host_url: HOST,
    gateway: GATEWAY,
    save_mode_file: SAVE_MODE_FILE,
    note_mode_file: NOTE_MODE_FILE,
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
