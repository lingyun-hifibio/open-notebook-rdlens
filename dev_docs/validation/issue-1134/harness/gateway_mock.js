#!/usr/bin/env node
/**
 * Synthetic Research Gateway mock for Issue #1134 (d2-v1 Note 删除入口) fork
 * Before/After visual + browser-behaviour evidence.
 *
 * Route-mocked Gateway over HTTP with permissive CORS so the real Next.js fork
 * app (embedded iframe on another local port) can call it. No database, no
 * model calls, no credentials; all fixtures are synthetic (`fixtures.js`).
 *
 * Reused route surface from the #1046 PR4 / #1135 / #1136 evidence harness
 * (d2-v1 note API + capability projection) plus the #1134 d2-v1 delete
 * mutation:
 *
 * - GET    .../notes                (d2-v1 header → revision/snapshot_hash/edit_schema/access_state)
 * - GET    .../notes/{id}
 * - POST   .../notes
 * - PATCH  .../notes/{id}           (revision CAS; `save_mode=fail503` injects a retryable save failure)
 * - DELETE .../notes/{id}           ← issue #1134: d2-v1 delete mode driven
 *     d2-v1 request body MUST be exactly `{mutation_id, expected_revision}`;
 *     success → 200 receipt with `snapshot_hash: null`; same mutation_id replay →
 *     200 `replayed:true` and no second semantic delete.
 *     Legacy (no `X-Research-Note-Contract: d2-v1`) DELETE keeps the old
 *     behavior: 204 No Content, no body, no receipt (E11 regression guard).
 *
 * Delete modes (file /tmp/issue1134-delete-mode, read per request, written by
 * capture.js):
 * - success:              delete applies → 200 receipt.
 * - restricted403:        every d2 DELETE → 403 `note_access_restricted`
 *                         (retryable=false, terminal, no apply; permission
 *                         revoked after the catalog row rendered).
 * - conflict409:          first d2 DELETE for the note bumps the stored note to
 *                         revision+1 and → 409 `note_revision_conflict` with
 *                         `current_revision`/`current_snapshot_hash`; the next
 *                         DELETE with the refreshed `expected_revision` succeeds.
 * - unknown503_apply:     the delete IS APPLIED but the response is 503
 *                         `note_store_unavailable` (result unknown). Replaying
 *                         the SAME mutation_id returns the stored receipt with
 *                         `replayed:true` (exactly one semantic delete).
 * - dependency503:        first d2 DELETE for the note → 503
 *                         `note_dependency_unavailable` (retryable=true, result
 *                         known failed, no apply); the retry succeeds.
 *
 * Save modes (file /tmp/issue1134-save-mode):
 * - ok:      normal d2-v1 revision CAS PATCH.
 * - fail503: d2-v1 PATCH → 503 `note_store_unavailable` (non-retryable) so the
 *            editor keeps unsaved local text (saveStatus=failed, no leave guard)
 *            for the E4 unsavedLocal branch.
 *
 * Harness control endpoints (never called by the app):
 * - GET  /__reset                  reset note store / receipts / counters
 * - GET  /__stats                  counters + current store state (assertions)
 * - GET  /__note?note_id=X         current stored note (d2 projection)
 * - GET  /__bump?note_id=X         simulate another tab writing X (revision +1)
 * - GET  /__restrict?note_id=X     mark a note restricted
 * - GET  /health
 *
 * Usage: node gateway_mock.js [port]
 */
const http = require('node:http')
const fs = require('node:fs')
const fixtures = require('./fixtures')

const PORT = Number(process.argv[2] || 8963)
const NOTE_MODE_FILE = '/tmp/issue1134-note-mode'
const DELETE_MODE_FILE = '/tmp/issue1134-delete-mode'
const SAVE_MODE_FILE = '/tmp/issue1134-save-mode'
const NOTE_MODES = ['editor_on', 'existing_off']
const DELETE_MODES = ['success', 'restricted403', 'conflict409', 'unknown503_apply', 'dependency503']
const SAVE_MODES = ['ok', 'fail503']

function readMode(file, allowed, fallback) {
  try {
    const value = fs.readFileSync(file, 'utf8').trim()
    return allowed.includes(value) ? value : fallback
  } catch {
    return fallback
  }
}

const noteMode = () => readMode(NOTE_MODE_FILE, NOTE_MODES, 'editor_on')
const deleteMode = () => readMode(DELETE_MODE_FILE, DELETE_MODES, 'success')
const saveMode = () => readMode(SAVE_MODE_FILE, SAVE_MODES, 'ok')

// ── mutable state ──────────────────────────────────────────────────────────
let notes = fixtures.initialNoteStore()
let receipts = new Map() // mutation_id → {receipt, noteId, requestedNoteId, replayed}
const counters = {
  noteRequests: [],
  saves: [],
  deletes: [],
  deleteApplies: [],
  deleteReplays: 0,
  legacyDeletes: [],
  models: 0,
  creates: 0,
}
/** First-attempt bookkeeping for conflict409/dependency503 modes (per note). */
let deleteAttemptsByNote = new Map()

function resetState() {
  notes = fixtures.initialNoteStore()
  receipts = new Map()
  deleteAttemptsByNote = new Map()
  counters.noteRequests.length = 0
  counters.saves.length = 0
  counters.deletes.length = 0
  counters.deleteApplies.length = 0
  counters.deleteReplays = 0
  counters.legacyDeletes.length = 0
  counters.models = 0
  counters.creates = 0
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
      'content-type, content-length, content-disposition, cache-control, x-request-id, x-research-contract, x-research-note-contract',
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

function noteHeaders(selected) {
  return selected
    ? {
        'x-research-contract': 'v1',
        'x-research-note-contract': 'd2-v1',
        'x-request-id': `synth-${Date.now()}`,
      }
    : { 'x-research-contract': 'v1', 'x-request-id': `synth-${Date.now()}` }
}

/** Contract error envelope (host `note_api.error_envelope`). */
function sendNoteError(res, selected, status, code, message, extra = {}) {
  sendJson(
    res,
    {
      detail: {
        code,
        message,
        retryable: Boolean(extra.retryable),
        request_id: `synth-${Date.now()}`,
        ...(extra.current_revision !== undefined
          ? { current_revision: extra.current_revision }
          : {}),
        ...(extra.current_snapshot_hash !== undefined
          ? { current_snapshot_hash: extra.current_snapshot_hash }
          : {}),
      },
    },
    status,
    noteHeaders(selected),
  )
}

function isUsedMutation(mutationId) {
  return typeof mutationId === 'string' && mutationId.length > 0
}

/** Build the current d2 projection of a mutable note. */
function snapshot(note) {
  return fixtures.d2NoteView(note)
}

function touch(note, { title, content } = {}) {
  if (title !== undefined) note.title = title
  if (content !== undefined) note.content = content
  note.updated_at = nowIso()
  if (note.edit_schema === 'd2-v1') {
    note.snapshot_hash = fixtures.snapshotHash(
      note.note_id,
      note.revision,
      note.title,
      note.content,
    )
  }
}

/** Legacy rows carry no revision; protected rows advance their revision. */
function rollRevision(note, { title, content } = {}) {
  if (note.edit_schema === 'd2-v1') {
    note.revision += 1
  }
  touch(note, { title, content })
}

function currentView(note, { selected, includeCitations = false }) {
  return selected
    ? fixtures.d2NoteView(note, { includeCitations })
    : fixtures.legacyNoteView(note)
}

/** Apply one semantic d2-v1 delete and store the replay-addressable receipt. */
function applyDelete(note, mutationId) {
  const appliedRevision = note.revision
  notes.delete(note.note_id)
  const receipt = fixtures.receipt({
    noteId: note.note_id,
    mutationId,
    appliedRevision,
    snapshotHashValue: null,
  })
  receipts.set(mutationId, {
    receipt,
    noteId: note.note_id,
    requestedNoteId: note.note_id,
  })
  counters.deleteApplies.push({
    note_id: note.note_id,
    mutation_id: mutationId,
    applied_revision: appliedRevision,
    at: Date.now(),
  })
  return receipt
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
  if (pathname === '/__stats') {
    return sendJson(res, {
      note_mode: noteMode(),
      delete_mode: deleteMode(),
      save_mode: saveMode(),
      models_requests: counters.models,
      creates: counters.creates,
      note_requests: counters.noteRequests.slice(),
      list_requests: counters.noteRequests.filter(
        (entry) => entry.method === 'GET' && String(entry.path).endsWith('/notes'),
      ),
      detail_requests: counters.noteRequests.filter(
        (entry) =>
          entry.method === 'GET' && /\/notes\/[^/]+$/.test(String(entry.path)),
      ),
      saves: counters.saves.slice(),
      delete_requests: counters.deletes.slice(),
      delete_applies: counters.deleteApplies.slice(),
      delete_replays: counters.deleteReplays,
      semantic_deletes: counters.deleteApplies.length,
      legacy_deletes: counters.legacyDeletes.slice(),
      notes: [...notes.values()].map((note) => ({
        note_id: note.note_id,
        revision: note.revision,
        edit_schema: note.edit_schema,
        title: note.title,
      })),
    })
  }
  if (pathname === '/__note') {
    const note = notes.get(url.searchParams.get('note_id'))
    return sendJson(res, note ? fixtures.d2NoteView(note, { includeCitations: true }) : null)
  }
  if (pathname === '/__restrict') {
    const note = notes.get(url.searchParams.get('note_id'))
    if (!note) return sendJson(res, { ok: false, reason: 'note_not_found' }, 404)
    note.access_state = 'restricted'
    return sendJson(res, { ok: true, note: fixtures.d2NoteView(note) })
  }
  if (pathname === '/__bump') {
    const note = notes.get(url.searchParams.get('note_id'))
    if (!note) return sendJson(res, { ok: false, reason: 'note_not_found' }, 404)
    const title = url.searchParams.get('title')
    const content = url.searchParams.get('content')
    rollRevision(note, {
      ...(title === null ? {} : { title }),
      ...(content === null ? {} : { content }),
    })
    return sendJson(res, { ok: true, note: fixtures.d2NoteView(note) })
  }
  if (pathname === '/health') return sendJson(res, { ok: true })

  const selected = req.headers['x-research-note-contract'] === 'd2-v1'

  // ── models / capability projection ──────────────────────────────────────
  if (pathname.endsWith('/models')) {
    counters.models += 1
    if (noteMode() === 'existing_off') return sendJson(res, fixtures.MODELS_EXISTING_OFF)
    return sendJson(res, fixtures.MODELS_EDITOR_ON)
  }
  if (pathname.endsWith('/execution-preferences')) return sendJson(res, fixtures.PREFERENCES)
  if (pathname.endsWith('/external-egress-consent')) return sendJson(res, fixtures.CONSENT)
  if (pathname.endsWith('/context-preview') || pathname.endsWith('/c05/preview')) {
    return sendJson(res, fixtures.PREVIEW)
  }
  if (pathname.endsWith('/workspace-status')) {
    return sendJson(res, { enabled: true, contract: 'research-session-v1' })
  }

  // ── notes list / create ─────────────────────────────────────────────────
  if (pathname.endsWith('/notes') && req.method === 'GET') {
    const q = (url.searchParams.get('q') || '').trim().toLowerCase()
    let items = [...notes.values()]
    if (q) {
      items = items.filter(
        (note) =>
          String(note.title || '').toLowerCase().includes(q) ||
          String(note.content || '').toLowerCase().includes(q),
      )
    }
    const views = items.map((note) => {
      if (note.access_state === 'restricted') {
        return {
          note_id: note.note_id,
          project_id: note.project_id,
          title: null,
          content: null,
          note_type: note.note_type,
          created_at: note.created_at,
          updated_at: note.updated_at,
          ...(selected
            ? {
                revision: null,
                snapshot_hash: null,
                edit_schema: note.edit_schema,
                access_state: 'restricted',
              }
            : {}),
        }
      }
      return currentView(note, { selected })
    })
    counters.noteRequests.push({ method: 'GET', path: pathname, selected, status: 200 })
    return sendJson(res, fixtures.listPage(views), 200, noteHeaders(selected))
  }

  if (pathname.endsWith('/notes') && req.method === 'POST') {
    const body = await readBody(req)
    counters.noteRequests.push({ method: 'POST', path: pathname, selected, status: 0 })
    const entry = counters.noteRequests[counters.noteRequests.length - 1]
    if (selected) {
      if (!body || !isUsedMutation(body.mutation_id)) {
        entry.status = 422
        return sendNoteError(res, true, 422, 'note_request_invalid', 'mutation_id required')
      }
      const replay = receipts.get(body.mutation_id)
      if (replay) {
        entry.status = 200
        return sendJson(res, { ...replay.receipt, replayed: true }, 200, noteHeaders(true))
      }
      const noteId = fixtures.syntheticNoteId(body.mutation_id)
      const created = {
        note_id: noteId,
        project_id: fixtures.PROJECT.id,
        title: typeof body.title === 'string' ? body.title : '[synthetic] Untitled note',
        content: typeof body.content === 'string' ? body.content : '',
        note_type: 'human',
        created_at: nowIso(),
        updated_at: nowIso(),
        revision: 1,
        snapshot_hash: null,
        edit_schema: 'd2-v1',
        access_state: 'visible',
        citations: [],
      }
      created.snapshot_hash = fixtures.snapshotHash(
        noteId,
        1,
        created.title,
        created.content,
      )
      notes.set(noteId, created)
      const receipt = fixtures.receipt({
        noteId,
        mutationId: body.mutation_id,
        appliedRevision: 1,
        snapshotHashValue: created.snapshot_hash,
      })
      receipts.set(body.mutation_id, { receipt, noteId, requestedNoteId: noteId })
      counters.creates += 1
      entry.status = 201
      return sendJson(res, receipt, 201, noteHeaders(true))
    }
    // legacy create (old NotesPanel; title/content required)
    const noteId = `note_legacy_${Math.random().toString(36).slice(2, 10)}`
    const note = {
      note_id: noteId,
      project_id: fixtures.PROJECT.id,
      title: String(body && body.title ? body.title : ''),
      content: String(body && body.content ? body.content : ''),
      note_type: 'human',
      created_at: nowIso(),
      updated_at: nowIso(),
      revision: null,
      snapshot_hash: null,
      edit_schema: null,
      access_state: 'visible',
      citations: [],
    }
    notes.set(noteId, note)
    entry.status = 201
    return sendJson(res, fixtures.legacyNoteView(note), 201, noteHeaders(false))
  }

  // ── note detail / save / delete ─────────────────────────────────────────
  const noteMatch = pathname.match(/\/notes\/([^/]+)$/)
  if (noteMatch !== null) {
    const noteId = decodeURIComponent(noteMatch[1])
    const note = notes.get(noteId)

    if (req.method === 'GET') {
      counters.noteRequests.push({ method: 'GET', path: pathname, selected, status: 0 })
      const entry = counters.noteRequests[counters.noteRequests.length - 1]
      if (!note) {
        entry.status = 404
        return selected
          ? sendNoteError(res, true, 404, 'note_not_found', 'note not found')
          : sendJson(res, { detail: 'Note not found' }, 404)
      }
      if (note.access_state === 'restricted') {
        entry.status = 403
        return selected
          ? sendNoteError(res, true, 403, 'note_access_restricted', 'synthetic restricted note')
          : sendJson(res, { detail: 'Note access restricted' }, 403)
      }
      entry.status = 200
      return sendJson(
        res,
        currentView(note, { selected, includeCitations: true }),
        200,
        noteHeaders(selected),
      )
    }

    if (req.method === 'PATCH') {
      const body = await readBody(req)
      counters.noteRequests.push({ method: 'PATCH', path: pathname, selected, status: 0 })
      const entry = counters.noteRequests[counters.noteRequests.length - 1]
      counters.saves.push({
        note_id: noteId,
        selected,
        mutation_id: body && body.mutation_id ? body.mutation_id : null,
        expected_revision:
          body && body.expected_revision !== undefined ? body.expected_revision : null,
        at: Date.now(),
        status: 0,
      })
      const saveEntry = counters.saves[counters.saves.length - 1]
      if (!note) {
        entry.status = 404
        saveEntry.status = 404
        return selected
          ? sendNoteError(res, true, 404, 'note_not_found', 'note not found')
          : sendJson(res, { detail: 'Note not found' }, 404)
      }
      if (note.access_state === 'restricted') {
        entry.status = 403
        saveEntry.status = 403
        return selected
          ? sendNoteError(res, true, 403, 'note_access_restricted', 'synthetic restricted note')
          : sendJson(res, { detail: 'Note access restricted' }, 403)
      }
      if (!selected) {
        // legacy PATCH: {title?, content?}; protected rows reject the old entry.
        if (note.edit_schema === 'd2-v1') {
          entry.status = 428
          saveEntry.status = 428
          return sendJson(
            res,
            {
              detail: {
                code: 'note_revision_required',
                message: 'protected note writes require the d2-v1 revision-aware endpoint',
                retryable: false,
                request_id: `synth-${Date.now()}`,
              },
            },
            428,
            noteHeaders(false),
          )
        }
        const title = body && typeof body.title === 'string' ? body.title : undefined
        const content = body && typeof body.content === 'string' ? body.content : undefined
        rollRevision(note, { title, content })
        entry.status = 200
        saveEntry.status = 200
        return sendJson(res, fixtures.legacyNoteView(note), 200, noteHeaders(false))
      }
      // Issue #1134 E4: inject a retryable save failure so the open editor keeps
      // unsaved local text (unsavedLocal branch of the delete dialog).
      if (saveMode() === 'fail503') {
        entry.status = 503
        saveEntry.status = 503
        saveEntry.outcome = 'save_store_unavailable'
        return sendNoteError(
          res,
          true,
          503,
          'note_store_unavailable',
          'synthetic note store rejected the save; local text is kept',
          { retryable: false },
        )
      }
      // d2-v1 CAS save.
      if (!body || !isUsedMutation(body.mutation_id)) {
        entry.status = 422
        saveEntry.status = 422
        return sendNoteError(res, true, 422, 'note_request_invalid', 'mutation_id required')
      }
      const replay = receipts.get(body.mutation_id)
      if (replay && replay.receipt) {
        entry.status = 200
        saveEntry.status = 200
        saveEntry.outcome = 'replayed'
        return sendJson(res, { ...replay.receipt, replayed: true }, 200, noteHeaders(true))
      }
      if (
        typeof body.expected_revision !== 'number' ||
        body.expected_revision !== note.revision
      ) {
        entry.status = 409
        saveEntry.status = 409
        saveEntry.outcome = 'conflict'
        return sendNoteError(
          res,
          true,
          409,
          'note_revision_conflict',
          'expected revision does not match the stored note',
          { current_revision: note.revision, current_snapshot_hash: note.snapshot_hash },
        )
      }
      note.revision += 1
      touch(note, {
        title: typeof body.title === 'string' ? body.title : note.title,
        content: typeof body.content === 'string' ? body.content : note.content,
      })
      const receipt = fixtures.receipt({
        noteId,
        mutationId: body.mutation_id,
        appliedRevision: note.revision,
        snapshotHashValue: note.snapshot_hash,
      })
      receipts.set(body.mutation_id, { receipt, noteId, requestedNoteId: noteId })
      entry.status = 200
      saveEntry.status = 200
      saveEntry.outcome = 'success'
      return sendJson(res, receipt, 200, noteHeaders(true))
    }

    if (req.method === 'DELETE') {
      const body = await readBody(req)
      const entry = {
        method: 'DELETE',
        path: pathname,
        note_id: noteId,
        selected,
        contract_header: req.headers['x-research-note-contract'] || null,
        body: body === null ? null : body,
        body_keys: body !== null && typeof body === 'object' ? Object.keys(body).sort() : [],
        mutation_id: body && isUsedMutation(body.mutation_id) ? body.mutation_id : null,
        expected_revision:
          body && typeof body.expected_revision === 'number' ? body.expected_revision : null,
        mode: deleteMode(),
        outcome: 'pending',
        status: 0,
        replay: false,
        applied: false,
        at: Date.now(),
      }
      counters.deletes.push(entry)
      counters.noteRequests.push({ method: 'DELETE', path: pathname, selected, status: 0 })
      const noteEntry = counters.noteRequests[counters.noteRequests.length - 1]
      const finish = (outcome, status) => {
        entry.outcome = outcome
        entry.status = status
        noteEntry.status = status
      }

      // Legacy delete path (old NotesPanel; no d2-v1 contract header/body).
      if (!selected) {
        if (!note) {
          finish('legacy_not_found', 404)
          return sendJson(res, { detail: 'Note not found' }, 404)
        }
        notes.delete(noteId)
        counters.legacyDeletes.push({ note_id: noteId, status: 204, at: Date.now() })
        finish('legacy_deleted', 204)
        res.writeHead(204, { ...corsHeaders(), 'x-research-contract': 'v1' })
        res.end()
        return
      }

      // ── d2-v1 delete mutation ──
      if (body === null || !isUsedMutation(entry.mutation_id) || entry.expected_revision === null) {
        finish('invalid', 422)
        return sendNoteError(
          res,
          true,
          422,
          'note_request_invalid',
          'mutation_id and expected_revision are required',
        )
      }
      // Same-mutation replay is checked BEFORE failure modes/state: it is the
      // reconciler path that confirms a previously applied delete.
      const replay = receipts.get(entry.mutation_id)
      if (replay !== undefined) {
        entry.replay = true
        counters.deleteReplays += 1
        finish('replayed', 200)
        return sendJson(
          res,
          { ...replay.receipt, replayed: true },
          200,
          noteHeaders(true),
        )
      }
      if (!note) {
        finish('note_not_found', 404)
        return sendNoteError(res, true, 404, 'note_not_found', 'note not found')
      }
      if (note.access_state === 'restricted') {
        finish('restricted', 403)
        return sendNoteError(res, true, 403, 'note_access_restricted', 'synthetic restricted note')
      }
      const mode = deleteMode()
      if (mode === 'restricted403') {
        finish('restricted', 403)
        return sendNoteError(
          res,
          true,
          403,
          'note_access_restricted',
          'synthetic permission revoked before confirmation',
        )
      }
      if (mode === 'conflict409') {
        const attempts = deleteAttemptsByNote.get(noteId) || 0
        deleteAttemptsByNote.set(noteId, attempts + 1)
        if (attempts === 0) {
          // Another tab wrote the note: refresh the stored revision AND content,
          // then report the conflict so the UI re-reads the latest projection
          // (GET .../notes/{id}) and re-reviews before deleting. The title stays
          // unchanged; the content marker proves the dialog shows the freshly
          // read body, not the stale catalog row.
          if (note.edit_schema === 'd2-v1') {
            note.revision += 1
            note.content = fixtures.refreshedNoteContent(note.note_id, note.content)
            note.updated_at = nowIso()
            note.snapshot_hash = fixtures.snapshotHash(
              note.note_id,
              note.revision,
              note.title,
              note.content,
            )
          }
          finish('conflict', 409)
          return sendNoteError(
            res,
            true,
            409,
            'note_revision_conflict',
            'expected revision does not match the stored note',
            { current_revision: note.revision, current_snapshot_hash: note.snapshot_hash },
          )
        }
      }
      if (mode === 'dependency503') {
        const attempts = deleteAttemptsByNote.get(noteId) || 0
        deleteAttemptsByNote.set(noteId, attempts + 1)
        if (attempts === 0) {
          finish('dependency_unavailable', 503)
          return sendNoteError(
            res,
            true,
            503,
            'note_dependency_unavailable',
            'synthetic note dependency is temporarily unavailable; retry later',
            { retryable: true },
          )
        }
      }
      if (entry.expected_revision !== note.revision) {
        finish('conflict', 409)
        return sendNoteError(
          res,
          true,
          409,
          'note_revision_conflict',
          'expected revision does not match the stored note',
          { current_revision: note.revision, current_snapshot_hash: note.snapshot_hash },
        )
      }
      const receipt = applyDelete(note, entry.mutation_id)
      entry.applied = true
      if (mode === 'unknown503_apply') {
        // The mutation was applied but the response is lost: result unknown.
        finish('unknown_applied', 503)
        return sendNoteError(
          res,
          true,
          503,
          'note_store_unavailable',
          'synthetic store result unknown; confirm the same mutation',
          { retryable: true },
        )
      }
      finish('deleted', 200)
      return sendJson(res, receipt, 200, noteHeaders(true))
    }
  }

  if (pathname.includes('/submissions/')) {
    return sendJson(res, { detail: 'submission_not_found' }, 404)
  }

  // ── workspace chrome ───────────────────────────────────────────────────
  if (pathname.endsWith('/chat/sessions') && req.method === 'GET') {
    return sendJson(res, fixtures.SESSIONS)
  }
  const globalEditor = pathname.match(/\/chat\/sessions\/([^/]+)\/editor-state$/)
  if (globalEditor !== null) {
    const sessionId = globalEditor[1]
    if (req.method === 'PUT') {
      const body = await readBody(req)
      const current = fixtures.editorResponse(sessionId)
      return sendJson(res, {
        ...current,
        editor_revision: current.editor_revision + 1,
        editor_state: {
          ...current.editor_state,
          ...(body && typeof body.editor_state === 'object' && body.editor_state !== null
            ? body.editor_state
            : {}),
        },
        saved_at: nowIso(),
      })
    }
    return sendJson(res, fixtures.editorResponse(sessionId))
  }
  const globalDetail = pathname.match(/\/chat\/sessions\/([^/]+)$/)
  if (globalDetail !== null) {
    return sendJson(res, fixtures.GLOBAL_DETAIL, 200, {
      'x-research-message-projection': 'd1e-message-v4',
    })
  }
  const sourceDetail = pathname.match(/\/sources\/([^/]+)$/)
  if (sourceDetail !== null) {
    const sourceId = decodeURIComponent(sourceDetail[1])
    const detail = fixtures.SOURCE_DETAILS[sourceId]
    if (!detail) return sendJson(res, { detail: 'Source not found' }, 404)
    return sendJson(res, detail)
  }
  if (pathname.endsWith('/sources')) {
    return sendJson(res, fixtures.listPage(fixtures.SOURCES))
  }
  if (
    pathname.endsWith('/jobs') ||
    pathname.endsWith('/insights') ||
    pathname.endsWith('/transformations')
  ) {
    return sendJson(res, fixtures.listPage([]))
  }
  return sendJson(res, {})
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`synthetic gateway mock (#1134 note delete): http://127.0.0.1:${PORT}`)
  console.log(`mode files: ${NOTE_MODE_FILE} ${DELETE_MODE_FILE} ${SAVE_MODE_FILE}`)
})
