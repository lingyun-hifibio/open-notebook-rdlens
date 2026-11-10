#!/usr/bin/env node
/**
 * Synthetic Research Gateway mock for Issue #1135 ("受保护编辑启用入口")
 * fork Before/After visual + browser-behaviour evidence.
 *
 * Route-mocked Gateway over HTTP with permissive CORS so the real Next.js fork
 * app (embedded iframe on another local port) can call it. No database, no
 * model calls, no credentials; all fixtures are synthetic (`fixtures.js`).
 *
 * Reused route surface from the #1046 PR4 / #1136 evidence harness (d2-v1 note
 * API + capability projection) plus the #1135 first-protection-enable mutation:
 *
 * - GET    .../notes                (d2-v1 header → revision/snapshot_hash/edit_schema/access_state)
 * - GET    .../notes/{id}
 * - POST   .../notes                (d2-v1 → receipt 201 / replay 200)
 * - PATCH  .../notes/{id}           (revision CAS → 409 note_revision_conflict)
 * - DELETE .../notes/{id}
 * - POST   .../notes/{id}/editing   ← issue #1135 first protection enable
 *     body {mutation_id}; idempotent, replay-addressable mutation:
 *     first apply → note becomes d2-v1 revision 1 + receipt; replaying the
 *     SAME mutation_id returns the stored receipt with `replayed:true` and
 *     does NOT change the note again (exactly one semantic change).
 * - GET    .../models               (capabilities note_editor/note_editor_existing/...)
 *
 * Failure modes (mode files, read per request, written by capture.js):
 * - /tmp/issue1135-note-mode    editor_on | editor_off | existing_off |
 *                               models_error | models_malformed
 * - /tmp/issue1135-enable-mode  success | already_protected | restricted403 |
 *                               dependency503 | unknown503_apply |
 *                               network_error_apply
 *
 * Editing endpoint mode semantics:
 * - success:              apply → 200 `{note, receipt}`; same mutation_id replay → 200 replayed.
 * - already_protected:    if the note is already d2-v1 → 200 `{note, receipt:null}` (no apply);
 *                         a legacy note is still enabled normally.
 * - restricted403:        every request → 403 `note_access_restricted` (retryable=false, terminal).
 * - dependency503:        first request for a note → 503 `note_dependency_unavailable`
 *                         (retryable=true, result known failed, no apply); retry succeeds.
 * - unknown503_apply:     the enable IS APPLIED (note becomes d2-v1) but the response is
 *                         503 `note_store_unavailable` (result unknown). Retrying the SAME
 *                         mutation_id replays the stored receipt (`replayed:true`) → 200.
 * - network_error_apply:  the enable IS APPLIED then the connection is destroyed
 *                         (transport-level unknown result). Same-mutation retry replays.
 *
 * Harness control endpoints (never called by the app):
 * - GET  /__reset            reset note store / receipts / counters
 * - GET  /__stats            counters + current store state (assertions)
 * - GET  /__note?note_id=X   current stored note (d2 projection)
 * - GET  /__bump?note_id=X   simulate another tab writing X (revision +1)
 * - GET  /__restrict?note_id=X, /__delete_note?note_id=X  (extra state helpers)
 *
 * Usage: node gateway_mock.js [port]
 */
const http = require('node:http')
const fs = require('node:fs')
const fixtures = require('./fixtures')

const PORT = Number(process.argv[2] || 8951)
const NOTE_MODE_FILE = '/tmp/issue1135-note-mode'
const ENABLE_MODE_FILE = '/tmp/issue1135-enable-mode'
const NOTE_MODES = ['editor_on', 'editor_off', 'existing_off', 'models_error', 'models_malformed']
const ENABLE_MODES = [
  'success',
  'already_protected',
  'restricted403',
  'dependency503',
  'unknown503_apply',
  'network_error_apply',
]

function readMode(file, allowed, fallback) {
  try {
    const value = fs.readFileSync(file, 'utf8').trim()
    return allowed.includes(value) ? value : fallback
  } catch {
    return fallback
  }
}

const noteMode = () => readMode(NOTE_MODE_FILE, NOTE_MODES, 'editor_on')
const enableMode = () => readMode(ENABLE_MODE_FILE, ENABLE_MODES, 'success')

// ── mutable state ──────────────────────────────────────────────────────────
let notes = fixtures.initialNoteStore()
let receipts = new Map() // mutation_id → {requestHash, receipt, noteId, appliedRevision}
const counters = {
  noteRequests: [],
  saves: [],
  enableRequests: [],
  enableApplies: [],
  models: 0,
  creates: 0,
}
/** First attempt bookkeeping for the dependency503 mode (per note). */
let enableAttemptsByNote = new Map()

function resetState() {
  notes = fixtures.initialNoteStore()
  receipts = new Map()
  enableAttemptsByNote = new Map()
  counters.noteRequests.length = 0
  counters.saves.length = 0
  counters.enableRequests.length = 0
  counters.enableApplies.length = 0
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

/** Enable protection on a legacy note (one semantic change). */
function applyEnable(note, mutationId) {
  note.edit_schema = 'd2-v1'
  note.revision = 1
  note.updated_at = nowIso()
  note.snapshot_hash = fixtures.snapshotHash(note.note_id, 1, note.title, note.content)
  const receipt = fixtures.receipt({
    noteId: note.note_id,
    mutationId,
    appliedRevision: 1,
    snapshotHashValue: note.snapshot_hash,
  })
  receipts.set(mutationId, {
    requestHash: JSON.stringify({ mutation_id: mutationId }),
    receipt,
    noteId: note.note_id,
    appliedRevision: 1,
  })
  counters.enableApplies.push({
    note_id: note.note_id,
    mutation_id: mutationId,
    applied_revision: note.revision,
    title: note.title,
    content_sha256: fixtures.sha256(note.content),
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
      enable_mode: enableMode(),
      models_requests: counters.models,
      creates: counters.creates,
      note_requests: counters.noteRequests.slice(),
      saves: counters.saves.slice(),
      enable_requests: counters.enableRequests.slice(),
      enable_applies: counters.enableApplies.slice(),
      enable_semantic_changes: counters.enableApplies.length,
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
  if (pathname === '/__delete_note') {
    const noteId = url.searchParams.get('note_id')
    const note = notes.get(noteId)
    if (!note) return sendJson(res, { ok: false, reason: 'note_not_found' }, 404)
    notes.delete(noteId)
    return sendJson(res, { ok: true, deleted: noteId })
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
    const mode = noteMode()
    if (mode === 'models_error') {
      return sendJson(res, { detail: 'synthetic model catalog is unavailable' }, 500, {
        'x-research-contract': 'v1',
      })
    }
    if (mode === 'models_malformed') return sendJson(res, fixtures.MODELS_MALFORMED)
    if (mode === 'editor_off') return sendJson(res, fixtures.MODELS_EDITOR_OFF)
    if (mode === 'existing_off') return sendJson(res, fixtures.MODELS_EXISTING_OFF)
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

  // ── issue #1135: first protection enable ───────────────────────────────
  const editingMatch = pathname.match(/\/notes\/([^/]+)\/editing$/)
  if (editingMatch !== null) {
    const noteId = decodeURIComponent(editingMatch[1])
    const note = notes.get(noteId)
    const body = await readBody(req)
    const mode = enableMode()
    const mutationId =
      body && isUsedMutation(body.mutation_id) ? body.mutation_id : null
    const entry = {
      method: req.method,
      note_id: noteId,
      mutation_id: mutationId,
      mode,
      outcome: 'pending',
      status: 0,
      at: Date.now(),
    }
    counters.enableRequests.push(entry)
    counters.noteRequests.push({
      method: req.method,
      path: pathname,
      selected: true,
      status: 0,
    })
    const noteEntry = counters.noteRequests[counters.noteRequests.length - 1]
    const finish = (outcome, status) => {
      entry.outcome = outcome
      entry.status = status
      noteEntry.status = status
    }

    if (req.method !== 'POST') {
      finish('method_not_allowed', 405)
      return sendNoteError(res, true, 405, 'note_request_invalid', 'POST required')
    }
    if (note === undefined) {
      finish('note_not_found', 404)
      return sendNoteError(res, true, 404, 'note_not_found', 'note not found')
    }
    if (note.access_state === 'restricted') {
      finish('restricted', 403)
      return sendNoteError(res, true, 403, 'note_access_restricted', 'synthetic restricted note')
    }
    if (mutationId === null) {
      finish('invalid', 422)
      return sendNoteError(res, true, 422, 'note_request_invalid', 'mutation_id required')
    }
    // Same-mutation replay is checked BEFORE failure modes: it is the
    // reconciler path that confirms a previously applied mutation.
    const replay = receipts.get(mutationId)
    if (replay !== undefined) {
      finish('replayed', 200)
      return sendJson(
        res,
        { note: snapshot(note), receipt: { ...replay.receipt, replayed: true } },
        200,
        noteHeaders(true),
      )
    }
    if (mode === 'restricted403') {
      finish('restricted', 403)
      return sendNoteError(
        res,
        true,
        403,
        'note_access_restricted',
        'synthetic restricted note (enable denied)',
      )
    }
    if (mode === 'dependency503') {
      const previous = enableAttemptsByNote.get(noteId) || 0
      enableAttemptsByNote.set(noteId, previous + 1)
      if (previous === 0) {
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
    if (note.edit_schema === 'd2-v1') {
      // Already protected: idempotent success without a semantic change.
      finish('already_protected', 200)
      return sendJson(res, { note: snapshot(note), receipt: null }, 200, noteHeaders(true))
    }
    // Apply the protection enable exactly once for this mutation_id.
    const receipt = applyEnable(note, mutationId)
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
    if (mode === 'network_error_apply') {
      finish('network_error_applied', -1)
      res.destroy()
      return
    }
    finish(mode === 'already_protected' ? 'success' : 'success', 200)
    return sendJson(res, { note: snapshot(note), receipt }, 200, noteHeaders(true))
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
    if (selected) {
      if (!body || !isUsedMutation(body.mutation_id)) {
        counters.noteRequests[counters.noteRequests.length - 1].status = 422
        return sendNoteError(res, true, 422, 'note_request_invalid', 'mutation_id required')
      }
      const replay = receipts.get(body.mutation_id)
      if (replay) {
        counters.noteRequests[counters.noteRequests.length - 1].status = 200
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
      receipts.set(body.mutation_id, { requestHash: JSON.stringify(body), receipt, noteId })
      counters.creates += 1
      counters.noteRequests[counters.noteRequests.length - 1].status = 201
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
    counters.noteRequests[counters.noteRequests.length - 1].status = 201
    return sendJson(res, fixtures.legacyNoteView(note), 201, noteHeaders(false))
  }

  // ── note detail / save / delete ─────────────────────────────────────────
  const noteMatch = pathname.match(/\/notes\/([^/]+)$/)
  if (noteMatch !== null) {
    const noteId = decodeURIComponent(noteMatch[1])
    const note = notes.get(noteId)

    if (req.method === 'GET') {
      counters.noteRequests.push({ method: 'GET', path: pathname, selected, status: 0 })
      if (!note) {
        counters.noteRequests[counters.noteRequests.length - 1].status = 404
        return selected
          ? sendNoteError(res, true, 404, 'note_not_found', 'note not found')
          : sendJson(res, { detail: 'Note not found' }, 404)
      }
      if (note.access_state === 'restricted') {
        counters.noteRequests[counters.noteRequests.length - 1].status = 403
        return selected
          ? sendNoteError(res, true, 403, 'note_access_restricted', 'synthetic restricted note')
          : sendJson(res, { detail: 'Note access restricted' }, 403)
      }
      counters.noteRequests[counters.noteRequests.length - 1].status = 200
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
      // d2-v1 CAS save (used by the in-place editor after #1135 enable).
      if (!body || !isUsedMutation(body.mutation_id)) {
        entry.status = 422
        saveEntry.status = 422
        return sendNoteError(res, true, 422, 'note_request_invalid', 'mutation_id required')
      }
      const replay = receipts.get(body.mutation_id)
      if (replay && replay.receipt) {
        entry.status = 200
        saveEntry.status = 200
        return sendJson(res, { ...replay.receipt, replayed: true }, 200, noteHeaders(true))
      }
      if (
        typeof body.expected_revision !== 'number' ||
        body.expected_revision !== note.revision
      ) {
        entry.status = 409
        saveEntry.status = 409
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
      receipts.set(body.mutation_id, { requestHash: JSON.stringify(body), receipt, noteId })
      entry.status = 200
      saveEntry.status = 200
      return sendJson(res, receipt, 200, noteHeaders(true))
    }

    if (req.method === 'DELETE') {
      counters.noteRequests.push({ method: 'DELETE', path: pathname, selected, status: 0 })
      const entry = counters.noteRequests[counters.noteRequests.length - 1]
      if (!note) {
        entry.status = 404
        return selected
          ? sendNoteError(res, true, 404, 'note_not_found', 'note not found')
          : sendJson(res, { detail: 'Note not found' }, 404)
      }
      notes.delete(noteId)
      if (selected) {
        const receipt = fixtures.receipt({
          noteId,
          mutationId: 'synthetic-delete',
          appliedRevision: note.revision,
          snapshotHashValue: null,
        })
        entry.status = 200
        return sendJson(res, receipt, 200, noteHeaders(true))
      }
      entry.status = 204
      res.writeHead(204, { ...corsHeaders(), 'x-research-contract': 'v1' })
      res.end()
      return
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
  console.log(`synthetic gateway mock (#1135 protected-edit enable): http://127.0.0.1:${PORT}`)
  console.log(`mode files: ${NOTE_MODE_FILE} ${ENABLE_MODE_FILE}`)
})
