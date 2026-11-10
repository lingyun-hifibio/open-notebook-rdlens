#!/usr/bin/env node
/**
 * Synthetic Research Gateway mock for Issue #1046 PR4 fork visual evidence.
 *
 * Route-mocked Gateway over HTTP with permissive CORS so the real Next.js fork
 * app (embedded iframe on another local port) can call it. No database, no
 * model calls, no credentials; all fixtures are synthetic (`fixtures.js`).
 *
 * PR4 additions (d2-v1 Note API + capability projection):
 * - GET    .../notes                (d2-v1 header → revision/snapshot_hash/edit_schema/access_state)
 * - GET    .../notes/{id}
 * - POST   .../notes                (d2-v1 → receipt 201 / replay 200)
 * - PATCH  .../notes/{id}           (revision CAS → 409 note_revision_conflict)
 * - DELETE .../notes/{id}
 * - POST   .../notes/{id}/editing   (first protection enable)
 * - POST   .../notes/{id}/copies    (local draft protected save-as-copy)
 * - GET    .../models               (capabilities note_editor/note_editor_existing/...)
 *
 * Failure modes (mode files, read per request, written by capture/f15):
 * - /tmp/issue1046-note-mode   editor_on | editor_off | existing_off | models_error
 * - /tmp/issue1046-save-mode   success | unknown503 | network_error | conflict | slow
 *
 * unknown503: first PATCH for a mutation_id → 503 `note_store_unavailable`
 * (retryable, "unknown result"); retrying the SAME mutation_id converges to
 * success (contract: confirm the original mutation before new writes).
 * network_error: the PATCH connection is destroyed (transport-level failure).
 * conflict: every PATCH → 409 with current revision/hash.
 * slow: +1500ms then normal success (lets a "saving" state be captured).
 *
 * Harness control endpoints (never called by the app):
 * - GET  /__reset            reset note store / receipts / counters
 * - GET  /__stats            counters + current store state (assertions)
 * - GET  /__bump?note_id=X   simulate another tab writing X (revision +1)
 * - GET  /__note?note_id=X   current stored note
 *
 * Usage: node gateway_mock.js [port]
 */
const http = require('node:http')
const fs = require('node:fs')
const fixtures = require('./fixtures')

const PORT = Number(process.argv[2] || 8841)
const NOTE_MODE_FILE = '/tmp/issue1046-note-mode'
const SAVE_MODE_FILE = '/tmp/issue1046-save-mode'
const NOTE_MODES = ['editor_on', 'editor_off', 'existing_off', 'models_error']
const SAVE_MODES = ['success', 'unknown503', 'network_error', 'conflict', 'slow']

function readMode(file, allowed, fallback) {
  try {
    const value = fs.readFileSync(file, 'utf8').trim()
    return allowed.includes(value) ? value : fallback
  } catch {
    return fallback
  }
}

const noteMode = () => readMode(NOTE_MODE_FILE, NOTE_MODES, 'editor_on')
const saveMode = () => readMode(SAVE_MODE_FILE, SAVE_MODES, 'success')

// ── mutable state ──────────────────────────────────────────────────────────
let notes = fixtures.initialNoteStore()
let receipts = new Map() // mutation_id → {requestHash, receipt}
const counters = {
  noteRequests: [],
  saves: [],
  copies: [],
  models: 0,
  creates: 0,
}

function resetState() {
  notes = fixtures.initialNoteStore()
  receipts = new Map()
  counters.noteRequests.length = 0
  counters.saves.length = 0
  counters.copies.length = 0
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

function rollRevision(note, { title, content }) {
  note.revision += 1
  if (title !== undefined) note.title = title
  if (content !== undefined) note.content = content
  note.updated_at = nowIso()
  note.snapshot_hash =
    note.edit_schema === 'd2-v1'
      ? fixtures.snapshotHash(note.note_id, note.revision, note.title, note.content)
      : null
}

function currentView(note, { selected, includeCitations = false }) {
  return selected
    ? fixtures.d2NoteView(note, { includeCitations })
    : fixtures.legacyNoteView(note)
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
      save_mode: saveMode(),
      models_requests: counters.models,
      creates: counters.creates,
      note_requests: counters.noteRequests.slice(),
      saves: counters.saves.slice(),
      copies: counters.copies.slice(),
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
    // Simulate another tab editing the same note (revision advance).
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

  // ── d2-v1 note sub-routes (must run before generic note routes) ─────────
  const copiesMatch = pathname.match(/\/notes\/([^/]+)\/copies$/)
  if (copiesMatch !== null) {
    const sourceId = decodeURIComponent(copiesMatch[1])
    const body = await readBody(req)
    const source = notes.get(sourceId)
    counters.noteRequests.push({ method: req.method, path: pathname, selected, status: 0 })
    if (!source) {
      counters.noteRequests[counters.noteRequests.length - 1].status = 404
      return sendNoteError(res, selected, 404, 'note_not_found', 'note not found')
    }
    if (source.edit_schema !== 'd2-v1') {
      counters.noteRequests[counters.noteRequests.length - 1].status = 409
      return sendNoteError(
        res,
        selected,
        409,
        'note_edit_schema_unsupported',
        'source note is not a d2-v1 protected note',
      )
    }
    if (!body || !isUsedMutation(body.mutation_id)) {
      counters.noteRequests[counters.noteRequests.length - 1].status = 422
      return sendNoteError(res, selected, 422, 'note_request_invalid', 'mutation_id required')
    }
    const replay = receipts.get(body.mutation_id)
    if (replay) {
      counters.noteRequests[counters.noteRequests.length - 1].status = 200
      return sendJson(res, { ...replay.receipt, replayed: true }, 200, noteHeaders(true))
    }
    const newId = fixtures.syntheticNoteId(body.mutation_id)
    const created = {
      note_id: newId,
      project_id: fixtures.PROJECT.id,
      title: typeof body.title === 'string' ? body.title : '',
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
    created.snapshot_hash = fixtures.snapshotHash(newId, 1, created.title, created.content)
    notes.set(newId, created)
    const receipt = fixtures.receipt({
      noteId: newId,
      mutationId: body.mutation_id,
      appliedRevision: 1,
      snapshotHashValue: created.snapshot_hash,
    })
    receipts.set(body.mutation_id, { requestHash: JSON.stringify(body), receipt })
    counters.copies.push({
      source_id: sourceId,
      new_note_id: newId,
      source_revision: body.source_revision ?? null,
      at: Date.now(),
    })
    counters.noteRequests[counters.noteRequests.length - 1].status = 201
    return sendJson(res, receipt, 201, noteHeaders(true))
  }

  const editingMatch = pathname.match(/\/notes\/([^/]+)\/editing$/)
  if (editingMatch !== null) {
    const noteId = decodeURIComponent(editingMatch[1])
    const note = notes.get(noteId)
    counters.noteRequests.push({ method: req.method, path: pathname, selected, status: 0 })
    if (!note) {
      counters.noteRequests[counters.noteRequests.length - 1].status = 404
      return sendNoteError(res, selected, 404, 'note_not_found', 'note not found')
    }
    if (note.edit_schema === 'd2-v1') {
      counters.noteRequests[counters.noteRequests.length - 1].status = 200
      return sendJson(res, { note: snapshot(note), receipt: null }, 200, noteHeaders(true))
    }
    note.edit_schema = 'd2-v1'
    note.revision = 1
    note.snapshot_hash = fixtures.snapshotHash(noteId, 1, note.title, note.content)
    note.updated_at = nowIso()
    counters.noteRequests[counters.noteRequests.length - 1].status = 200
    return sendJson(
      res,
      {
        note: snapshot(note),
        receipt: fixtures.receipt({
          noteId,
          mutationId: `enable-${noteId}`,
          appliedRevision: 1,
          snapshotHashValue: note.snapshot_hash,
        }),
      },
      200,
      noteHeaders(true),
    )
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
      const existing = notes.get(noteId)
      const created =
        existing ?? {
          note_id: noteId,
          project_id: fixtures.PROJECT.id,
          title: typeof body.title === 'string' ? body.title : '未命名成果',
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
      if (existing === undefined) notes.set(noteId, created)
      created.snapshot_hash =
        created.snapshot_hash ||
        fixtures.snapshotHash(noteId, created.revision, created.title, created.content)
      const receipt = fixtures.receipt({
        noteId,
        mutationId: body.mutation_id,
        appliedRevision: created.revision,
        snapshotHashValue: created.snapshot_hash,
      })
      receipts.set(body.mutation_id, { requestHash: JSON.stringify(body), receipt })
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
      const mode = saveMode()
      counters.noteRequests.push({ method: 'PATCH', path: pathname, selected, status: 0 })
      const entry = counters.noteRequests[counters.noteRequests.length - 1]
      counters.saves.push({
        note_id: noteId,
        selected,
        mode,
        mutation_id: body && body.mutation_id ? body.mutation_id : null,
        expected_revision: body && body.expected_revision !== undefined
          ? body.expected_revision
          : null,
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
      if (mode === 'network_error') {
        entry.status = -1
        saveEntry.status = -1
        res.destroy()
        return
      }
      if (mode === 'slow') {
        await new Promise((resolve) => setTimeout(resolve, 1500))
      }
      if (mode === 'conflict') {
        entry.status = 409
        saveEntry.status = 409
        return sendNoteError(
          res,
          selected,
          409,
          'note_revision_conflict',
          'expected revision does not match the stored note',
          { current_revision: note.revision, current_snapshot_hash: note.snapshot_hash },
        )
      }
      if (mode === 'unknown503') {
        const previous = receipts.get(body && body.mutation_id)
        // First attempt for a mutation is unknown; retrying the SAME mutation converges.
        if (!previous || previous.unknown503 !== true) {
          entry.status = 503
          saveEntry.status = 503
          if (body && isUsedMutation(body.mutation_id)) {
            receipts.set(body.mutation_id, { unknown503: true })
          }
          return sendNoteError(
            res,
            selected,
            503,
            'note_store_unavailable',
            'synthetic store result unknown; retry the same mutation',
            { retryable: true },
          )
        }
        receipts.delete(body.mutation_id)
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

      // d2-v1 CAS save
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
      if (typeof body.expected_revision !== 'number' || body.expected_revision !== note.revision) {
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
      const previousRevision = note.revision
      const previousHash = note.snapshot_hash
      rollRevision(note, {
        title: typeof body.title === 'string' ? body.title : note.title,
        content: typeof body.content === 'string' ? body.content : note.content,
      })
      note.revision = previousRevision + 1
      const receipt = fixtures.receipt({
        noteId,
        mutationId: body.mutation_id,
        appliedRevision: note.revision,
        snapshotHashValue: note.snapshot_hash,
      })
      receipts.set(body.mutation_id, {
        requestHash: JSON.stringify(body),
        receipt,
        noteId,
        previousRevision,
        previousHash,
      })
      entry.status = 200
      saveEntry.status = 200
      return sendJson(res, receipt, 200, noteHeaders(true))
    }

    if (req.method === 'DELETE') {
      const body = await readBody(req)
      counters.noteRequests.push({ method: 'DELETE', path: pathname, selected, status: 0 })
      const entry = counters.noteRequests[counters.noteRequests.length - 1]
      if (!note) {
        entry.status = 404
        return selected
          ? sendNoteError(res, true, 404, 'note_not_found', 'note not found')
          : sendJson(res, { detail: 'Note not found' }, 404)
      }
      if (selected) {
        if (!body || typeof body.expected_revision !== 'number' || body.expected_revision !== note.revision) {
          entry.status = 409
          return sendNoteError(
            res,
            true,
            409,
            'note_revision_conflict',
            'expected revision does not match the stored note',
            { current_revision: note.revision, current_snapshot_hash: note.snapshot_hash },
          )
        }
        const receipt = fixtures.receipt({
          noteId,
          mutationId: body.mutation_id,
          appliedRevision: note.revision,
          snapshotHashValue: null,
        })
        notes.delete(noteId)
        entry.status = 200
        return sendJson(res, receipt, 200, noteHeaders(true))
      }
      notes.delete(noteId)
      entry.status = 204
      res.writeHead(204, { ...corsHeaders(), 'x-research-contract': 'v1' })
      res.end()
      return
    }
  }

  if (pathname.includes('/submissions/')) {
    return sendJson(res, { detail: 'submission_not_found' }, 404)
  }

  // ── workspace chrome (unchanged by PR4) ────────────────────────────────
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
  console.log(`synthetic gateway mock (#1046 PR4): http://127.0.0.1:${PORT}`)
  console.log(`mode files: ${NOTE_MODE_FILE} ${SAVE_MODE_FILE}`)
})
