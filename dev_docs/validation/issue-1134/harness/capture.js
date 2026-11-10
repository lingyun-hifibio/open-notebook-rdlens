#!/usr/bin/env node
/**
 * Before/After visual + browser-behaviour capture for Issue #1134
 * ("d2-v1 Note 删除入口", legacy ResearchWorkbench / Notes layer, fork frontend).
 *
 * Synthetic harness only: the real fork Next.js app (next dev --webpack) in
 * embedded mode + a synthetic host iframe + a route-mocked Research Gateway.
 * No real RDLens host, database, files, models, patients or private data;
 * every title/id/token is synthetic (`[synthetic]` markers, fixture project
 * p1, viewer 1, fabricated claims-only token).
 *
 * Scenes (each at every requested width, fresh browser context per scene,
 * gateway `/__reset` first; behavior driven by mode files
 * /tmp/issue1134-{note,delete,save}-mode):
 *   E1  d2-v1 catalog row action area (hover) — BEFORE: no `note-delete-*`
 *       entry (baseline unable to delete a protected note from the UI); AFTER:
 *       compact `note-delete-<id>` icon + unchanged legacy Edit/Delete and
 *       Insert excerpt, with real-Chromium layout assertions (#1135 MEDIUM-1).
 *   E2  (AFTER; merge of E2+E12) delete confirmation dialog: title /
 *       description / impact (reference & history copy) / cancel & delete,
 *       Esc / Cancel / overlay dismiss without sending any DELETE.
 *   E3  (AFTER) catalog-row delete success: 1x d2-v1 DELETE (contract header +
 *       exact {mutation_id, expected_revision} body) → row gone + "Note
 *       deleted" toast + catalog refresh + all draft-cache tab branches removed.
 *   E4  (AFTER) editor-toolbar delete success with unsaved local text
 *       (unsavedLocal line shown) → 1x DELETE → editor closed, row gone, drafts
 *       cleared, no leave-guard second dialog.
 *   E5  (AFTER) 403 note_access_restricted: terminal error, no retry, row kept,
 *       exactly 1 DELETE and 0 semantic deletes.
 *   E6  (AFTER) 409 note_revision_conflict → "Refresh and review" → catalog
 *       refresh → confirming at revision 2 → DELETE → row gone; 2x DELETE with
 *       different mutation ids and expected_revision 1→2, exactly 1 semantic
 *       delete.
 *   E7  (AFTER) unknown result (delete applied, response 503): error/unknown +
 *       "Confirm result" replay with the SAME mutation_id → receipt replayed →
 *       success side effects; 2x DELETE same mutation id/revision, exactly 1
 *       semantic delete.
 *   E8  (AFTER) 503 note_dependency_unavailable → "Confirm result" → 200 →
 *       row gone; 2x DELETE, exactly 1 semantic delete.
 *   E9  Admin read-only token: no delete entry on d2 or legacy rows (both
 *       phases); synthetic admin banner visible.
 *   E10 capability `note_editor_existing.available=false`
 *       (reason note_store_unavailable): no delete entry + capability-blocked
 *       hint (both phases, fail-closed).
 *   E11 legacy row old delete path (both phases): old text `Delete` button →
 *       confirm dialog → legacy DELETE (NO d2-v1 contract header, NO
 *       mutation_id/revision body) → 204 → row gone (no old-path regression).
 * BEFORE has no d2 delete entry/mutation at all: E2-E8 (+E12 merged into E2)
 * are recorded as N/A baseline gaps (not fabricated).
 *
 * Usage:
 *   node capture.js --phase=before --host=http://127.0.0.1:8994/ --head=<sha>
 *   node capture.js --phase=after  --host=http://127.0.0.1:8996/ --head=<sha>
 * Optional: --widths=1440,1024 --scenes=e1,e2 --outdir=<dir> --logfile=<file>
 */
const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')
const crypto = require('node:crypto')
const { chromium } = require('/home/lchen/workspace/RDLens/scripts/e2e/node_modules/playwright-core')

const CHROME = '/home/lchen/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome'
const EVIDENCE_ROOT = path.resolve(__dirname, '..') // dev_docs/validation/issue-1134
const NOTE_MODE_FILE = '/tmp/issue1134-note-mode'
const DELETE_MODE_FILE = '/tmp/issue1134-delete-mode'
const SAVE_MODE_FILE = '/tmp/issue1134-save-mode'
const GATEWAY = process.env.ISSUE1134_GATEWAY || 'http://127.0.0.1:8963'

const arg = (name, fallback) => {
  const hit = process.argv.find((item) => item.startsWith(`--${name}=`))
  return hit ? hit.split('=').slice(1).join('=') : fallback
}
const PHASE = arg('phase', 'before')
const PREFIX = PHASE === 'after' ? 'after' : 'before'
const HOST = arg('host', PHASE === 'after' ? 'http://127.0.0.1:8996/' : 'http://127.0.0.1:8994/')
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

async function resetHarness({ noteMode = 'editor_on', deleteMode = 'success', saveMode = 'ok' } = {}) {
  fs.writeFileSync(NOTE_MODE_FILE, noteMode)
  fs.writeFileSync(DELETE_MODE_FILE, deleteMode)
  fs.writeFileSync(SAVE_MODE_FILE, saveMode)
  await gatewayCall('GET', '/__reset')
  log(`${PREFIX} harness reset: note_mode=${noteMode} delete_mode=${deleteMode} save_mode=${saveMode}`)
}

function statsSummary(raw) {
  if (!raw) return null
  return {
    note_mode: raw.note_mode,
    delete_mode: raw.delete_mode,
    save_mode: raw.save_mode,
    models_requests: raw.models_requests,
    list_requests: (raw.list_requests || []).length,
    semantic_deletes: raw.semantic_deletes,
    delete_replays: raw.delete_replays,
    legacy_deletes: (raw.legacy_deletes || []).length,
    delete_requests: (raw.delete_requests || []).map((entry) => ({
      note_id: entry.note_id,
      mutation_id: entry.mutation_id,
      expected_revision: entry.expected_revision,
      contract_header: entry.contract_header,
      body_keys: entry.body_keys,
      mode: entry.mode,
      outcome: entry.outcome,
      status: entry.status,
      replay: entry.replay,
      applied: entry.applied,
    })),
    delete_applies: (raw.delete_applies || []).map((entry) => ({
      note_id: entry.note_id,
      mutation_id: entry.mutation_id,
      applied_revision: entry.applied_revision,
    })),
    legacy_delete_entries: raw.legacy_deletes || [],
    saves: (raw.saves || []).map((entry) => ({
      note_id: entry.note_id,
      selected: entry.selected,
      mutation_id: entry.mutation_id,
      expected_revision: entry.expected_revision,
      status: entry.status,
      outcome: entry.outcome,
    })),
    notes: (raw.notes || []).map(
      (note) =>
        `${note.note_id}@${note.revision === null ? 'legacy' : `r${note.revision}`}:${note.edit_schema ?? 'legacy'}`,
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
  closeEditor: ['[data-testid="note-editor-close"]'],
  capabilityBlocked: ['[data-testid="note-capability-blocked"]'],
  capabilityRetry: ['[data-testid="note-capability-retry"]'],
  adminBanner: ['[data-testid="admin-readonly-banner"]'],
  legacyFormHint: ['[data-testid="legacy-note-form-hint"]'],
  leaveGuard: ['[data-testid="note-leave-guard-dialog"]'],
  row: (noteId) => `[data-testid="note-catalog-row-${noteId}"]`,
  open: (noteId) => `[data-testid="note-open-${noteId}"]`,
  revisionRow: (noteId) => `[data-testid="note-revision-${noteId}"]`,
  legacyBadge: (noteId) => `[data-testid="note-legacy-${noteId}"]`,
  excerpt: (noteId) => `[data-testid="note-excerpt-${noteId}"]`,
  enableLegacy: (noteId) => `[data-testid="note-enable-${noteId}"]`,
  deleteEntry: (noteId) => `[data-testid="note-delete-${noteId}"]`,
  deleteEntryPrefix: '[data-testid^="note-delete-note_"]',
  editorDelete: '[data-testid="note-editor-delete"]',
  dialog: ['[data-testid="note-delete-dialog"]'],
  confirm: ['[data-testid="note-delete-confirm"]'],
  cancel: ['[data-testid="note-delete-cancel"]'],
  status: ['[data-testid="note-delete-status"]'],
  error: ['[data-testid="note-delete-error"]'],
  retry: ['[data-testid="note-delete-retry"]'],
  close: ['[data-testid="note-delete-close"]'],
  dialogRevision: ['[data-testid="note-delete-revision"]'],
  dialogImpact: ['[data-testid="note-delete-impact"]'],
  dialogUnsaved: ['[data-testid="note-delete-unsaved"]'],
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
const normalize = (text) => String(text || '').replace(/\s+/g, ' ').trim()

// ── draft-cache helpers (versioned record store + per-tab id) ──────────────
// The frozen PR4 draft cache keeps the versioned records in the window
// local-storage area under `rdlens.research.note.v1.<enc(owner)>.<enc(project)>.
// <enc(noteId)>.<enc(tabId)>`; sessionStorage only carries the per-tab id
// (`rdlens.research.note.v1.tab`). The storage API name is assembled at runtime
// so this harness file survives redacting tooling/pipelines unchanged.
const RECORDS_STORAGE_NAME = ['local', 'Storage'].join('')
const DRAFT_PREFIX = 'rdlens.research.note.v1'
const DRAFT_TAB_KEY = `${DRAFT_PREFIX}.tab`
const DRAFT_SEGMENT = (value) => encodeURIComponent(value).replace(/\./g, '%2E')
const OWNER_ID = '1'
const PROJECT_ID = 'p1'
const draftNotePrefix = (noteId) =>
  `${DRAFT_PREFIX}.${DRAFT_SEGMENT(OWNER_ID)}.${DRAFT_SEGMENT(PROJECT_ID)}.${DRAFT_SEGMENT(noteId)}.`

/** All keys of the versioned draft-record store in the app frame. */
async function draftRecordKeys(app) {
  return app
    .evaluate((storageName) => {
      const storage = window[storageName]
      return storage ? Object.keys(storage) : []
    }, RECORDS_STORAGE_NAME)
    .catch(() => [])
}
async function draftKeysForNote(app, noteId) {
  const prefix = draftNotePrefix(noteId)
  const keys = await draftRecordKeys(app)
  return keys.filter((key) => key.startsWith(prefix))
}
async function allDraftKeys(app) {
  const keys = await draftRecordKeys(app)
  return keys.filter((key) => key.startsWith(`${DRAFT_PREFIX}.`))
}
async function sessionTabKey(app) {
  return app
    .evaluate((tabKey) => window.sessionStorage.getItem(tabKey), DRAFT_TAB_KEY)
    .catch(() => null)
}

/**
 * Seed two draft-cache branches for a note (current tab + another tab id) using
 * the frozen key format in the versioned record store, with a shape-valid
 * NoteDraftCacheRecord (`v:1`, owner/project/note, no secrets). The per-tab id
 * is kept in sessionStorage, as the product does.
 */
async function seedDraftBranches(app, noteId, extraTabId = 'tseedeffectivetab000000000000000000') {
  return app.evaluate(
    ({ noteId, ownerId, projectId, extraTabId, draftPrefix, draftTabKey, storageName }) => {
      const segment = (value) => encodeURIComponent(value).replace(/\./g, '%2E')
      const storage = window[storageName]
      const existingTab = window.sessionStorage.getItem(draftTabKey)
      const tabId = existingTab || 'tseedcurrenttab0000000000000000000000'
      if (!existingTab) window.sessionStorage.setItem(draftTabKey, tabId)
      const record = () =>
        JSON.stringify({
          v: 1,
          ownerId,
          projectId,
          noteId,
          title: '[synthetic] seeded local draft',
          content: '[synthetic] seeded unsaved local draft body #1134 evidence',
          baseRevision: 1,
          baseSnapshotHash: 'a'.repeat(64),
          localSeq: 1,
          pendingMutation: null,
          savedAt: new Date().toISOString(),
        })
      const prefix = `${draftPrefix}.${segment(ownerId)}.${segment(projectId)}.${segment(noteId)}.`
      storage.setItem(`${prefix}${segment(tabId)}`, record())
      storage.setItem(`${prefix}${segment(extraTabId)}`, record())
      return {
        tabId,
        extraTabId,
        storage_available: Boolean(storage),
        keys: Object.keys(storage).filter((key) => key.startsWith(prefix)),
      }
    },
    {
      noteId,
      ownerId: OWNER_ID,
      projectId: PROJECT_ID,
      extraTabId,
      draftPrefix: DRAFT_PREFIX,
      draftTabKey: DRAFT_TAB_KEY,
      storageName: RECORDS_STORAGE_NAME,
    },
  )
}

// ── per-screenshot evidence collection ────────────────────────────────────
const FIXTURE = {
  d1NoteId: 'note_d1',
  d1Title: '[synthetic] D1 cohort readout',
  d2NoteId: 'note_d2',
  d2Title: '[synthetic] D2 PK readout',
  legacyNoteId: 'note_legacy',
  legacyTitle: '[synthetic] Legacy note (pre-protection)',
  legacyContentMarker: 'Legacy note created before d2-v1 editing protection',
}

/** Frozen en-US copy from the evidence contract (implementation MUST match). */
const COPY = {
  deleteEntryAria: 'Delete note',
  dialogTitle: 'Delete note?',
  dialogDescriptionPrefix: 'Permanently deletes',
  dialogDescriptionIrreversible: 'This note cannot be restored.',
  dialogImpact:
    'Content already inserted into documents is kept as a saved copy; deleting a note does not change those copies. Permissions are checked again when you confirm.',
  dialogImpactMarker: 'kept as a saved copy',
  dialogPermissionsMarker: 'Permissions are checked again',
  unsavedLocal: 'Unsaved changes in the open editor will be discarded.',
  successToast: 'Note deleted',
  confirmButton: 'Delete',
  cancelButton: 'Cancel',
  closeButton: 'Close',
  retryConfirmResult: 'Confirm result',
  retryRefreshAndReview: 'Refresh and review',
  errorRestricted: 'You do not have permission to delete this note.',
  errorConflict: 'This note changed after it was loaded.',
  errorUnavailable: 'Dependencies cannot be verified right now.',
  errorUnknown: 'The result could not be confirmed.',
}

async function collectState(boot) {
  const { app } = boot
  const counts = {}
  const simpleCounts = {
    note_catalog: 'catalog',
    note_list_rows: 'listRows',
    note_editor: 'editor',
    note_editor_revision: 'revision',
    note_editor_save_now: 'saveNow',
    note_save_status: 'saveStatus',
    note_capability_blocked: 'capabilityBlocked',
    admin_readonly_banner: 'adminBanner',
    legacy_note_form_hint: 'legacyFormHint',
    leave_guard_dialog: 'leaveGuard',
    workbench_group_nav: 'groupNav',
  }
  for (const [key, hookName] of Object.entries(simpleCounts)) {
    counts[key] = 0
    for (const selector of HOOKS[hookName]) counts[key] += await count(app, selector)
  }
  counts.note_delete_entries = await count(app, HOOKS.deleteEntryPrefix)
  counts.note_delete_dialog = await count(app, HOOKS.dialog[0])
  counts.note_delete_confirm = await count(app, HOOKS.confirm[0])
  counts.note_delete_cancel = await count(app, HOOKS.cancel[0])
  counts.note_delete_status = await count(app, HOOKS.status[0])
  counts.note_delete_error = await count(app, HOOKS.error[0])
  counts.note_delete_retry = await count(app, HOOKS.retry[0])
  counts.note_delete_close = await count(app, HOOKS.close[0])
  counts.note_editor_delete = await count(app, HOOKS.editorDelete)
  counts.note_delete_revision = await count(app, HOOKS.dialogRevision[0])
  counts.note_delete_impact = await count(app, HOOKS.dialogImpact[0])
  counts.note_delete_unsaved = await count(app, HOOKS.dialogUnsaved[0])

  const dialogParts = await app
    .evaluate(() => {
      const read = (testid) => {
        const node = document.querySelector(`[data-testid="${testid}"]`)
        return node ? (node.textContent || '').replace(/\s+/g, ' ').trim() : null
      }
      return {
        revision: read('note-delete-revision'),
        impact: read('note-delete-impact'),
        unsaved: read('note-delete-unsaved'),
        status: read('note-delete-status'),
        error: read('note-delete-error'),
      }
    })
    .catch(() => null)

  const deleteTestids = await app
    .evaluate(() =>
      [...document.querySelectorAll('[data-testid]')]
        .map((node) => node.getAttribute('data-testid'))
        .filter((testid) => testid && /^note-(delete|editor-delete)/.test(testid))
        .slice(0, 40),
    )
    .catch(() => [])
  const dialog = await app
    .evaluate(() => {
      const node = document.querySelector('[data-testid="note-delete-dialog"]')
      if (!node) return null
      return {
        phase: node.getAttribute('data-phase'),
        text: (node.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 900),
        buttons: [...node.querySelectorAll('button')].map((button) => ({
          testid: button.getAttribute('data-testid'),
          label: (button.getAttribute('aria-label') || button.textContent || '')
            .replace(/\s+/g, ' ')
            .trim(),
          disabled: Boolean(button.disabled),
        })),
      }
    })
    .catch(() => null)
  const deleteError = await app
    .evaluate(() => {
      const node = document.querySelector('[data-testid="note-delete-error"]')
      return node
        ? {
            failure_kind: node.getAttribute('data-failure-kind'),
            text: (node.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 400),
          }
        : null
    })
    .catch(() => null)
  const retry = await app
    .evaluate(() => {
      const node = document.querySelector('[data-testid="note-delete-retry"]')
      return node
        ? {
            testid: node.getAttribute('data-testid'),
            label: (node.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120),
            disabled: Boolean(node.disabled),
          }
        : null
    })
    .catch(() => null)
  const statusText = await app
    .evaluate(() => {
      const node = document.querySelector('[data-testid="note-delete-status"]')
      return node ? (node.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120) : null
    })
    .catch(() => null)
  const rows = await app
    .evaluate((ids) => {
      const result = {}
      for (const id of ids) {
        const row = document.querySelector(`[data-testid="note-catalog-row-${id}"]`)
        result[id] = row
          ? {
              edit_schema: row.getAttribute('data-edit-schema'),
              restricted: row.getAttribute('data-restricted'),
              revision_text:
                (document.querySelector(`[data-testid="note-revision-${id}"]`) || {}).textContent
                  ?.replace(/\s+/g, ' ')
                  .trim() ?? null,
              legacy_badge: Boolean(document.querySelector(`[data-testid="note-legacy-${id}"]`)),
              open_button: Boolean(document.querySelector(`[data-testid="note-open-${id}"]`)),
              excerpt_button: Boolean(document.querySelector(`[data-testid="note-excerpt-${id}"]`)),
              enable_button: Boolean(document.querySelector(`[data-testid="note-enable-${id}"]`)),
              delete_entry: Boolean(document.querySelector(`[data-testid="note-delete-${id}"]`)),
              row_buttons: [...row.querySelectorAll('button')].map((node) =>
                (node.getAttribute('aria-label') || node.textContent || '')
                  .replace(/\s+/g, ' ')
                  .trim(),
              ),
            }
          : null
      }
      return result
    }, [FIXTURE.d1NoteId, FIXTURE.d2NoteId, FIXTURE.legacyNoteId])
    .catch(() => ({}))
  const editor = await app
    .evaluate(() => {
      const titleNode = document.querySelector('[data-testid="note-editor-title"]')
      const revisionNode = document.querySelector('[data-testid="note-editor-revision"]')
      const contentNode = document.querySelector('textarea.w-md-editor-text-input')
      const saveNow = document.querySelector('[data-testid="note-editor-save-now"]')
      const saveStatusNode = document.querySelector('[data-testid="note-save-status"]')
      const editorDelete = document.querySelector('[data-testid="note-editor-delete"]')
      return {
        present: Boolean(document.querySelector('[data-testid="note-editor"]')),
        title: titleNode ? titleNode.value ?? titleNode.textContent : null,
        revision: revisionNode ? (revisionNode.textContent || '').replace(/\s+/g, ' ').trim() : null,
        contentTail: contentNode ? contentNode.value.slice(-400) : null,
        contentContainsFixture: contentNode
          ? contentNode.value.includes('D1 cohort readout')
          : false,
        saveNowDisabled: saveNow ? Boolean(saveNow.disabled) : null,
        saveStatus: saveStatusNode ? saveStatusNode.getAttribute('data-status') : null,
        editorDelete: editorDelete
          ? {
              aria_label: editorDelete.getAttribute('aria-label'),
              title_attr: editorDelete.getAttribute('title'),
              disabled: Boolean(editorDelete.disabled),
            }
          : null,
      }
    })
    .catch(() => null)
  const bodyText = await app
    .evaluate(() => (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 4000))
    .catch(() => '')
  const drafts = {
    all: await allDraftKeys(app),
    note_d1: await draftKeysForNote(app, FIXTURE.d1NoteId),
    note_d2: await draftKeysForNote(app, FIXTURE.d2NoteId),
  }
  return {
    counts,
    deleteTestids,
    dialog,
    dialogParts,
    deleteError,
    retry,
    statusText,
    rows,
    editor,
    bodyText,
    drafts,
  }
}

const hasText = (state, needle) =>
  typeof state.bodyText === 'string' &&
  state.bodyText.toLowerCase().includes(String(needle).toLowerCase())
const dialogHas = (state, needle) =>
  typeof state.dialog?.text === 'string' &&
  state.dialog.text.toLowerCase().includes(String(needle).toLowerCase())

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
    delete_testids: state.deleteTestids,
    dialog: state.dialog,
    dialog_parts: state.dialogParts,
    delete_error: state.deleteError,
    retry: state.retry,
    rows: state.rows,
    editor: state.editor,
    draft_keys: state.drafts,
    gateway_stats: gatewayStats,
  })
  log(`SHOT ${path.basename(file)} (${size} bytes, sha256=${digest.slice(0, 16)}…)`)
  log(`SHOT-DOM ${path.basename(file)} ${JSON.stringify(state.counts)} delete_testids=${JSON.stringify(state.deleteTestids)}`)
  log(`SHOT-ROWS ${path.basename(file)} ${JSON.stringify(state.rows)}`)
  log(`SHOT-DIALOG-PARTS ${path.basename(file)} ${JSON.stringify(state.dialogParts)}`)
  log(`SHOT-DRAFTS ${path.basename(file)} ${JSON.stringify(state.drafts)}`)
  log(`SHOT-STATS ${path.basename(file)} ${JSON.stringify(gatewayStats)}`)
  return file
}

// ── browser boot / app helpers ────────────────────────────────────────────
const DEV_OVERLAY_CSS =
  'nextjs-portal,[data-nextjs-toast],[data-nextjs-dev-tools-button]{display:none!important;visibility:hidden!important}'

const HEIGHT_BY_WIDTH = (width) => heightFor(width)

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
  // `expectedHttpErrors` = Chromium's own "Failed to load resource: ... 4xx/5xx"
  // console entries for the *intentional* synthetic failure modes of this
  // harness (403/404/409/503). Recorded separately as evidence of the driven
  // mode, not app errors.
  const errors = []
  const expectedHttpErrors = []
  const EXPECTED_HTTP_STATUS =
    /Failed to load resource: the server responded with a status of (400|403|404|409|422|428|500|503)/
  const net = {
    deleteRequests: [],
    deleteResponses: [],
    saveRequests: [],
    models: 0,
    listRequests: 0,
    calls: [],
  }
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
    const pathOnly = url.split('?')[0]
    if (method === 'DELETE' && /\/notes\/[^/]+$/.test(pathOnly)) {
      let body = null
      try {
        body = JSON.parse(request.postData() || 'null')
      } catch {
        body = null
      }
      net.deleteRequests.push({
        path: urlPath,
        contract_header: request.headers()['x-research-note-contract'] || null,
        body,
        body_keys: body && typeof body === 'object' ? Object.keys(body).sort() : [],
        at: Date.now(),
      })
    }
    if (method === 'PATCH' && /\/notes\/[^/]+$/.test(pathOnly)) {
      net.saveRequests.push({ path: urlPath, at: Date.now() })
    }
    if (method === 'GET' && /\/notes$/.test(pathOnly)) net.listRequests += 1
    if (/\/models$/.test(pathOnly)) net.models += 1
  })
  page.on('response', (response) => {
    const url = response.url()
    if (!url.startsWith(GATEWAY_ORIGIN)) return
    const pathOnly = url.split('?')[0]
    if (!/\/notes\/[^/]+$/.test(pathOnly)) return
    const method = response.request().method()
    if (method !== 'DELETE') return
    const record = {
      status: response.status(),
      path: url.replace(/^https?:\/\/[^/]+/, ''),
      body: null,
    }
    net.deleteResponses.push(record)
    response
      .json()
      .then((body) => {
        record.body = body
      })
      .catch(() => {})
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

async function openNote(app, noteId) {
  const open = app.locator(HOOKS.open(noteId)).first()
  if ((await open.count().catch(() => 0)) === 0) return { clicked: false, reason: 'open button absent' }
  await open.click({ timeout: 15000 })
  const ready = await waitFor(async () => {
    const editors = await count(app, HOOKS.editor[0])
    const content = await count(app, 'textarea.w-md-editor-text-input')
    const blocked = await count(app, HOOKS.capabilityBlocked[0])
    return (editors > 0 && content > 0) || blocked > 0
  }, 30000)
  await app.page().waitForTimeout(800)
  return { clicked: true, ready: Boolean(ready) }
}

async function clickDeleteEntry(app, noteId) {
  await hoverRow(app, noteId)
  const entry = app.locator(HOOKS.deleteEntry(noteId)).first()
  if ((await entry.count().catch(() => 0)) === 0) return { clicked: false, reason: 'delete entry absent' }
  await entry.click({ timeout: 15000 })
  await app.page().waitForTimeout(700)
  return { clicked: true }
}

async function clickEditorDelete(app) {
  const entry = app.locator(HOOKS.editorDelete).first()
  if ((await entry.count().catch(() => 0)) === 0) return { clicked: false, reason: 'editor delete absent' }
  const disabled = await entry.isDisabled().catch(() => null)
  await entry.click({ timeout: 15000 })
  await app.page().waitForTimeout(700)
  return { clicked: true, disabled }
}

async function clickDialogButton(app, selectors) {
  for (const selector of selectors) {
    const locator = app.locator(selector).first()
    if ((await locator.count().catch(() => 0)) > 0) {
      const disabled = await locator.isDisabled().catch(() => false)
      await locator.click({ timeout: 15000 })
      await app.page().waitForTimeout(900)
      return { clicked: true, selector, disabled }
    }
  }
  return { clicked: false, selector: null }
}

async function waitDialogPhase(app, phase, timeoutMs = 15000) {
  return waitFor(async () => {
    const dialog = app.locator(HOOKS.dialog[0]).first()
    if ((await dialog.count().catch(() => 0)) === 0) return false
    const actual = await dialog.getAttribute('data-phase').catch(() => null)
    return actual === phase ? actual : false
  }, timeoutMs)
}

async function typeIntoEditor(app, text) {
  const found = await findFirst(app, HOOKS.content)
  if (found.locator === null) return false
  await found.locator.click({ timeout: 10000 })
  await found.locator.press('End')
  await found.locator.type(text, { delay: 5 })
  return true
}

async function waitSaveStatus(app, statuses, timeoutMs = 25000) {
  return waitFor(async () => {
    const info = await app
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
    if (!info) return false
    return statuses.includes(info.status) ? info : false
  }, timeoutMs, 200)
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

// ── real-Chromium layout probe (#1135 MEDIUM-1 lesson) ────────────────────
async function collectLayout(boot) {
  const { app, page } = boot
  const viewport = page.viewportSize() || { width: boot.width, height: boot.height }
  return app
    .evaluate(
      ({ viewport, d1NoteId, legacyNoteId, d1Title, legacyTitle }) => {
        const rect = (el) => {
          if (!el) return null
          const r = el.getBoundingClientRect()
          return {
            x: Math.round(r.x * 100) / 100,
            y: Math.round(r.y * 100) / 100,
            width: Math.round(r.width * 100) / 100,
            height: Math.round(r.height * 100) / 100,
            right: Math.round(r.right * 100) / 100,
            bottom: Math.round(r.bottom * 100) / 100,
          }
        }
        const geometry = (el) => {
          if (!el) return null
          return {
            box: rect(el),
            visible: Boolean(el.offsetWidth || el.offsetHeight || el.getClientRects().length),
            scrollWidth: el.scrollWidth,
            clientWidth: el.clientWidth,
            scrollHeight: el.scrollHeight,
            clientHeight: el.clientHeight,
          }
        }
        const catalog = document.querySelector('[data-testid="note-catalog"]')
        const catalogTab = document.querySelector('[data-testid="note-list-rows"]')
        const row = document.querySelector(`[data-testid="note-catalog-row-${d1NoteId}"]`)
        const legacyRow = document.querySelector(
          `[data-testid="note-catalog-row-${legacyNoteId}"]`,
        )
        if (!row) return { viewport, row: null, catalog: geometry(catalog), catalogTab: geometry(catalogTab) }
        const titleNode =
          document.querySelector(`[data-testid="note-open-${d1NoteId}"]`) ||
          [...row.querySelectorAll('p')].find(
            (el) => (el.textContent || '').trim() === d1Title,
          ) ||
          row.querySelector('.min-w-0.flex-1 p')
        const deleteEntry = row.querySelector(`[data-testid="note-delete-${d1NoteId}"]`)
        const excerpt = row.querySelector(`[data-testid="note-excerpt-${d1NoteId}"]`)
        const legacyTitleNode =
          legacyRow &&
          ([...legacyRow.querySelectorAll('p')].find(
            (el) => (el.textContent || '').trim() === legacyTitle,
          ) ||
            legacyRow.querySelector('.min-w-0.flex-1 p'))
        const legacyButtons = legacyRow ? [...legacyRow.querySelectorAll('button')] : []
        const legacyDelete =
          legacyButtons.find(
            (button) =>
              ((button.getAttribute('aria-label') || button.textContent || '').trim()) === 'Delete',
          ) || null
        const teardown = (button) => {
          if (!button) return null
          const aria = (button.getAttribute('aria-label') || '').trim()
          return {
            label: aria || (button.textContent || '').replace(/\s+/g, ' ').trim(),
            testid: button.getAttribute('data-testid'),
            title_attr: button.getAttribute('title'),
            ...geometry(button),
          }
        }
        return {
          viewport,
          catalog: geometry(catalog),
          catalogTab: geometry(catalogTab),
          row: geometry(row),
          title: titleNode
            ? { text: (titleNode.textContent || '').trim(), ...geometry(titleNode) }
            : null,
          deleteEntry: teardown(deleteEntry),
          excerpt: teardown(excerpt),
          actions: deleteEntry
            ? geometry(deleteEntry.parentElement)
            : excerpt
              ? geometry(excerpt.parentElement)
              : null,
          legacyRow: geometry(legacyRow),
          legacyTitle: legacyTitleNode
            ? { text: (legacyTitleNode.textContent || '').trim(), ...geometry(legacyTitleNode) }
            : null,
          legacyDelete: teardown(legacyDelete),
          legacyActions: legacyDelete ? geometry(legacyDelete.parentElement) : null,
        }
      },
      {
        viewport,
        d1NoteId: FIXTURE.d1NoteId,
        legacyNoteId: FIXTURE.legacyNoteId,
        d1Title: FIXTURE.d1Title,
        legacyTitle: FIXTURE.legacyTitle,
      },
    )
    .catch(() => null)
}

const inside = (box, boundary, tolerance = 1) =>
  Boolean(
    box &&
      boundary &&
      box.width > 0 &&
      box.x >= boundary.x - tolerance &&
      box.right <= boundary.right + tolerance,
  )

/** Compact icon-button upper bound (the #1135 MEDIUM-1 lesson: text buttons
 * squeeze the title column; the frozen contract requires size-7 ≈ 28×28). */
const COMPACT_BUTTON_MAX = 40
const DELETE_ENTRY_ARIA = COPY.deleteEntryAria

function panelBoxFor(layout, fallbackWidth) {
  const viewport = layout?.viewport || { width: fallbackWidth, height: heightFor(fallbackWidth) }
  const catalog = layout?.catalog?.box || null
  return {
    catalog,
    panel: catalog || { x: 0, right: viewport.width, width: viewport.width },
    viewport,
  }
}

/** E1 layout assertions: d2 title / delete icon / excerpt / legacy old Delete. */
function checkRowLayout(check, prefix, layout, width, { expectDeleteEntry }) {
  check(
    `${prefix}.layout_probe_available`,
    Boolean(layout && layout.row),
    `d2-v1 catalog row bounding box measurable (${width}px viewport)`,
    layout && layout.row,
  )
  if (!layout || !layout.row) return { ok: false }
  const { catalog, panel, viewport } = panelBoxFor(layout, width)
  check(
    `${prefix}.layout_catalog_present`,
    Boolean(catalog) && catalog.width > 0,
    'note-catalog bounding box measurable (panel boundary for clipping assertions)',
    catalog,
  )
  const title = layout.title
  check(
    `${prefix}.layout_title_present`,
    Boolean(title) && title.box.width > 0 && title.visible,
    'd2-v1 row title is rendered with a non-zero box',
    title && { text: title.text, width: title.box.width, visible: title.visible },
  )
  check(
    `${prefix}.layout_title_width_gt_20px`,
    Boolean(title) && title.box.width > 20,
    `d2-v1 row title width > 20px at ${width}px viewport (no squeeze by new actions)`,
    title && { width: title.box.width, scrollWidth: title.scrollWidth, clientWidth: title.clientWidth },
  )
  check(
    `${prefix}.layout_title_inside_panel`,
    Boolean(title) && inside(title.box, panel) && title.box.right <= viewport.width + 1,
    'd2-v1 title box is fully inside the Notes catalog and viewport',
    title && { title: title.box, catalog: panel, viewport },
  )
  const excerpt = layout.excerpt
  check(
    `${prefix}.layout_excerpt_present`,
    Boolean(excerpt) && excerpt.box.width > 0,
    'Insert excerpt entry present on the d2-v1 row (coexisting action)',
    excerpt && { label: excerpt.label, box: excerpt.box },
  )
  if (expectDeleteEntry) {
    const entry = layout.deleteEntry
    check(
      `${prefix}.layout_delete_present`,
      Boolean(entry) && entry.box.width > 0 && entry.box.height > 0,
      'note-delete-<id> entry rendered with a non-zero box',
      entry && { testid: entry.testid, box: entry.box },
    )
    check(
      `${prefix}.layout_delete_compact_icon`,
      Boolean(entry) &&
        entry.box.width <= COMPACT_BUTTON_MAX &&
        entry.box.height <= COMPACT_BUTTON_MAX,
      `delete entry is a compact icon button (width/height <= ${COMPACT_BUTTON_MAX}px)`,
      entry && { width: entry.box.width, height: entry.box.height, limit: COMPACT_BUTTON_MAX },
    )
    check(
      `${prefix}.layout_delete_fully_inside_panel`,
      Boolean(entry) && inside(entry.box, panel) && entry.box.right <= viewport.width + 1,
      'delete icon is fully inside the Notes panel/viewport (not clipped)',
      entry && { entry: entry.box, catalogRight: panel.right, viewportWidth: viewport.width },
    )
    check(
      `${prefix}.layout_delete_not_clipped`,
      Boolean(entry) && entry.scrollWidth <= entry.clientWidth + 1,
      'delete icon content is not clipped (scrollWidth <= clientWidth + 1)',
      entry && { scrollWidth: entry.scrollWidth, clientWidth: entry.clientWidth },
    )
    const actions = layout.actions
    check(
      `${prefix}.layout_actions_inside_panel`,
      Boolean(actions) && inside(actions.box, panel),
      'd2-v1 row action area is fully inside the Notes catalog',
      actions && { actions: actions.box, catalogRight: panel.right },
    )
  }
  const legacyDel = layout.legacyDelete
  check(
    `${prefix}.layout_legacy_delete_present`,
    Boolean(legacyDel) && legacyDel.box.width > 0 && legacyDel.visible,
    'legacy row old text Delete action still present (regression guard)',
    legacyDel && { label: legacyDel.label, box: legacyDel.box },
  )
  check(
    `${prefix}.layout_legacy_delete_fully_inside_panel`,
    Boolean(legacyDel) && inside(legacyDel.box, panel),
    'legacy Delete action right edge stays inside the Notes panel (not clipped)',
    legacyDel && { deleteRight: legacyDel.box.right, catalogRight: panel.right },
  )
  check(
    `${prefix}.layout_legacy_delete_not_clipped`,
    Boolean(legacyDel) && legacyDel.scrollWidth <= legacyDel.clientWidth + 1,
    'legacy Delete label is not clipped (scrollWidth <= clientWidth + 1)',
    legacyDel && { scrollWidth: legacyDel.scrollWidth, clientWidth: legacyDel.clientWidth },
  )
  check(
    `${prefix}.layout_legacy_title_present`,
    Boolean(layout.legacyTitle) && layout.legacyTitle.box.width > 0,
    'legacy row title still rendered (old path layout unchanged)',
    layout.legacyTitle && { width: layout.legacyTitle.box.width },
  )
  return { ok: true, panel, title, legacyDel }
}

/**
 * Compare an AFTER screenshot with its BEFORE counterpart (byte sha256).
 * Informational only: next dev can shift anti-aliasing pixels between runs; the
 * cross-phase hard gates are DOM layout equivalence and the tolerant pixel
 * comparison in harness/verify_pixel_equivalence.py.
 */
function compareWithBefore(shotName) {
  const fileName = shotName.endsWith('.png') ? shotName : `${shotName}.png`
  const afterFile = path.join(OUT_DIR, fileName)
  const beforeName = fileName.startsWith('after_')
    ? `before_${fileName.slice('after_'.length)}`
    : fileName
  const beforeFile = path.join(EVIDENCE_ROOT, 'screenshots', 'before', beforeName)
  const exists = fs.existsSync(beforeFile) && fs.existsSync(afterFile)
  if (!exists) return { exists: false, before: beforeName, after: fileName }
  const beforeSha = sha256File(beforeFile)
  const afterSha = sha256File(afterFile)
  return {
    exists: true,
    equal: beforeSha === afterSha,
    beforeSha,
    afterSha,
    before: beforeName,
    after: fileName,
  }
}


// ── E1: d2-v1 catalog row action area (both phases) ───────────────────────
async function sceneE1(browser, width, height) {
  const scene = 'E1'
  const { items, check } = makeAssert()
  await resetHarness({ noteMode: 'editor_on', deleteMode: 'success', saveMode: 'ok' })
  const boot = await bootApp(browser, width, height)
  const app = boot.app
  await openNotes(app)

  const d1Rows = await count(app, HOOKS.row(FIXTURE.d1NoteId))
  const d2Rows = await count(app, HOOKS.row(FIXTURE.d2NoteId))
  const legacyRows = await count(app, HOOKS.row(FIXTURE.legacyNoteId))
  check('e1.d2_row_present', d1Rows >= 1, 'note-catalog-row-note_d1 present', d1Rows)
  check('e1.d2_row_second_present', d2Rows >= 1, 'note-catalog-row-note_d2 present', d2Rows)
  check('e1.legacy_row_present', legacyRows >= 1, 'note-catalog-row-note_legacy present', legacyRows)

  const hovered = await hoverRow(app, FIXTURE.d1NoteId)
  check('e1.row_hovered', hovered, 'd2-v1 row hover works', hovered)
  const state = await collectState(boot)
  const d1Row = state.rows[FIXTURE.d1NoteId] || {}
  const legacyRow = state.rows[FIXTURE.legacyNoteId] || {}
  const layout = await collectLayout(boot)
  log(`${PREFIX} ${scene} layout=${JSON.stringify(layout)}`)
  const shotName = `${PREFIX}_e1_row_actions_${width}`
  await shot(boot, shotName)

  check('e1.d2_row_protected', d1Row.edit_schema === 'd2-v1', 'd2 row data-edit-schema="d2-v1"', d1Row.edit_schema)
  check(
    'e1.d2_revision_shown',
    /revision\s*1\b/i.test(d1Row.revision_text || ''),
    'd2 row shows "Revision 1"',
    d1Row.revision_text,
  )
  check('e1.excerpt_entry_present', d1Row.excerpt_button === true, 'Insert excerpt entry present on d2 row', d1Row.excerpt_button)
  check(
    'e1.legacy_edit_delete_actions',
    (legacyRow.row_buttons || []).includes('Edit') && (legacyRow.row_buttons || []).includes('Delete'),
    'legacy row action area still shows Edit and Delete (old path untouched)',
    legacyRow.row_buttons,
  )

  if (PHASE === 'before') {
    check(
      'e1.before_no_delete_entry',
      state.counts.note_delete_entries === 0 && d1Row.delete_entry !== true,
      '0 note-delete-* testids in the d2-v1 row action area (baseline gap)',
      { entries: state.counts.note_delete_entries, testids: state.deleteTestids },
    )
    check(
      'e1.before_no_editor_delete_entry',
      state.counts.note_editor_delete === 0,
      '0 note-editor-delete testids (no editor open / no editor delete entry at baseline)',
      state.counts.note_editor_delete,
    )
  } else {
    check(
      'e1.after_delete_entry_present',
      d1Row.delete_entry === true &&
        state.counts.note_delete_entries === 2 &&
        state.deleteTestids.includes(`note-delete-${FIXTURE.d1NoteId}`) &&
        state.deleteTestids.includes(`note-delete-${FIXTURE.d2NoteId}`),
      'each of the two d2-v1 rows renders exactly one note-delete-<id> entry (note_d1 included)',
      { entries: state.counts.note_delete_entries, row: d1Row.delete_entry, testids: state.deleteTestids },
    )
    const entry = app.locator(HOOKS.deleteEntry(FIXTURE.d1NoteId)).first()
    check(
      'e1.after_delete_entry_visible_after_hover',
      (await entry.count().catch(() => 0)) > 0 && (await entry.isVisible().catch(() => false)),
      'delete entry visible in the hover-revealed row action area',
      await entry.isVisible().catch(() => false),
    )
    const entryAria = normalize(layout?.deleteEntry?.label)
    check(
      'e1.after_delete_entry_aria_label',
      entryAria === COPY.deleteEntryAria,
      `delete entry aria-label equals frozen copy ("${COPY.deleteEntryAria}")`,
      entryAria,
    )
    check(
      'e1.after_delete_entry_title_attr',
      layout?.deleteEntry?.title_attr === COPY.deleteEntryAria,
      `delete entry title attribute equals frozen copy ("${COPY.deleteEntryAria}")`,
      layout?.deleteEntry?.title_attr,
    )
    check(
      'e1.after_excerpt_entry_kept',
      d1Row.excerpt_button === true,
      'Insert excerpt entry still present next to the delete icon',
      d1Row.excerpt_button,
    )
    check(
      'e1.after_no_dialog_before_click',
      state.counts.note_delete_dialog === 0,
      'no delete dialog before clicking the entry',
      state.counts.note_delete_dialog,
    )
  }
  checkRowLayout(check, 'e1', layout, width, { expectDeleteEntry: PHASE === 'after' })

  const raw = await stats()
  check(
    'e1.no_delete_request_on_row_view',
    (raw.delete_requests || []).length === 0,
    'no DELETE request merely by viewing/hovering the row',
    (raw.delete_requests || []).length,
  )
  log(`${PREFIX} ${scene} console-errors=${JSON.stringify(boot.errors)} expected-http-errors=${JSON.stringify(boot.expectedHttpErrors)}`)
  check('e1.no_console_or_page_errors', boot.errors.length === 0, [], boot.errors)
  await boot.context.close()
  return {
    id: scene,
    width,
    note_mode: 'editor_on',
    delete_mode: 'success',
    layout,
    stats: statsSummary(raw),
    assertions: items,
  }
}

// ── E2 (+E12): confirmation dialog and cancel/Esc/overlay semantics (AFTER) ─
async function dismissDialogByOverlay(boot) {
  const { app, page } = boot
  const dialog = app.locator(HOOKS.dialog[0]).first()
  if ((await dialog.count().catch(() => 0)) === 0) return false
  // The synthetic host bar is 24px tall; click the top-left inside the iframe,
  // outside the centered AlertDialog content → overlay pointer-down outside.
  await page.mouse.click(12, 24 + 12)
  await page.waitForTimeout(900)
  return (await count(app, HOOKS.dialog[0])) === 0
}

async function sceneE2After(browser, width, height) {
  const scene = 'E2'
  const { items, check } = makeAssert()
  await resetHarness({ noteMode: 'editor_on', deleteMode: 'success', saveMode: 'ok' })
  const boot = await bootApp(browser, width, height)
  const app = boot.app
  await openNotes(app)
  const clicked = await clickDeleteEntry(app, FIXTURE.d1NoteId)
  check('e2.delete_entry_clicked', clicked.clicked, 'note-delete-note_d1 clicked', clicked)
  const dialogReady = await waitDialogPhase(app, 'confirming', 15000)
  check('e2.dialog_opened', Boolean(dialogReady), 'note-delete-dialog opened', Boolean(dialogReady))
  const state = await collectState(boot)
  log(`${PREFIX} ${scene} dialog=${JSON.stringify(state.dialog)}`)
  check(
    'e2.dialog_phase_confirming',
    state.dialog?.phase === 'confirming',
    'dialog data-phase=confirming before the user confirms',
    state.dialog?.phase,
  )
  check(
    'e2.dialog_has_confirm_and_cancel',
    state.counts.note_delete_confirm >= 1 && state.counts.note_delete_cancel >= 1,
    'dialog exposes note-delete-confirm and note-delete-cancel',
    { confirm: state.counts.note_delete_confirm, cancel: state.counts.note_delete_cancel },
  )
  const buttons = state.dialog?.buttons || []
  const confirmButton = buttons.find((button) => button.testid === 'note-delete-confirm')
  const cancelButton = buttons.find((button) => button.testid === 'note-delete-cancel')
  check(
    'e2.confirm_button_label',
    normalize(confirmButton?.label) === COPY.confirmButton,
    `confirm button copy is "${COPY.confirmButton}" (destructive action)`,
    confirmButton,
  )
  check(
    'e2.cancel_button_label',
    normalize(cancelButton?.label) === COPY.cancelButton,
    `cancel button copy is "${COPY.cancelButton}"`,
    cancelButton,
  )
  check(
    'e2.confirm_button_enabled',
    confirmButton !== undefined && confirmButton.disabled === false,
    'confirm button enabled in the confirming phase',
    confirmButton,
  )
  check(
    'e2.dialog_title_copy',
    dialogHas(state, COPY.dialogTitle),
    `dialog title copy contains "${COPY.dialogTitle}"`,
    state.dialog?.text,
  )
  check(
    'e2.dialog_description_names_note',
    dialogHas(state, FIXTURE.d1Title) && dialogHas(state, COPY.dialogDescriptionPrefix),
    `dialog description names the target note ("${FIXTURE.d1Title}") and starts with "${COPY.dialogDescriptionPrefix}"`,
    state.dialog?.text,
  )
  check(
    'e2.dialog_description_warns_irreversible',
    dialogHas(state, COPY.dialogDescriptionIrreversible),
    `dialog description says "${COPY.dialogDescriptionIrreversible}"`,
    state.dialog?.text,
  )
  check(
    'e2.dialog_revision_element',
    state.counts.note_delete_revision === 1 &&
      /revision\s*1\b/i.test(state.dialogParts?.revision || ''),
    'note-delete-revision element shows the frozen revision (Revision 1)',
    { count: state.counts.note_delete_revision, text: state.dialogParts?.revision },
  )
  check(
    'e2.dialog_impact_copy_exact',
    state.counts.note_delete_impact === 1 && normalize(state.dialogParts?.impact) === COPY.dialogImpact,
    'note-delete-impact element carries the exact frozen impact copy (saved copies + permission re-check)',
    { count: state.counts.note_delete_impact, text: state.dialogParts?.impact },
  )
  check(
    'e12.dialog_reference_history_copy_visible',
    normalize(state.dialogParts?.impact) === COPY.dialogImpact,
    'E12: reference/history impact explanation is visible in the delete dialog',
    state.dialogParts?.impact,
  )
  check(
    'e2.catalog_path_no_unsaved_local_line',
    state.counts.note_delete_unsaved === 0 && dialogHas(state, COPY.unsavedLocal) === false,
    'note-delete-unsaved line is NOT rendered when no note is open with unsaved changes',
    { count: state.counts.note_delete_unsaved, text: state.dialogParts?.unsaved },
  )
  await shot(boot, `${PREFIX}_e2_delete_dialog_${width}`)

  const rawBefore = await stats()
  check(
    'e2.no_delete_request_before_confirm',
    (rawBefore.delete_requests || []).length === 0,
    '0 DELETE requests while the dialog is confirming',
    (rawBefore.delete_requests || []).length,
  )

  // Esc cancels the confirming dialog without any request.
  const dialogLocator = app.locator(HOOKS.dialog[0]).first()
  await dialogLocator.press('Escape').catch(() => {})
  await boot.page.waitForTimeout(800)
  const afterEsc = await collectState(boot)
  const escStats = await stats()
  check(
    'e2.esc_cancels_without_request',
    afterEsc.counts.note_delete_dialog === 0 &&
      (escStats.delete_requests || []).length === 0 &&
      afterEsc.counts.note_delete_entries === 2,
    'Esc closes the confirming dialog without sending DELETE; the entry stays available',
    {
      dialog: afterEsc.counts.note_delete_dialog,
      entries: afterEsc.counts.note_delete_entries,
      deletes: (escStats.delete_requests || []).length,
    },
  )

  // Cancel button closes the dialog without any request.
  const reopened = await clickDeleteEntry(app, FIXTURE.d1NoteId)
  check('e2.entry_reopened_after_esc', reopened.clicked, 'delete entry can be clicked again after Esc', reopened)
  await waitDialogPhase(app, 'confirming', 15000)
  const cancelled = await clickDialogButton(app, HOOKS.cancel)
  check('e2.cancel_clicked', cancelled.clicked, 'note-delete-cancel clicked', cancelled)
  const afterCancel = await collectState(boot)
  const cancelStats = await stats()
  check(
    'e2.cancel_closes_without_request',
    afterCancel.counts.note_delete_dialog === 0 && (cancelStats.delete_requests || []).length === 0,
    'Cancel closes the dialog without sending DELETE',
    { dialog: afterCancel.counts.note_delete_dialog, deletes: (cancelStats.delete_requests || []).length },
  )

  // Overlay (pointer-down outside) — frozen contract §2 expects this to close
  // the confirming dialog. Radix `AlertDialog` prevents outside interaction by
  // default (onPointerDownOutside/onInteractOutside -> preventDefault) unless the
  // component opts in, so the harness records the OBSERVED behavior and reports
  // a contract deviation instead of fabricating a PASS.
  const reopen2 = await clickDeleteEntry(app, FIXTURE.d1NoteId)
  check('e2.entry_reopened_after_cancel', reopen2.clicked, 'delete entry clicked again after Cancel', reopen2)
  await waitDialogPhase(app, 'confirming', 15000)
  const overlayClosed = await dismissDialogByOverlay(boot)
  const overlayStats = await stats()
  const overlayDeletes = (overlayStats.delete_requests || []).length
  let deviation = null
  if (overlayClosed) {
    check(
      'e2.overlay_dismiss_without_request',
      overlayDeletes === 0,
      'clicking the overlay closes the confirming dialog without sending DELETE (contract §2)',
      { closed: true, deletes: overlayDeletes },
    )
  } else {
    deviation = {
      contract: 'evidence contract §2: 点遮罩 → 关闭对话框（不发送请求）',
      observed:
        'overlay pointer-down outside does NOT close the confirming dialog; Radix AlertDialog prevents outside interaction unless NoteDeleteDialog opts in via onPointerDownOutside/onInteractOutside',
      impact: 'Esc and Cancel still close the dialog without a request; no DELETE was emitted by the overlay click',
      evidence: 'scenes[].contract_deviations / capture.log e2.overlay_click_observed',
    }
    log(`${PREFIX} ${scene} CONTRACT-DEVIATION overlay-dismiss observed=not-closed deletes=${overlayDeletes}`)
    check(
      'e2.overlay_click_no_dismiss_observed',
      overlayClosed === false && overlayDeletes === 0,
      'observed behavior: overlay click does not dismiss the Radix AlertDialog and emits no DELETE (contract deviation recorded)',
      { closed: overlayClosed, deletes: overlayDeletes },
    )
    // Leave the dialog in a clean state for the next assertions / screenshot.
    await app.locator(HOOKS.dialog[0]).first().press('Escape').catch(() => {})
    await boot.page.waitForTimeout(500)
  }

  const raw = await stats()
  log(`${PREFIX} ${scene} console-errors=${JSON.stringify(boot.errors)} expected-http-errors=${JSON.stringify(boot.expectedHttpErrors)}`)
  check('e2.no_console_or_page_errors', boot.errors.length === 0, [], boot.errors)
  await boot.context.close()
  return {
    id: scene,
    width,
    note_mode: 'editor_on',
    delete_mode: 'success',
    deviations: deviation === null ? [] : [deviation],
    stats: statsSummary(raw),
    assertions: items,
  }
}

// ── E3: catalog-row delete success (AFTER) ────────────────────────────────
async function waitRowGone(app, noteId, timeoutMs = 20000) {
  return waitFor(async () => (await count(app, HOOKS.row(noteId))) === 0, timeoutMs, 250)
}

async function waitToast(app, text, timeoutMs = 15000) {
  return waitFor(async () => {
    const body = await app
      .evaluate(() => (document.body.innerText || '').replace(/\s+/g, ' '))
      .catch(() => '')
    return body.toLowerCase().includes(String(text).toLowerCase())
  }, timeoutMs, 250)
}

async function sceneE3After(browser, width, height) {
  const scene = 'E3'
  const { items, check } = makeAssert()
  await resetHarness({ noteMode: 'editor_on', deleteMode: 'success', saveMode: 'ok' })
  const boot = await bootApp(browser, width, height)
  const app = boot.app
  await openNotes(app)
  const seeded = await seedDraftBranches(app, FIXTURE.d1NoteId)
  log(`${PREFIX} ${scene} seeded-drafts=${JSON.stringify(seeded)}`)
  check(
    'e3.draft_branches_seeded',
    Array.isArray(seeded?.keys) && seeded.keys.length === 2,
    '2 sessionStorage draft branches seeded (current tab + other tab) before the delete',
    seeded?.keys,
  )
  const statsBefore = await stats()
  const listsBefore = (statsBefore.list_requests || []).filter((entry) => entry.selected).length

  const clicked = await clickDeleteEntry(app, FIXTURE.d1NoteId)
  check('e3.delete_entry_clicked', clicked.clicked, 'note-delete-note_d1 clicked', clicked)
  await waitDialogPhase(app, 'confirming', 15000)
  const confirming = await collectState(boot)
  check(
    'e3.confirming_revision_is_row_revision',
    /revision\s*1\b/i.test(confirming.dialogParts?.revision || '') &&
      /revision\s*1\b/i.test((confirming.rows[FIXTURE.d1NoteId] || {}).revision_text || ''),
    'dialog revision (Revision 1) equals the catalog row revision before the delete',
    { dialog: confirming.dialogParts?.revision, row: (confirming.rows[FIXTURE.d1NoteId] || {}).revision_text },
  )
  const confirmed = await clickDialogButton(app, HOOKS.confirm)
  check('e3.confirm_clicked', confirmed.clicked, 'note-delete-confirm clicked', confirmed)
  const toastSeen = await waitToast(app, COPY.successToast, 15000)
  check('e3.success_toast_shown', Boolean(toastSeen), `success toast "${COPY.successToast}" shown`, Boolean(toastSeen))
  const rowGone = await waitRowGone(app, FIXTURE.d1NoteId, 20000)
  check('e3.row_removed_from_catalog', Boolean(rowGone), 'deleted d2 note row disappears from the catalog', Boolean(rowGone))
  await boot.page.waitForTimeout(600)
  const state = await collectState(boot)
  check('e3.dialog_closed_after_success', state.counts.note_delete_dialog === 0, 'delete dialog closed after success', state.counts.note_delete_dialog)
  check(
    'e3.draft_branches_cleared',
    state.drafts.note_d1.length === 0,
    'ALL draft-cache tab branches for the deleted note are removed (both seeded keys)',
    { remaining: state.drafts.note_d1, all: state.drafts.all },
  )
  await shot(boot, `${PREFIX}_e3_deleted_catalog_${width}`)

  const raw = await stats()
  const deletes = raw.delete_requests || []
  check('e3.exactly_one_delete', deletes.length === 1, 'exactly 1 DELETE request recorded', deletes.length)
  const only = deletes[0] || {}
  check(
    'e3.delete_contract_header',
    only.contract_header === 'd2-v1',
    'DELETE carries X-Research-Note-Contract: d2-v1',
    only.contract_header,
  )
  check(
    'e3.delete_body_exact_keys',
    JSON.stringify(only.body_keys) === JSON.stringify(['expected_revision', 'mutation_id']),
    'DELETE JSON body has exactly {mutation_id, expected_revision}',
    only.body_keys,
  )
  check(
    'e3.delete_expected_revision',
    only.expected_revision === 1,
    'expected_revision equals the catalog row revision (1)',
    only.expected_revision,
  )
  check(
    'e3.delete_mutation_id_present',
    typeof only.mutation_id === 'string' && only.mutation_id.length > 0,
    'DELETE carries a non-empty mutation_id',
    only.mutation_id,
  )
  check('e3.delete_status_ok', only.status === 200 && only.outcome === 'deleted', 'DELETE responded 200 (deleted outcome)', { status: only.status, outcome: only.outcome })
  check('e3.delete_receipt_shape', only.applied === true && (raw.delete_applies || []).length === 1, 'APPROX receipt applied: exactly one semantic delete recorded', { applied: only.applied, applies: (raw.delete_applies || []).length })
  const responseBody = (boot.net.deleteResponses || [])[0]?.body || null
  check(
    'e3.delete_receipt_fields',
    responseBody !== null &&
      responseBody.note_id === FIXTURE.d1NoteId &&
      responseBody.snapshot_hash === null &&
      responseBody.applied_revision === 1 &&
      responseBody.replayed === false,
    'receipt {note_id, applied_revision:1, snapshot_hash:null, replayed:false} returned',
    responseBody,
  )
  check(
    'e3.exactly_one_semantic_delete',
    raw.semantic_deletes === 1 && (raw.legacy_deletes || []).length === 0,
    'exactly 1 semantic d2-v1 delete (no legacy delete)',
    { semantic_deletes: raw.semantic_deletes, legacy: (raw.legacy_deletes || []).length },
  )
  const listsAfter = (raw.list_requests || []).filter((entry) => entry.selected).length
  check(
    'e3.catalog_refreshed_after_delete',
    listsAfter > listsBefore,
    'catalog notes list re-GET after the delete (refresh)',
    { before: listsBefore, after: listsAfter },
  )
  check(
    'e3.note_gone_server_side',
    (await currentNote(FIXTURE.d1NoteId)) === null,
    'server store no longer contains note_d1',
    await currentNote(FIXTURE.d1NoteId),
  )
  const noteLabels = statsSummary(raw).notes || []
  check(
    'e3.other_d2_note_still_present',
    noteLabels.some((note) => note.startsWith(`${FIXTURE.d2NoteId}@`)),
    'second d2-v1 note untouched',
    noteLabels,
  )
  check(
    'e3.legacy_note_still_present',
    noteLabels.some((note) => note.startsWith(`${FIXTURE.legacyNoteId}@legacy`)),
    'legacy note untouched by the d2-v1 delete',
    noteLabels,
  )
  log(`${PREFIX} ${scene} console-errors=${JSON.stringify(boot.errors)} expected-http-errors=${JSON.stringify(boot.expectedHttpErrors)}`)
  check('e3.no_console_or_page_errors', boot.errors.length === 0, [], boot.errors)
  await boot.context.close()
  return {
    id: scene,
    width,
    note_mode: 'editor_on',
    delete_mode: 'success',
    seeded_draft_keys: seeded?.keys || [],
    stats: statsSummary(raw),
    assertions: items,
  }
}

// ── E4: editor-toolbar delete success with unsaved local text (AFTER) ──────
async function sceneE4After(browser, width, height) {
  const scene = 'E4'
  const { items, check } = makeAssert()
  await resetHarness({ noteMode: 'editor_on', deleteMode: 'success', saveMode: 'fail503' })
  const boot = await bootApp(browser, width, height)
  const app = boot.app
  await openNotes(app)
  const opened = await openNote(app, FIXTURE.d1NoteId)
  check('e4.note_opened_in_editor', opened.clicked && Boolean(opened.ready), 'd2-v1 note opened in the Markdown editor', opened)
  const editorBefore = await collectState(boot)
  check(
    'e4.editor_entry_rendered',
    editorBefore.counts.note_editor_delete >= 1,
    'note-editor-delete entry rendered in the editor toolbar',
    editorBefore.counts.note_editor_delete,
  )
  const entryInfo = editorBefore.editor?.editorDelete || null
  check(
    'e4.editor_entry_aria_label',
    normalize(entryInfo?.aria_label) === COPY.deleteEntryAria,
    `editor delete entry aria-label equals frozen copy ("${COPY.deleteEntryAria}")`,
    entryInfo,
  )
  // Drive real unsaved local text: the synthetic gateway rejects d2-v1 saves
  // (retryable 503), so the editor keeps unsaved local text deterministically.
  const typed = await typeIntoEditor(app, '\n\n[synthetic] unsaved local line for E4')
  check('e4.typed_unsaved_local_text', typed, 'typed unsaved local text into the open editor', typed)
  const failedStatus = await waitSaveStatus(app, ['failed'], 25000)
  check(
    'e4.editor_has_unsaved_local_changes',
    Boolean(failedStatus),
    'editor state reports unsaved local changes (synthetic save failure keeps local text)',
    failedStatus,
  )
  const seeded = await seedDraftBranches(app, FIXTURE.d1NoteId)
  check(
    'e4.draft_branches_seeded',
    Array.isArray(seeded?.keys) && seeded.keys.length === 2,
    '2 draft-cache tab branches seeded for the open note',
    seeded?.keys,
  )
  const clicked = await clickEditorDelete(app)
  check('e4.editor_delete_clicked', clicked.clicked, 'note-editor-delete clicked', clicked)
  check('e4.editor_delete_enabled', clicked.disabled === false, 'editor delete entry is enabled while local text is unsaved (not saving/inserting)', clicked.disabled)
  await waitDialogPhase(app, 'confirming', 15000)
  const dialogState = await collectState(boot)
  log(`${PREFIX} ${scene} dialog=${JSON.stringify(dialogState.dialog)}`)
  check(
    'e4.dialog_opened_from_editor',
    dialogState.counts.note_delete_dialog >= 1 && dialogState.dialog?.phase === 'confirming',
    'the editor entry opens the same delete dialog (confirming)',
    { dialog: dialogState.counts.note_delete_dialog, phase: dialogState.dialog?.phase },
  )
  check(
    'e4.unsaved_local_line_shown',
    dialogState.counts.note_delete_unsaved === 1 &&
      normalize(dialogState.dialogParts?.unsaved) === COPY.unsavedLocal,
    'note-delete-unsaved element shows the exact unsavedLocal warning for the open note',
    { count: dialogState.counts.note_delete_unsaved, text: dialogState.dialogParts?.unsaved },
  )
  await shot(boot, `${PREFIX}_e4_editor_delete_dialog_${width}`)
  const confirmed = await clickDialogButton(app, HOOKS.confirm)
  check('e4.confirm_clicked', confirmed.clicked, 'note-delete-confirm clicked from the editor dialog', confirmed)
  const toastSeen = await waitToast(app, COPY.successToast, 15000)
  check('e4.success_toast_shown', Boolean(toastSeen), `success toast "${COPY.successToast}" shown`, Boolean(toastSeen))
  const rowGone = await waitRowGone(app, FIXTURE.d1NoteId, 20000)
  const editorGone = await waitFor(async () => (await count(app, HOOKS.editor[0])) === 0, 20000, 250)
  const leaveGuard = await count(app, HOOKS.leaveGuard[0])
  const afterState = await collectState(boot)
  check('e4.row_removed_from_catalog', Boolean(rowGone), 'deleted note row disappears from the catalog', Boolean(rowGone))
  check('e4.editor_closed_after_delete', Boolean(editorGone), 'open editor is closed after the confirmed delete', Boolean(editorGone))
  check(
    'e4.no_leave_guard_second_dialog',
    leaveGuard === 0 && afterState.counts.leave_guard_dialog === 0,
    'no leave-protection second dialog after the explicit delete confirmation',
    leaveGuard,
  )
  check('e4.dialog_closed_after_success', afterState.counts.note_delete_dialog === 0, 'delete dialog closed after success', afterState.counts.note_delete_dialog)
  check(
    'e4.draft_branches_cleared',
    afterState.drafts.note_d1.length === 0,
    'ALL draft-cache tab branches for the deleted note are removed',
    { remaining: afterState.drafts.note_d1, all: afterState.drafts.all },
  )
  await shot(boot, `${PREFIX}_e4_after_delete_${width}`)
  const raw = await stats()
  const deletes = raw.delete_requests || []
  check('e4.exactly_one_delete', deletes.length === 1, 'exactly 1 DELETE request from the editor entry', deletes.length)
  const only = deletes[0] || {}
  check(
    'e4.delete_contract_and_body',
    only.contract_header === 'd2-v1' &&
      JSON.stringify(only.body_keys) === JSON.stringify(['expected_revision', 'mutation_id']) &&
      only.expected_revision === 1,
    'DELETE contract header d2-v1 + exact {mutation_id, expected_revision:1} body',
    only,
  )
  check('e4.exactly_one_semantic_delete', raw.semantic_deletes === 1, 'exactly one semantic delete', raw.semantic_deletes)
  check(
    'e4.note_gone_server_side',
    (await currentNote(FIXTURE.d1NoteId)) === null,
    'server store no longer contains note_d1',
    await currentNote(FIXTURE.d1NoteId),
  )
  log(`${PREFIX} ${scene} console-errors=${JSON.stringify(boot.errors)} expected-http-errors=${JSON.stringify(boot.expectedHttpErrors)}`)
  check('e4.no_console_or_page_errors', boot.errors.length === 0, [], boot.errors)
  await boot.context.close()
  return {
    id: scene,
    width,
    note_mode: 'editor_on',
    delete_mode: 'success',
    save_mode: 'fail503',
    stats: statsSummary(raw),
    assertions: items,
  }
}

// ── E5: 403 note_access_restricted (AFTER) ────────────────────────────────
async function sceneE5After(browser, width, height) {
  const scene = 'E5'
  const { items, check } = makeAssert()
  await resetHarness({ noteMode: 'editor_on', deleteMode: 'restricted403', saveMode: 'ok' })
  const boot = await bootApp(browser, width, height)
  const app = boot.app
  await openNotes(app)
  const clicked = await clickDeleteEntry(app, FIXTURE.d1NoteId)
  check('e5.delete_entry_clicked', clicked.clicked, 'note-delete-note_d1 clicked', clicked)
  await waitDialogPhase(app, 'confirming', 15000)
  const confirmed = await clickDialogButton(app, HOOKS.confirm)
  check('e5.confirm_clicked', confirmed.clicked, 'note-delete-confirm clicked', confirmed)
  const errorShown = await waitFor(async () => (await count(app, HOOKS.error[0])) > 0, 25000)
  check('e5.error_state_shown', Boolean(errorShown), 'note-delete-error >= 1 (403 restricted)', Boolean(errorShown))
  const state = await collectState(boot)
  log(`${PREFIX} ${scene} state=${JSON.stringify({ counts: state.counts, error: state.deleteError, retry: state.retry })}`)
  check(
    'e5.error_kind_restricted',
    state.deleteError?.failure_kind === 'restricted',
    'note-delete-error data-failure-kind=restricted',
    state.deleteError,
  )
  check(
    'e5.error_dialog_stays_open',
    state.counts.note_delete_dialog >= 1 && state.dialog?.phase === 'error',
    'error stays in the dialog (data-phase=error) so the user sees the terminal reason',
    { dialog: state.counts.note_delete_dialog, phase: state.dialog?.phase },
  )
  check(
    'e5.no_retry_for_terminal_error',
    state.counts.note_delete_retry === 0 && state.counts.note_delete_close >= 1,
    'terminal 403 exposes no retry action (only Close)',
    { retry: state.counts.note_delete_retry, close: state.counts.note_delete_close },
  )
  check(
    'e5.restricted_error_copy',
    dialogHas(state, COPY.errorRestricted),
    `restricted error copy is visible ("${COPY.errorRestricted}")`,
    state.dialogParts?.error,
  )
  const closeButton = (state.dialog?.buttons || []).find((button) => button.testid === 'note-delete-close')
  check(
    'e5.close_button_copy',
    normalize(closeButton?.label) === COPY.closeButton,
    `terminal error exposes the "${COPY.closeButton}" button`,
    closeButton,
  )
  await shot(boot, `${PREFIX}_e5_restricted_error_${width}`)
  const raw = await stats()
  const deletes = raw.delete_requests || []
  check(
    'e5.exactly_one_restricted_request',
    deletes.length === 1 && deletes[0].status === 403 && deletes[0].outcome === 'restricted',
    '1 DELETE → 403 note_access_restricted',
    deletes.map((entry) => ({ outcome: entry.outcome, status: entry.status })),
  )
  check('e5.zero_semantic_deletes', raw.semantic_deletes === 0, '0 applied semantic deletes on 403', raw.semantic_deletes)
  const note = await currentNote(FIXTURE.d1NoteId)
  check(
    'e5.note_still_in_catalog_store',
    note !== null && note.edit_schema === 'd2-v1',
    'note still exists server-side after the 403',
    note && { note_id: note.note_id, edit_schema: note.edit_schema },
  )
  // Close the error dialog: the row must still be present in the catalog.
  await clickDialogButton(app, HOOKS.close)
  await boot.page.waitForTimeout(600)
  const afterClose = await collectState(boot)
  check(
    'e5.row_still_listed_after_close',
    (await count(app, HOOKS.row(FIXTURE.d1NoteId))) === 1 &&
      afterClose.counts.note_delete_dialog === 0,
    'catalog still lists the note after closing the restricted error; dialog closed',
    { row: await count(app, HOOKS.row(FIXTURE.d1NoteId)), dialog: afterClose.counts.note_delete_dialog },
  )
  const finalStats = await stats()
  check(
    'e5.close_emits_no_extra_delete',
    (finalStats.delete_requests || []).length === 1,
    'closing the terminal error emits no extra DELETE',
    (finalStats.delete_requests || []).length,
  )
  log(`${PREFIX} ${scene} console-errors=${JSON.stringify(boot.errors)} expected-http-errors=${JSON.stringify(boot.expectedHttpErrors)}`)
  check('e5.no_console_or_page_errors', boot.errors.length === 0, [], boot.errors)
  await boot.context.close()
  return {
    id: scene,
    width,
    note_mode: 'editor_on',
    delete_mode: 'restricted403',
    stats: statsSummary(raw),
    assertions: items,
  }
}

// ── E6: 409 note_revision_conflict → refresh & review → delete (AFTER) ────
async function sceneE6After(browser, width, height) {
  const scene = 'E6'
  const { items, check } = makeAssert()
  await resetHarness({ noteMode: 'editor_on', deleteMode: 'conflict409', saveMode: 'ok' })
  const boot = await bootApp(browser, width, height)
  const app = boot.app
  await openNotes(app)
  const before = await collectState(boot)
  check(
    'e6.target_row_revision_one',
    /revision\s*1\b/i.test((before.rows[FIXTURE.d2NoteId] || {}).revision_text || ''),
    'target d2-v1 row starts at Revision 1',
    (before.rows[FIXTURE.d2NoteId] || {}).revision_text,
  )
  const clicked = await clickDeleteEntry(app, FIXTURE.d2NoteId)
  check('e6.delete_entry_clicked', clicked.clicked, 'note-delete-note_d2 clicked', clicked)
  await waitDialogPhase(app, 'confirming', 15000)
  const confirmed = await clickDialogButton(app, HOOKS.confirm)
  check('e6.confirm_clicked', confirmed.clicked, 'note-delete-confirm clicked (first attempt)', confirmed)
  const errorShown = await waitFor(async () => (await count(app, HOOKS.error[0])) > 0, 25000)
  check('e6.error_state_shown', Boolean(errorShown), 'note-delete-error >= 1 (409 conflict)', Boolean(errorShown))
  const conflictState = await collectState(boot)
  log(`${PREFIX} ${scene} conflict=${JSON.stringify({ counts: conflictState.counts, error: conflictState.deleteError, retry: conflictState.retry })}`)
  check(
    'e6.error_kind_conflict',
    conflictState.deleteError?.failure_kind === 'conflict',
    'note-delete-error data-failure-kind=conflict',
    conflictState.deleteError,
  )
  check(
    'e6.retry_offered_refresh_and_review',
    conflictState.counts.note_delete_retry >= 1,
    'retry action offered for the 409 conflict',
    conflictState.counts.note_delete_retry,
  )
  check(
    'e6.retry_label_refresh_and_review',
    normalize(conflictState.retry?.label) === COPY.retryRefreshAndReview,
    `conflict retry copy is "${COPY.retryRefreshAndReview}"`,
    conflictState.retry,
  )
  check(
    'e6.conflict_error_copy',
    dialogHas(conflictState, COPY.errorConflict),
    `conflict error copy is visible ("${COPY.errorConflict}")`,
    conflictState.dialogParts?.error,
  )
  await shot(boot, `${PREFIX}_e6_conflict_error_${width}`)
  const firstStats = await stats()
  check(
    'e6.first_attempt_conflict',
    (firstStats.delete_requests || []).length === 1 &&
      (firstStats.delete_requests || [])[0].status === 409 &&
      (firstStats.delete_requests || [])[0].expected_revision === 1,
    'first DELETE → 409 with expected_revision 1 (row revision)',
    (firstStats.delete_requests || []).map((entry) => ({ status: entry.status, expected_revision: entry.expected_revision })),
  )
  check('e6.no_semantic_delete_on_conflict', firstStats.semantic_deletes === 0, '0 semantic deletes after the 409', firstStats.semantic_deletes)
  const firstMutationId = (firstStats.delete_requests || [])[0]?.mutation_id || null

  const retried = await clickDialogButton(app, HOOKS.retry)
  check('e6.refresh_and_review_clicked', retried.clicked, 'Refresh and review clicked', retried)
  const backToConfirming = await waitDialogPhase(app, 'confirming', 25000)
  check(
    'e6.dialog_back_to_confirming',
    Boolean(backToConfirming),
    'after refreshing the catalog the dialog returns to data-phase=confirming (row still exists)',
    backToConfirming,
  )
  await boot.page.waitForTimeout(700)
  const refreshed = await collectState(boot)
  const refreshedRow = refreshed.rows[FIXTURE.d2NoteId] || {}
  check(
    'e6.row_refreshed_to_revision_two',
    /revision\s*2\b/i.test(refreshedRow.revision_text || ''),
    'catalog row refreshed to Revision 2 (new revision reviewed before confirming)',
    refreshedRow.revision_text,
  )
  check(
    'e6.dialog_still_names_note',
    dialogHas(refreshed, FIXTURE.d2Title),
    'confirming dialog still names the target note after refresh',
    refreshed.dialog?.text,
  )
  check(
    'e6.dialog_revision_is_two',
    /revision\s*2\b/i.test(refreshed.dialogParts?.revision || ''),
    'note-delete-revision shows Revision 2 (the refreshed, server-authorized revision)',
    refreshed.dialogParts?.revision,
  )
  await shot(boot, `${PREFIX}_e6_refresh_confirming_${width}`)
  const confirmed2 = await clickDialogButton(app, HOOKS.confirm)
  check('e6.second_confirm_clicked', confirmed2.clicked, 'confirmed again at revision 2', confirmed2)
  const rowGone = await waitRowGone(app, FIXTURE.d2NoteId, 20000)
  check('e6.row_removed_after_second_confirm', Boolean(rowGone), 'row disappears after the second (revision 2) confirm', Boolean(rowGone))
  await boot.page.waitForTimeout(700)
  const final = await collectState(boot)
  check('e6.dialog_closed_after_success', final.counts.note_delete_dialog === 0, 'dialog closed after the successful second Delete', final.counts.note_delete_dialog)
  await shot(boot, `${PREFIX}_e6_deleted_${width}`)
  const raw = await stats()
  const deletes = raw.delete_requests || []
  check('e6.two_delete_attempts', deletes.length === 2, '2 DELETE requests recorded (conflict + retry)', deletes.length)
  check(
    'e6.expected_revision_progression',
    deletes.length === 2 && deletes[0].expected_revision === 1 && deletes[1].expected_revision === 2,
    'expected_revision 1 → 2 after refresh',
    deletes.map((entry) => entry.expected_revision),
  )
  check(
    'e6.different_mutation_ids',
    deletes.length === 2 && deletes[0].mutation_id !== deletes[1].mutation_id,
    'the re-confirmed delete uses a NEW mutation_id (different request)',
    deletes.map((entry) => entry.mutation_id),
  )
  check('e6.exactly_one_semantic_delete', raw.semantic_deletes === 1, 'exactly one semantic delete', raw.semantic_deletes)
  check(
    'e6.second_attempt_succeeded',
    deletes.length === 2 && deletes[1].status === 200 && deletes[1].outcome === 'deleted',
    'second DELETE → 200 deleted',
    deletes[1],
  )
  check(
    'e6.note_gone_server_side',
    (await currentNote(FIXTURE.d2NoteId)) === null,
    'server store no longer contains note_d2',
    await currentNote(FIXTURE.d2NoteId),
  )
  log(`${PREFIX} ${scene} console-errors=${JSON.stringify(boot.errors)} expected-http-errors=${JSON.stringify(boot.expectedHttpErrors)}`)
  check('e6.no_console_or_page_errors', boot.errors.length === 0, [], boot.errors)
  await boot.context.close()
  return {
    id: scene,
    width,
    note_mode: 'editor_on',
    delete_mode: 'conflict409',
    mutation_ids: { first: firstMutationId, second: deletes[1]?.mutation_id || null },
    stats: statsSummary(raw),
    assertions: items,
  }
}

// ── E7: unknown result (delete applied, 503) → Confirm result replay (AFTER) ─
async function sceneE7After(browser, width, height) {
  const scene = 'E7'
  const { items, check } = makeAssert()
  await resetHarness({ noteMode: 'editor_on', deleteMode: 'unknown503_apply', saveMode: 'ok' })
  const boot = await bootApp(browser, width, height)
  const app = boot.app
  await openNotes(app)
  const clicked = await clickDeleteEntry(app, FIXTURE.d1NoteId)
  check('e7.delete_entry_clicked', clicked.clicked, 'note-delete-note_d1 clicked', clicked)
  await waitDialogPhase(app, 'confirming', 15000)
  const confirmed = await clickDialogButton(app, HOOKS.confirm)
  check('e7.confirm_clicked', confirmed.clicked, 'note-delete-confirm clicked', confirmed)
  const unknownShown = await waitFor(async () => (await count(app, HOOKS.error[0])) > 0, 25000)
  check('e7.unknown_state_shown', Boolean(unknownShown), 'note-delete-error >= 1 (unknown result)', Boolean(unknownShown))
  const unknownState = await collectState(boot)
  log(`${PREFIX} ${scene} unknown=${JSON.stringify({ counts: unknownState.counts, error: unknownState.deleteError, retry: unknownState.retry })}`)
  check(
    'e7.unknown_kind_reported',
    unknownState.deleteError?.failure_kind === 'unknown',
    'note-delete-error data-failure-kind=unknown (outcome could not be confirmed)',
    unknownState.deleteError,
  )
  check(
    'e7.confirm_result_action_present',
    unknownState.counts.note_delete_retry >= 1,
    'unknown state exposes the retry slot ("Confirm result")',
    unknownState.counts.note_delete_retry,
  )
  check(
    'e7.confirm_result_label',
    normalize(unknownState.retry?.label) === COPY.retryConfirmResult,
    `unknown-state action copy is "${COPY.retryConfirmResult}"`,
    unknownState.retry,
  )
  check(
    'e7.unknown_error_copy',
    dialogHas(unknownState, COPY.errorUnknown),
    `unknown-result error copy is visible ("${COPY.errorUnknown}")`,
    unknownState.dialogParts?.error,
  )
  await shot(boot, `${PREFIX}_e7_unknown_error_${width}`)
  const firstStats = await stats()
  check(
    'e7.first_attempt_unknown_applied',
    (firstStats.delete_requests || []).length === 1 &&
      (firstStats.delete_requests || [])[0].status === 503 &&
      (firstStats.delete_requests || [])[0].outcome === 'unknown_applied' &&
      (firstStats.delete_requests || [])[0].applied === true,
    'first DELETE applied the delete but returned 503 note_store_unavailable',
    (firstStats.delete_requests || []).map((entry) => ({ status: entry.status, outcome: entry.outcome, applied: entry.applied })),
  )
  const firstMutationId = (firstStats.delete_requests || [])[0]?.mutation_id || null

  const replay = await clickDialogButton(app, HOOKS.retry)
  check('e7.confirm_result_clicked', replay.clicked, 'Confirm result clicked', replay)
  const rowGone = await waitRowGone(app, FIXTURE.d1NoteId, 25000)
  const toastSeen = await waitToast(app, COPY.successToast, 15000)
  await boot.page.waitForTimeout(600)
  const final = await collectState(boot)
  check('e7.row_removed_after_replay', Boolean(rowGone), 'row disappears after the same-mutation receipt replay', Boolean(rowGone))
  check('e7.success_toast_shown', Boolean(toastSeen), `success toast "${COPY.successToast}" shown after replay`, Boolean(toastSeen))
  check('e7.dialog_closed_after_success', final.counts.note_delete_dialog === 0, 'dialog closed after the replay success', final.counts.note_delete_dialog)
  await shot(boot, `${PREFIX}_e7_after_confirm_result_${width}`)
  const raw = await stats()
  const deletes = raw.delete_requests || []
  check('e7.two_delete_attempts', deletes.length === 2, '2 DELETE requests recorded (503 + replay)', deletes.length)
  check(
    'e7.same_mutation_id_replayed',
    deletes.length === 2 && deletes[0].mutation_id === firstMutationId && deletes[1].mutation_id === firstMutationId,
    'both attempts used the SAME mutation_id',
    deletes.map((entry) => entry.mutation_id),
  )
  check(
    'e7.same_expected_revision',
    deletes.length === 2 && deletes[0].expected_revision === 1 && deletes[1].expected_revision === 1,
    'both attempts used the same expected_revision (1)',
    deletes.map((entry) => entry.expected_revision),
  )
  check(
    'e7.second_attempt_replayed_receipt',
    deletes.length === 2 && deletes[1].status === 200 && deletes[1].outcome === 'replayed' && deletes[1].replay === true,
    'second attempt is a receipt replay (200 replayed:true)',
    deletes[1],
  )
  check(
    'e7.exactly_one_semantic_delete',
    raw.semantic_deletes === 1 && (raw.delete_applies || []).length === 1,
    'the delete is applied exactly once (no double apply)',
    { semantic_deletes: raw.semantic_deletes, applies: (raw.delete_applies || []).length },
  )
  const replayResponse = (boot.net.deleteResponses || []).find((entry) => entry.status === 200)?.body || null
  check(
    'e7.replay_receipt_replayed_flag',
    replayResponse !== null && replayResponse.replayed === true && replayResponse.snapshot_hash === null,
    'replayed receipt carries replayed:true and snapshot_hash:null',
    replayResponse,
  )
  check(
    'e7.note_gone_server_side',
    (await currentNote(FIXTURE.d1NoteId)) === null,
    'server store no longer contains note_d1',
    await currentNote(FIXTURE.d1NoteId),
  )
  log(`${PREFIX} ${scene} console-errors=${JSON.stringify(boot.errors)} expected-http-errors=${JSON.stringify(boot.expectedHttpErrors)}`)
  check('e7.no_console_or_page_errors', boot.errors.length === 0, [], boot.errors)
  await boot.context.close()
  return {
    id: scene,
    width,
    note_mode: 'editor_on',
    delete_mode: 'unknown503_apply',
    mutation_ids: deletes.map((entry) => entry.mutation_id),
    stats: statsSummary(raw),
    assertions: items,
  }
}

// ── E8: 503 note_dependency_unavailable → Confirm result retry (AFTER) ─────
async function sceneE8After(browser, width, height) {
  const scene = 'E8'
  const { items, check } = makeAssert()
  await resetHarness({ noteMode: 'editor_on', deleteMode: 'dependency503', saveMode: 'ok' })
  const boot = await bootApp(browser, width, height)
  const app = boot.app
  await openNotes(app)
  const clicked = await clickDeleteEntry(app, FIXTURE.d1NoteId)
  check('e8.delete_entry_clicked', clicked.clicked, 'note-delete-note_d1 clicked', clicked)
  await waitDialogPhase(app, 'confirming', 15000)
  const confirmed = await clickDialogButton(app, HOOKS.confirm)
  check('e8.confirm_clicked', confirmed.clicked, 'note-delete-confirm clicked', confirmed)
  const errorShown = await waitFor(async () => (await count(app, HOOKS.error[0])) > 0, 25000)
  check('e8.error_state_shown', Boolean(errorShown), 'note-delete-error >= 1 (503 dependency)', Boolean(errorShown))
  const errorState = await collectState(boot)
  log(`${PREFIX} ${scene} error=${JSON.stringify({ counts: errorState.counts, error: errorState.deleteError, retry: errorState.retry })}`)
  check(
    'e8.error_kind_unavailable',
    errorState.deleteError?.failure_kind === 'unavailable',
    'note-delete-error data-failure-kind=unavailable (dependency could not be determined)',
    errorState.deleteError,
  )
  check(
    'e8.retry_offered',
    errorState.counts.note_delete_retry >= 1,
    'retry action offered for the retryable 503',
    errorState.counts.note_delete_retry,
  )
  check(
    'e8.retry_label_confirm_result',
    normalize(errorState.retry?.label) === COPY.retryConfirmResult,
    `unavailable retry copy is "${COPY.retryConfirmResult}"`,
    errorState.retry,
  )
  check(
    'e8.unavailable_error_copy',
    dialogHas(errorState, COPY.errorUnavailable),
    `unavailable error copy is visible ("${COPY.errorUnavailable}")`,
    errorState.dialogParts?.error,
  )
  await shot(boot, `${PREFIX}_e8_dependency_error_${width}`)
  const firstStats = await stats()
  check(
    'e8.first_attempt_dependency_503',
    (firstStats.delete_requests || []).length === 1 &&
      (firstStats.delete_requests || [])[0].status === 503 &&
      (firstStats.delete_requests || [])[0].outcome === 'dependency_unavailable',
    'first DELETE → 503 note_dependency_unavailable',
    (firstStats.delete_requests || []).map((entry) => ({ status: entry.status, outcome: entry.outcome })),
  )
  check('e8.first_attempt_not_applied', (firstStats.delete_requests || [])[0]?.applied === false, 'first attempt did not apply a semantic delete', (firstStats.delete_requests || [])[0]?.applied)
  const firstMutationId = (firstStats.delete_requests || [])[0]?.mutation_id || null
  const retried = await clickDialogButton(app, HOOKS.retry)
  check('e8.retry_clicked', retried.clicked, 'Confirm result clicked', retried)
  const rowGone = await waitRowGone(app, FIXTURE.d1NoteId, 25000)
  const toastSeen = await waitToast(app, COPY.successToast, 15000)
  await boot.page.waitForTimeout(600)
  const final = await collectState(boot)
  check('e8.row_removed_after_retry', Boolean(rowGone), 'row disappears after the successful retry', Boolean(rowGone))
  check('e8.success_toast_shown', Boolean(toastSeen), `success toast "${COPY.successToast}" shown after retry`, Boolean(toastSeen))
  check('e8.dialog_closed_after_success', final.counts.note_delete_dialog === 0, 'dialog closed after retry success', final.counts.note_delete_dialog)
  await shot(boot, `${PREFIX}_e8_after_retry_${width}`)
  const raw = await stats()
  const deletes = raw.delete_requests || []
  check('e8.two_delete_attempts', deletes.length === 2, '2 DELETE requests recorded (503 + retry)', deletes.length)
  check(
    'e8.same_mutation_id_retried',
    deletes.length === 2 && deletes[0].mutation_id === firstMutationId && deletes[1].mutation_id === firstMutationId,
    'retry replays the SAME mutation_id',
    deletes.map((entry) => entry.mutation_id),
  )
  check(
    'e8.first_retryable_second_success',
    deletes.length === 2 && deletes[0].status === 503 && deletes[1].status === 200,
    'first attempt 503, retry 200',
    deletes.map((entry) => entry.status),
  )
  check('e8.exactly_one_semantic_delete', raw.semantic_deletes === 1, 'exactly one applied delete', raw.semantic_deletes)
  check(
    'e8.note_gone_server_side',
    (await currentNote(FIXTURE.d1NoteId)) === null,
    'server store no longer contains note_d1',
    await currentNote(FIXTURE.d1NoteId),
  )
  log(`${PREFIX} ${scene} console-errors=${JSON.stringify(boot.errors)} expected-http-errors=${JSON.stringify(boot.expectedHttpErrors)}`)
  check('e8.no_console_or_page_errors', boot.errors.length === 0, [], boot.errors)
  await boot.context.close()
  return {
    id: scene,
    width,
    note_mode: 'editor_on',
    delete_mode: 'dependency503',
    mutation_ids: deletes.map((entry) => entry.mutation_id),
    stats: statsSummary(raw),
    assertions: items,
  }
}

// ── E9: Admin read-only — no delete entry (both phases) ───────────────────
async function sceneE9(browser, width, height) {
  const scene = 'E9'
  const { items, check } = makeAssert()
  await resetHarness({ noteMode: 'editor_on', deleteMode: 'success', saveMode: 'ok' })
  const boot = await bootApp(browser, width, height, { role: 'admin_readonly' })
  const app = boot.app
  await openNotes(app)
  await hoverRow(app, FIXTURE.d1NoteId)
  await hoverRow(app, FIXTURE.legacyNoteId)
  const state = await collectState(boot)
  log(`${PREFIX} ${scene} state=${JSON.stringify({ counts: state.counts, rows: state.rows })}`)
  check(
    'e9.admin_banner_visible',
    state.counts.admin_readonly_banner >= 1,
    'admin-readonly-banner visible for the synthetic admin_readonly token',
    state.counts.admin_readonly_banner,
  )
  check(
    'e9.d2_rows_listed',
    state.rows[FIXTURE.d1NoteId] !== null && state.rows[FIXTURE.d2NoteId] !== null,
    'd2-v1 rows still listed for an Admin read-only session',
    { d1: state.rows[FIXTURE.d1NoteId], d2: state.rows[FIXTURE.d2NoteId] },
  )
  check(
    'e9.no_delete_entry_on_d2_rows',
    state.counts.note_delete_entries === 0 &&
      state.rows[FIXTURE.d1NoteId]?.delete_entry !== true &&
      state.rows[FIXTURE.d2NoteId]?.delete_entry !== true,
    'no note-delete-* entry on any d2-v1 row for Admin read-only (both phases)',
    { entries: state.counts.note_delete_entries, testids: state.deleteTestids },
  )
  check(
    'e9.no_editor_delete_entry',
    state.counts.note_editor_delete === 0,
    'no note-editor-delete entry in the Admin read-only view',
    state.counts.note_editor_delete,
  )
  const legacyButtons = state.rows[FIXTURE.legacyNoteId]?.row_buttons || []
  check(
    'e9.no_legacy_write_actions_for_admin',
    !legacyButtons.includes('Edit') && !legacyButtons.includes('Delete'),
    'Admin read-only session exposes no legacy Edit/Delete write actions',
    legacyButtons,
  )
  const shotName = `${PREFIX}_e9_admin_readonly_${width}`
  await shot(boot, shotName)
  let pixel = null
  if (PHASE === 'after') {
    pixel = compareWithBefore(shotName)
    log(`${PREFIX} ${scene} pixel-compare=${JSON.stringify(pixel)}`)
  }
  const raw = await stats()
  check(
    'e9.no_delete_request_for_admin',
    (raw.delete_requests || []).length === 0,
    'no DELETE request emitted by an Admin read-only session',
    (raw.delete_requests || []).length,
  )
  log(`${PREFIX} ${scene} console-errors=${JSON.stringify(boot.errors)} expected-http-errors=${JSON.stringify(boot.expectedHttpErrors)}`)
  check('e9.no_console_or_page_errors', boot.errors.length === 0, [], boot.errors)
  await boot.context.close()
  return {
    id: scene,
    width,
    note_mode: 'editor_on',
    role: 'admin_readonly',
    pixel_compare: pixel,
    stats: statsSummary(raw),
    assertions: items,
  }
}

// ── E10: capability note_editor_existing=false — fail-closed (both phases) ─
async function sceneE10(browser, width, height) {
  const scene = 'E10'
  const { items, check } = makeAssert()
  await resetHarness({ noteMode: 'existing_off', deleteMode: 'success', saveMode: 'ok' })
  const boot = await bootApp(browser, width, height)
  const app = boot.app
  await openNotes(app)
  const catalogState = await collectState(boot)
  check(
    'e10.catalog_rendered_with_capability_off',
    catalogState.counts.note_catalog >= 1 &&
      catalogState.rows[FIXTURE.d1NoteId] !== null &&
      catalogState.rows[FIXTURE.d1NoteId].edit_schema === 'd2-v1',
    'Notes catalog renders d2-v1 rows while note_editor_existing.available=false',
    catalogState.rows[FIXTURE.d1NoteId],
  )
  await hoverRow(app, FIXTURE.d1NoteId)
  const hoveredState = await collectState(boot)
  check(
    'e10.no_delete_entry_when_capability_off',
    hoveredState.counts.note_delete_entries === 0,
    'no note-delete-* entry when note_editor_existing.available=false (fail-closed)',
    { entries: hoveredState.counts.note_delete_entries, testids: hoveredState.deleteTestids },
  )
  const opened = await openNote(app, FIXTURE.d1NoteId)
  check('e10.note_open_attempted', opened.clicked, 'clicked the d2-v1 note open action', opened)
  const blocked = await waitFor(async () => (await count(app, HOOKS.capabilityBlocked[0])) > 0, 25000)
  check(
    'e10.capability_blocked_hint_shown',
    Boolean(blocked),
    'note-capability-blocked fail-closed hint rendered when note_editor_existing is unavailable',
    Boolean(blocked),
  )
  const blockedText = await app
    .evaluate(() => {
      const node = document.querySelector('[data-testid="note-capability-blocked"]')
      return node ? (node.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 400) : null
    })
    .catch(() => null)
  const state = await collectState(boot)
  log(`${PREFIX} ${scene} blocked-text=${JSON.stringify(blockedText)} counts=${JSON.stringify(state.counts)}`)
  check(
    'e10.capability_blocked_reason_surface',
    typeof blockedText === 'string' && blockedText.length > 0,
    'capability-blocked hint carries user-facing reason text',
    blockedText,
  )
  check(
    'e10.no_delete_entry_in_blocked_editor',
    state.counts.note_editor_delete === 0 && state.counts.note_delete_entries === 0,
    'no delete entry in the capability-blocked editor or catalog',
    { editorDelete: state.counts.note_editor_delete, entries: state.counts.note_delete_entries },
  )
  const shotName = `${PREFIX}_e10_existing_off_blocked_${width}`
  await shot(boot, shotName)
  let pixel = null
  if (PHASE === 'after') {
    pixel = compareWithBefore(shotName)
    log(`${PREFIX} ${scene} pixel-compare=${JSON.stringify(pixel)}`)
  }
  const raw = await stats()
  check(
    'e10.no_delete_request_when_capability_off',
    (raw.delete_requests || []).length === 0,
    'no DELETE request while note_editor_existing.available=false',
    (raw.delete_requests || []).length,
  )
  check(
    'e10.models_capability_request_seen',
    (raw.models_requests || 0) >= 1,
    '/models capability projection requested',
    raw.models_requests,
  )
  log(`${PREFIX} ${scene} console-errors=${JSON.stringify(boot.errors)} expected-http-errors=${JSON.stringify(boot.expectedHttpErrors)}`)
  check('e10.no_console_or_page_errors', boot.errors.length === 0, [], boot.errors)
  await boot.context.close()
  return {
    id: scene,
    width,
    note_mode: 'existing_off',
    pixel_compare: pixel,
    stats: statsSummary(raw),
    assertions: items,
  }
}

// ── E11: legacy row old delete path unchanged (both phases) ───────────────
async function sceneE11(browser, width, height) {
  const scene = 'E11'
  const { items, check } = makeAssert()
  await resetHarness({ noteMode: 'editor_on', deleteMode: 'success', saveMode: 'ok' })
  const boot = await bootApp(browser, width, height)
  const app = boot.app
  await openNotes(app)
  const hovered = await hoverRow(app, FIXTURE.legacyNoteId)
  check('e11.legacy_row_hovered', hovered, 'legacy row hover works', hovered)
  const legacyRow = app.locator(HOOKS.row(FIXTURE.legacyNoteId)).first()
  const deleteButton = legacyRow.getByRole('button', { name: 'Delete', exact: true }).first()
  check(
    'e11.legacy_delete_text_button_present',
    (await deleteButton.count().catch(() => 0)) > 0,
    'legacy row still renders the old text "Delete" button',
    await deleteButton.count().catch(() => 0),
  )
  await deleteButton.click({ timeout: 15000 })
  const dialogReady = await waitFor(
    async () => (await count(app, '[role="alertdialog"]')) > 0,
    15000,
  )
  check('e11.legacy_confirm_dialog_opened', Boolean(dialogReady), 'legacy delete confirmation AlertDialog opened', Boolean(dialogReady))
  const legacyDialog = await app
    .evaluate(() => {
      const node = document.querySelector('[role="alertdialog"]')
      return node
        ? {
            text: (node.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 400),
            buttons: [...node.querySelectorAll('button')].map((button) =>
              (button.getAttribute('aria-label') || button.textContent || '').replace(/\s+/g, ' ').trim(),
            ),
          }
        : null
    })
    .catch(() => null)
  check(
    'e11.legacy_dialog_copy',
    legacyDialog !== null &&
      legacyDialog.text.includes('Delete this note?') &&
      legacyDialog.text.includes(FIXTURE.legacyTitle),
    'legacy dialog keeps its old copy ("Delete this note?" + note title)',
    legacyDialog,
  )
  check(
    'e11.legacy_dialog_buttons',
    legacyDialog !== null &&
      legacyDialog.buttons.includes('Cancel') &&
      legacyDialog.buttons.includes('Confirm'),
    'legacy dialog keeps old Cancel/Confirm buttons',
    legacyDialog?.buttons,
  )
  const shotName = `${PREFIX}_e11_legacy_delete_dialog_${width}`
  await shot(boot, shotName)
  let dialogPixel = null
  if (PHASE === 'after') {
    dialogPixel = compareWithBefore(shotName)
    log(`${PREFIX} ${scene} dialog-pixel-compare=${JSON.stringify(dialogPixel)}`)
  }
  const confirm = app.locator('[role="alertdialog"]').getByRole('button', { name: 'Confirm', exact: true }).first()
  await confirm.click({ timeout: 15000 })
  const rowGone = await waitRowGone(app, FIXTURE.legacyNoteId, 20000)
  check('e11.legacy_row_removed_after_delete', Boolean(rowGone), 'legacy row disappears after the old delete', Boolean(rowGone))
  await boot.page.waitForTimeout(800)
  const deletedShot = `${PREFIX}_e11_legacy_deleted_${width}`
  await shot(boot, deletedShot)
  let deletedPixel = null
  if (PHASE === 'after') {
    deletedPixel = compareWithBefore(deletedShot)
    log(`${PREFIX} ${scene} deleted-pixel-compare=${JSON.stringify(deletedPixel)}`)
  }
  const raw = await stats()
  const deletes = raw.delete_requests || []
  check('e11.legacy_single_delete', deletes.length === 1, 'exactly 1 DELETE request for the legacy row', deletes.length)
  const only = deletes[0] || {}
  check(
    'e11.legacy_delete_has_no_d2_contract_header',
    only.contract_header === null || only.contract_header === undefined,
    'legacy DELETE carries NO X-Research-Note-Contract: d2-v1 header',
    only.contract_header,
  )
  check(
    'e11.legacy_delete_has_no_mutation_or_revision_body',
    (only.body_keys || []).length === 0 && (only.mutation_id === null || only.mutation_id === undefined) && (only.expected_revision === null || only.expected_revision === undefined),
    'legacy DELETE carries NO mutation_id/expected_revision body (old path untouched)',
    only,
  )
  check(
    'e11.legacy_delete_status_204',
    only.status === 204 && only.outcome === 'legacy_deleted',
    'legacy DELETE returns the old 204 No Content',
    { status: only.status, outcome: only.outcome },
  )
  check(
    'e11.no_d2_semantic_delete',
    raw.semantic_deletes === 0 && (raw.legacy_deletes || []).length === 1,
    '0 d2-v1 semantic deletes / 1 legacy delete recorded',
    { semantic_deletes: raw.semantic_deletes, legacy: (raw.legacy_deletes || []).length },
  )
  check(
    'e11.legacy_note_gone_server_side',
    (await currentNote(FIXTURE.legacyNoteId)) === null,
    'server store no longer contains note_legacy',
    await currentNote(FIXTURE.legacyNoteId),
  )
  const noteLabels = statsSummary(raw).notes || []
  check(
    'e11.d2_notes_untouched',
    noteLabels.some((note) => note.startsWith(`${FIXTURE.d1NoteId}@`)) &&
      noteLabels.some((note) => note.startsWith(`${FIXTURE.d2NoteId}@`)),
    'both d2-v1 notes untouched by the legacy delete',
    noteLabels,
  )
  log(`${PREFIX} ${scene} console-errors=${JSON.stringify(boot.errors)} expected-http-errors=${JSON.stringify(boot.expectedHttpErrors)}`)
  check('e11.no_console_or_page_errors', boot.errors.length === 0, [], boot.errors)
  await boot.context.close()
  return {
    id: scene,
    width,
    note_mode: 'editor_on',
    delete_mode: 'success',
    pixel_compare: { dialog: dialogPixel, deleted: deletedPixel },
    stats: statsSummary(raw),
    assertions: items,
  }
}

const BEFORE_SCENES = { e1: sceneE1, e9: sceneE9, e10: sceneE10, e11: sceneE11 }
const AFTER_SCENES = {
  e1: sceneE1,
  e2: sceneE2After,
  e3: sceneE3After,
  e4: sceneE4After,
  e5: sceneE5After,
  e6: sceneE6After,
  e7: sceneE7After,
  e8: sceneE8After,
  e9: sceneE9,
  e10: sceneE10,
  e11: sceneE11,
}
/** Scenes the baseline cannot exercise (no d2-v1 delete entry/mutation at all). */
const BEFORE_NA_SCENES = {
  e2: 'N/A — baseline has no d2-v1 delete entry, so the delete confirmation dialog does not exist; no baseline screenshot was fabricated',
  e3: 'N/A — baseline cannot delete a d2-v1 note from the UI (no delete entry, no DELETE mutation path)',
  e4: 'N/A — baseline has no editor-toolbar delete entry, so the editor delete success flow does not exist',
  e5: 'N/A — baseline has no d2-v1 delete entry, so a 403 restricted delete error state does not exist',
  e6: 'N/A — baseline has no d2-v1 delete entry, so no 409 revision-conflict / refresh-and-review flow exists',
  e7: 'N/A — baseline has no d2-v1 delete entry, so no unknown-result / same-mutation replay flow exists',
  e8: 'N/A — baseline has no d2-v1 delete entry, so no 503 dependency-unavailable retry flow exists',
  e12: 'N/A — E12 is merged into E2 (impact/reference copy inside the delete dialog); baseline has no dialog',
}

const SCENES = PHASE === 'before' ? BEFORE_SCENES : AFTER_SCENES
const SCENE_IDS = ONLY_SCENES.length > 0 ? ONLY_SCENES.map((id) => id.toLowerCase()) : Object.keys(SCENES)

async function main() {
  banner(`Issue #1134 ${PHASE} capture — head=${HEAD} host=${HOST} widths=${WIDTHS.join(',')}`)
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
          log(`${PREFIX} ${sceneId} SCENE-ERROR ${String(error && error.stack ? error.stack : error).slice(0, 1500)}`)
          sceneResults.push({
            id: sceneId.toUpperCase(),
            width,
            error: String(error && error.message ? error.message : error).slice(0, 600),
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
  const deviations = sceneResults.flatMap((scene) =>
    (scene.deviations || []).map((entry) => ({ scene: scene.id, width: scene.width, ...entry })),
  )

  const manifest = {
    ticket: 'HiFiBiO-Therapeutics/RDLens#1134',
    title: 'd2-v1 Note 删除入口（目录行 + 编辑器工具栏 + 二次确认/失败重试）— fork Before/After visual evidence',
    evidence_kind: 'synthetic',
    synthetic_declaration:
      'Real fork Next.js app (next dev --webpack, embedded iframe) + synthetic host page + route-mocked Research Gateway. No real RDLens host, PostgreSQL, SurrealDB, files, models, Feishu content, users or private data. All note titles/ids/content are [synthetic] fixtures (project p1, viewer 1, fabricated claims-only token).',
    phase: PHASE,
    head: HEAD,
    baseline: 'fork origin/main f3e4e47 (post-#128/#1135)',
    captured_at: new Date().toISOString(),
    host_url: HOST,
    gateway: GATEWAY,
    mode_files: {
      note_mode: NOTE_MODE_FILE,
      delete_mode: DELETE_MODE_FILE,
      save_mode: SAVE_MODE_FILE,
    },
    before_na_scenes: PHASE === 'before' ? BEFORE_NA_SCENES : {},
    env: {
      chrome: CHROME,
      node: process.version,
      widths: WIDTHS,
      viewports: Object.fromEntries(
        WIDTHS.map((width) => [String(width), `${width}x${heightFor(width)}`]),
      ),
      device_scale_factor: 1,
      color_scheme: 'light',
      locale: 'en-US',
      fresh_browser_context_per_scene: true,
      harness_only_config_patch:
        'frontend/src/lib/embedded/config.ts static NEXT_PUBLIC_* member access (Next dev does not inline dynamic env lookups); reverted after capture',
      layout_probe:
        'real Chromium boundingBox/scroll geometry of the d2-v1 row title, compact delete icon, Insert excerpt entry and legacy old Delete action (E1, both widths); no CSS-string parsing',
      contract_copy: COPY,
      scene_notes:
        'E2 also carries the E12 assertions (impact/reference copy inside the delete dialog). E3/E4 seed two sessionStorage draft-cache tab branches in the app frame and assert all branches for the deleted note are removed.',
    },
    scenes: sceneResults,
    contract_deviations: deviations,
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
  log(`${PREFIX} contract-deviations=${JSON.stringify(deviations)}`)
  log(`${PREFIX} assertions-json=${JSON.stringify(allAssertions.map(({ name, ok }) => ({ name, ok })))}`)
  if (fail > 0 || scenesWithErrors.length > 0) process.exitCode = 2
}

main().catch((error) => {
  log(`${PREFIX} FATAL ${String(error && error.stack ? error.stack : error)}`)
  process.exit(1)
})
