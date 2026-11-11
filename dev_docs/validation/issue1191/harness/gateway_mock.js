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
const NOTE_MODE_FILE = '/tmp/issue1047-note-mode'
const SAVE_MODE_FILE = '/tmp/issue1047-save-mode'
const FRAGMENT_MODE_FILE = '/tmp/issue1047-fragment-mode'
const BINDING_MODE_FILE = '/tmp/issue1047-binding-mode'
const NOTE_MODES = ['editor_on', 'editor_off', 'existing_off', 'models_error', 'restricted']
// Issue #1048 PR7：写作能力/写作行为模式（证据采集控制端点）。
const CAPABILITY_MODE_FILE = '/tmp/issue1048-capability-mode'
const WRITING_MODE_FILE = '/tmp/issue1048-writing-mode'
const CAPABILITY_MODES = ['writing_on', 'writing_off', 'export_on']
const WRITING_MODES = ['success', 'missing_refs', 'checks_unavailable', 'restricted', 'limit_exceeded', 'unknown503']
const SAVE_MODES = ['success', 'unknown503', 'network_error', 'conflict', 'slow']
const FRAGMENT_MODES = ['success', 'unknown503', 'conflict', 'notfound', 'restricted403']

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
const fragmentMode = () => readMode(FRAGMENT_MODE_FILE, FRAGMENT_MODES, 'success')
const capabilityMode = () => readMode(CAPABILITY_MODE_FILE, CAPABILITY_MODES, 'writing_on')
// Issue #1191 PR-B：单份 Markdown 导出模式（success | restricted | unavailable | conflict）
const EXPORT_MODE_FILE = '/tmp/issue1191-export-mode'
const EXPORT_MODES = ['success', 'restricted', 'unavailable', 'conflict']
const exportMode = () => readMode(EXPORT_MODE_FILE, EXPORT_MODES, 'success')
const writingMode = () => readMode(WRITING_MODE_FILE, WRITING_MODES, 'success')

// ── mutable state ──────────────────────────────────────────────────────────
let notes = fixtures.initialNoteStore()
let receipts = new Map() // mutation_id → {requestHash, receipt}
// Issue #1191 PR-B：导出记录（内存；幂等键 → 导出 id）+ 冻结字节。
let exportRecords = new Map() // export_id → {noteId, revision, snapshotHash, filename, bytes}
let exportIdempotency = new Map() // idempotency-key → {signature, exportId}
let unknownFragmentMutations = new Set()
const counters = {
  noteRequests: [],
  saves: [],
  copies: [],
  models: 0,
  creates: 0,
  exportCreates: [],
  exportGets: [],
  fragments: [],
  fragmentCreates: 0,
  // Issue #1048 PR7 writing counters
  writingSubmissions: [],
  writingAttaches: [],
  writingContexts: [],
  writingRejectedHeaders: [],
  sessionCreates: [],
}

// generation_id → { body, sessionRef, mode }
let writingStore = new Map()
// writing_intent_hash + idempotency key → generation_id（同 token 重放）
let writingByIntent = new Map()
// 结果未知场景：每次 /__reset 后每个写作意图的首次提交返回 503，重试同 intent 收敛。
let unknownWritingIntents = new Set()

function resetState() {
  notes = fixtures.initialNoteStore()
  receipts = new Map()
  unknownFragmentMutations = new Set()
  counters.noteRequests.length = 0
  counters.saves.length = 0
  counters.copies.length = 0
  counters.models = 0
  counters.creates = 0
  counters.fragments.length = 0
  counters.fragmentCreates = 0
  counters.writingSubmissions.length = 0
  counters.writingAttaches.length = 0
  counters.writingContexts.length = 0
  counters.writingRejectedHeaders.length = 0
  counters.sessionCreates.length = 0
  writingStore = new Map()
  writingByIntent = new Map()
  unknownWritingIntents = new Set()
  try {
    const bindingMode = fs.readFileSync(BINDING_MODE_FILE, 'utf8').trim()
    if (bindingMode === 'old_version') {
      const note = notes.get('note_cite')
      const binding = note && (note.citation_bindings ?? [])[0]
      if (binding) {
        binding.source_version = 'v9'
        if (binding.locator !== null) {
          binding.locator = { ...binding.locator, document_version: 'v9' }
        }
      }
    }
  } catch {
    /* default: current version */
  }
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

// ── PR5/B3 synthetic fragment resolution (host contract shapes) ─────────────
const sha256 = (value) => require('node:crypto').createHash('sha256').update(String(value), 'utf8').digest('hex')

function sourceSnapshotText(sourceId) {
  const detail = fixtures.SOURCE_DETAILS[sourceId]
  if (!detail) return null
  return [...(detail.markdown_chunks ?? [])]
    .sort((a, b) => (a.chunk_ordinal ?? 0) - (b.chunk_ordinal ?? 0))
    .map((chunk) => chunk.markdown)
    .join('\n\n')
}

function sourceForKind(source) {
  if (!source || typeof source !== 'object') return { error: 'note_request_invalid' }
  if (source.source_kind === 'source') {
    const detail = fixtures.SOURCE_DETAILS[source.source_id]
    const text = sourceSnapshotText(source.source_id)
    if (!detail || text === null) return { error: 'fragment_source_not_found' }
    if (source.source_version !== detail.document_version) {
      return { error: 'fragment_source_not_found' }
    }
    return {
      text,
      contentHash: sha256(text),
      bindingLocator: {
        document_id: detail.document_id,
        document_version: detail.document_version,
      },
    }
  }
  if (source.source_kind === 'chat_message') {
    const message = fixtures.GLOBAL_DETAIL.messages.find((item) => item.message_id === source.source_id)
    if (!message) return { error: 'fragment_source_not_found' }
    return {
      text: message.content,
      contentHash: sha256(message.content),
      bindingLocator: {
        surface: 'global',
        session_id: 'sess_global',
        message_id: message.message_id,
      },
    }
  }
  if (source.source_kind === 'legacy_insight') {
    const insight = fixtures.INSIGHTS.find((item) => item.insight_id === source.source_id)
    if (!insight) return { error: 'fragment_source_not_found' }
    return {
      text: insight.content,
      contentHash: sha256(insight.content),
      bindingLocator: { insight_id: insight.insight_id },
    }
  }
  if (source.source_kind === 'note') {
    const note = notes.get(source.source_id)
    if (!note || note.edit_schema !== 'd2-v1') return { error: 'fragment_source_not_found' }
    const version = `${note.revision}:${note.snapshot_hash}`
    if (source.source_version !== version) {
      return { error: 'note_revision_conflict', current_revision: note.revision, current_snapshot_hash: note.snapshot_hash }
    }
    return { text: note.content, contentHash: sha256(note.content), bindingLocator: null, sourceNote: note }
  }
  return { error: 'note_request_invalid' }
}

function rangeFromSelection(selection, text) {
  if (!selection || typeof selection !== 'object') return { error: 'note_request_invalid' }
  if (selection.kind === 'full') return { start: 0, end: text.length }
  if (selection.kind !== 'range') return { error: 'note_request_invalid' }
  const start = selection.start_utf16
  const end = selection.end_utf16
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || start >= end || end > text.length) {
    return { error: 'note_request_invalid' }
  }
  return { start, end }
}

function targetFromTarget(target, content) {
  if (!target || typeof target !== 'object') return { error: 'note_request_invalid' }
  if (target.kind === 'cursor') {
    const position = target.position_utf16
    if (!Number.isInteger(position) || position < 0 || position > content.length) {
      return { error: 'note_request_invalid' }
    }
    return { prefix: content.slice(0, position), suffix: content.slice(position) }
  }
  if (target.kind === 'range') {
    const start = target.start_utf16
    const end = target.end_utf16
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || start >= end || end > content.length) {
      return { error: 'note_request_invalid' }
    }
    return { prefix: content.slice(0, start), suffix: content.slice(end) }
  }
  return { error: 'note_request_invalid' }
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
      fragment_mode: fragmentMode(),
      models_requests: counters.models,
      creates: counters.creates,
      fragment_creates: counters.fragmentCreates,
      fragments: counters.fragments.slice(),
      fragment_requests: counters.fragments.slice(),
      capability_mode: capabilityMode(),
      writing_mode: writingMode(),
      writing_submissions: counters.writingSubmissions.slice(),
      writing_attaches: counters.writingAttaches.slice(),
      writing_contexts: counters.writingContexts.slice(),
      writing_rejected_headers: counters.writingRejectedHeaders.slice(),
      session_creates: counters.sessionCreates.slice(),
      note_requests: counters.noteRequests.slice(),
      saves: counters.saves.slice(),
      export_creates: counters.exportCreates.slice(),
      export_gets: counters.exportGets.slice(),
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
  if (pathname === '/__binding') {
    const note = notes.get(url.searchParams.get('note_id'))
    const bindingId = url.searchParams.get('binding_id')
    if (!note) return sendJson(res, { ok: false, reason: 'note_not_found' }, 404)
    const binding = (note.citation_bindings ?? []).find((item) => item.binding_id === bindingId)
    if (!binding) return sendJson(res, { ok: false, reason: 'binding_not_found' }, 404)
    const version = url.searchParams.get('source_version')
    if (version !== null) binding.source_version = version
    const locatorVersion = url.searchParams.get('locator_version')
    if (locatorVersion !== null && binding.locator !== null) {
      binding.locator = { ...binding.locator, document_version: locatorVersion }
    }
    const unresolved = url.searchParams.get('unresolved')
    if (unresolved !== null) binding.unresolved = unresolved === '1'
    return sendJson(res, { ok: true, binding })
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
    // Issue #1048 PR7：writing_local 能力投影（默认关闭由 writing_off 模拟）。
    if (capabilityMode() === 'writing_off') return sendJson(res, fixtures.MODELS_WRITING_OFF)
    if (capabilityMode() === 'export_on') return sendJson(res, fixtures.MODELS_EXPORT_ON)
    return sendJson(res, fixtures.MODELS_WRITING_ON)
  }
  if (pathname.endsWith('/execution-preferences')) return sendJson(res, fixtures.PREFERENCES)
  if (pathname.endsWith('/external-egress-consent')) return sendJson(res, fixtures.CONSENT)
  if (pathname.endsWith('/context-preview') || pathname.endsWith('/c05/preview')) {
    return sendJson(res, fixtures.PREVIEW)
  }
  if (pathname.endsWith('/workspace-status')) {
    return sendJson(res, { enabled: true, contract: 'research-session-v1' })
  }

  // ── Issue #1191 PR-B：单份 Markdown 导出（#1050 后端契约的合成替身） ──
  const exportCreateMatch = pathname.match(/\/notes\/([^/]+)\/exports$/)
  if (exportCreateMatch !== null && req.method === 'POST') {
    const noteId = decodeURIComponent(exportCreateMatch[1])
    const body = await readBody(req)
    const contract = req.headers['x-research-note-contract']
    const idempotencyKey = req.headers['idempotency-key']
    const entry = {
      method: 'POST',
      path: pathname,
      note_id: noteId,
      contract: typeof contract === 'string' ? contract : null,
      idempotency_key: typeof idempotencyKey === 'string' ? idempotencyKey : null,
      body,
      status: 0,
    }
    counters.exportCreates.push(entry)
    if (contract !== 'd2-v1') {
      entry.status = 422
      return sendJson(res, { detail: { code: 'note_request_invalid', message: 'contract header required', retryable: false } }, 422)
    }
    if (typeof idempotencyKey !== 'string' || idempotencyKey.length === 0) {
      entry.status = 422
      return sendJson(res, { detail: { code: 'note_request_invalid', message: 'idempotency key required', retryable: false } }, 422)
    }
    if (
      !body ||
      Object.keys(body).length !== 3 ||
      !Number.isInteger(body.revision) ||
      typeof body.snapshot_hash !== 'string' ||
      body.format !== 'markdown'
    ) {
      entry.status = 422
      return sendJson(res, { detail: { code: 'note_request_invalid', message: 'closed body required', retryable: false } }, 422)
    }
    const mode = exportMode()
    if (mode === 'restricted') {
      entry.status = 403
      return sendJson(res, { detail: { code: 'note_access_restricted', message: 'synthetic export permission denied', retryable: false } }, 403)
    }
    if (mode === 'unavailable') {
      entry.status = 503
      return sendJson(res, { detail: { code: 'export_snapshot_unavailable', message: 'synthetic export service unavailable', retryable: true } }, 503)
    }
    if (mode === 'conflict') {
      entry.status = 409
      return sendJson(res, { detail: { code: 'export_request_conflict', message: 'synthetic export request conflict', retryable: false } }, 409)
    }
    const note = notes.get(noteId)
    if (!note) {
      entry.status = 404
      return sendJson(res, { detail: { code: 'note_not_found', message: 'note not found', retryable: false } }, 404)
    }
    if (note.revision !== body.revision || note.snapshot_hash !== body.snapshot_hash) {
      entry.status = 409
      return sendJson(res, {
        detail: {
          code: 'note_revision_conflict',
          message: 'revision/snapshot mismatch',
          retryable: false,
          current_revision: note.revision,
          current_snapshot_hash: note.snapshot_hash,
        },
      }, 409)
    }
    const signature = `${noteId}\u0000${body.revision}\u0000${body.snapshot_hash}\u0000markdown`
    const replay = exportIdempotency.get(idempotencyKey)
    if (replay !== undefined) {
      if (replay.signature !== signature) {
        entry.status = 409
        return sendJson(res, { detail: { code: 'export_request_conflict', message: 'idempotency key bound to another export', retryable: false } }, 409)
      }
      entry.status = 200
      const frozen = exportRecords.get(replay.exportId)
      return sendJson(res, {
        export_id: replay.exportId,
        note_id: noteId,
        note_revision: body.revision,
        snapshot_hash: body.snapshot_hash,
        format: 'markdown',
        download_url: `/v1/research/projects/${fixtures.PROJECT.id}/export/${replay.exportId}/file`,
        replayed: true,
        created_at: '2026-11-11T08:00:00+00:00',
        file_name: frozen ? frozen.filename : null,
      }, 200)
    }
    const exportId = `nex_${require('node:crypto').randomBytes(16).toString('hex')}`
    const citationLines = (note.citation_bindings || []).map(
      (binding) => `- [${binding.binding_id}] ${binding.source_kind}:${binding.source_id} (${binding.source_version ?? 'n/a'})`,
    )
    const markdown = [
      `# ${note.title}`,
      '',
      `<!-- rdlens-note-export note_id=${noteId} revision=${body.revision} snapshot_hash=${body.snapshot_hash} format=markdown -->`,
      '',
      note.content,
      ...(citationLines.length > 0 ? ['', '## Citations', ...citationLines] : []),
      '',
    ].join('\n')
    const filename = `${String(note.title).replace(/[\/\\]/g, '_')}.md`
    exportRecords.set(exportId, {
      noteId,
      revision: body.revision,
      snapshotHash: body.snapshot_hash,
      filename,
      bytes: Buffer.from(markdown, 'utf8'),
    })
    exportIdempotency.set(idempotencyKey, { signature, exportId })
    entry.status = 201
    return sendJson(res, {
      export_id: exportId,
      note_id: noteId,
      note_revision: body.revision,
      snapshot_hash: body.snapshot_hash,
      format: 'markdown',
      download_url: `/v1/research/projects/${fixtures.PROJECT.id}/export/${exportId}/file`,
      replayed: false,
      created_at: '2026-11-11T08:00:00+00:00',
      file_name: filename,
    }, 201)
  }

  const exportFileMatch = pathname.match(/\/export\/(nex_[0-9a-f]{32})\/file$/)
  if (exportFileMatch !== null && req.method === 'GET') {
    const exportId = exportFileMatch[1]
    const record = exportRecords.get(exportId)
    counters.exportGets.push({ export_id: exportId, status: record ? 200 : 404 })
    if (!record) {
      return sendJson(res, { detail: { code: 'export_not_found', message: 'export not found', retryable: false } }, 404)
    }
    res.writeHead(200, {
      'content-type': 'text/markdown; charset=utf-8',
      'content-disposition': `attachment; filename="${record.filename}"`,
      'access-control-allow-origin': '*',
      'access-control-expose-headers': 'Content-Disposition',
    })
    res.end(record.bytes)
    return true
  }

  // ── PR5/B3: fragments (existing target) ────────────────────────────────
  const fragmentsMatch = pathname.match(/\/notes\/([^/]+)\/fragments$/)
  if (fragmentsMatch !== null && req.method === 'POST') {
    const noteId = decodeURIComponent(fragmentsMatch[1])
    const body = await readBody(req)
    const noteRecord = { method: 'POST', path: pathname, selected, status: 0 }
    counters.noteRequests.push(noteRecord)
    if (!selected) {
      noteRecord.status = 428
      return sendNoteError(res, false, 428, 'note_revision_required', 'd2-v1 header required')
    }
    const note = notes.get(noteId)
    if (!note || note.edit_schema !== 'd2-v1') {
      noteRecord.status = 404
      return sendNoteError(res, true, 404, 'note_not_found', 'note not found')
    }
    if (!body || typeof body.mutation_id !== 'string' || body.mutation_id.length === 0) {
      noteRecord.status = 422
      return sendNoteError(res, true, 422, 'note_request_invalid', 'mutation_id required')
    }
    const replay = receipts.get(body.mutation_id)
    if (replay) {
      noteRecord.status = 200
      counters.fragments.push({ note_id: noteId, mutation_id: body.mutation_id, status: 200, replayed: true })
      return sendJson(res, { ...replay.receipt, replayed: true }, 200, noteHeaders(true))
    }
    const mode = fragmentMode()
    if (mode === 'unknown503' && !unknownFragmentMutations.has(body.mutation_id)) {
      unknownFragmentMutations.add(body.mutation_id)
      noteRecord.status = 503
      counters.fragments.push({ note_id: noteId, mutation_id: body.mutation_id, status: 503 })
      return sendNoteError(res, true, 503, 'note_store_unavailable', 'synthetic unknown result', { retryable: true })
    }
    if (mode === 'restricted403') {
      noteRecord.status = 403
      counters.fragments.push({ note_id: noteId, mutation_id: body.mutation_id, status: 403 })
      return sendNoteError(res, true, 403, 'note_access_restricted', 'synthetic restricted fragment')
    }
    if (mode === 'conflict') {
      noteRecord.status = 409
      counters.fragments.push({ note_id: noteId, mutation_id: body.mutation_id, status: 409 })
      return sendNoteError(res, true, 409, 'note_revision_conflict', 'synthetic target conflict', {
        current_revision: note.revision + 1,
        current_snapshot_hash: fixtures.snapshotHash(note.note_id, note.revision + 1, note.title, note.content),
      })
    }
    if (body.expected_revision !== note.revision) {
      noteRecord.status = 409
      counters.fragments.push({ note_id: noteId, mutation_id: body.mutation_id, status: 409 })
      return sendNoteError(res, true, 409, 'note_revision_conflict', 'target revision conflict', {
        current_revision: note.revision,
        current_snapshot_hash: note.snapshot_hash,
      })
    }
    const resolved = sourceForKind(body.source)
    if (resolved.error) {
      noteRecord.status = resolved.error === 'note_revision_conflict' ? 409 : resolved.error === 'fragment_source_not_found' ? 404 : 422
      counters.fragments.push({ note_id: noteId, mutation_id: body.mutation_id, status: noteRecord.status })
      return sendNoteError(
        res,
        true,
        noteRecord.status,
        resolved.error,
        'synthetic fragment source failure',
        resolved.error === 'note_revision_conflict'
          ? { current_revision: resolved.current_revision, current_snapshot_hash: resolved.current_snapshot_hash }
          : {},
      )
    }
    const range = rangeFromSelection(body.source.selection, resolved.text)
    if (range.error) {
      noteRecord.status = 422
      counters.fragments.push({ note_id: noteId, mutation_id: body.mutation_id, status: 422 })
      return sendNoteError(res, true, 422, 'note_request_invalid', 'invalid selection')
    }
    const target = targetFromTarget(body.target, note.content)
    if (target.error) {
      noteRecord.status = 422
      counters.fragments.push({ note_id: noteId, mutation_id: body.mutation_id, status: 422 })
      return sendNoteError(res, true, 422, 'note_request_invalid', 'invalid target')
    }
    const excerpt = resolved.text.slice(range.start, range.end)
    const bindingId = `cb_${sha256(`${body.mutation_id}:${noteId}`).slice(0, 32)}`
    let insertText = excerpt
    const newBindings = []
    const origLocator = resolved.bindingLocator === null ? null : {
      ...resolved.bindingLocator,
      start_utf16: resolved.bindingLocator.document_id === undefined ? range.start : range.start,
      end_utf16: range.end,
      content_hash: resolved.contentHash,
    }
    if (resolved.sourceNote) {
      // note→note：逐字复制源 binding（新 binding_id），正文 marker 同步重写。
      for (const sourceBinding of resolved.sourceNote.citation_bindings ?? []) {
        const remappedId = `cb_${sha256(`${body.mutation_id}:${sourceBinding.binding_id}`).slice(0, 32)}`
        insertText = insertText.split(`[[cite:${sourceBinding.binding_id}]]`).join(`[[cite:${remappedId}]]`)
        newBindings.push({ ...sourceBinding, binding_id: remappedId })
      }
    }
    insertText += `[[cite:${bindingId}]]`
    newBindings.push({
      binding_id: bindingId,
      source_kind: body.source.source_kind,
      source_id: body.source.source_id,
      source_version: body.source.source_version,
      locator: origLocator,
      unresolved: false,
    })
    note.content = target.prefix + insertText + target.suffix
    note.revision += 1
    note.updated_at = nowIso()
    note.snapshot_hash = fixtures.snapshotHash(note.note_id, note.revision, note.title, note.content)
    note.citation_bindings = [...(note.citation_bindings ?? []), ...newBindings]
    note.origins = [
      ...(note.origins ?? []),
      {
        origin_id: `origin_frag_${sha256(`${body.mutation_id}:origin`).slice(0, 32)}`,
        source_kind: body.source.source_kind,
        source_id: body.source.source_id,
        source_version: body.source.source_version,
        locator: origLocator,
      },
    ]
    const dependencies = []
    if (body.source.source_kind === 'source') {
      dependencies.push({ document_id: resolved.bindingLocator.document_id, document_version: resolved.bindingLocator.document_version })
    }
    if (body.source.source_kind === 'note') {
      dependencies.push({ note_id: body.source.source_id, note_content_hash: sha256(resolved.text) })
    }
    note.document_dependencies = [...(note.document_dependencies ?? []), ...dependencies]
    const receipt = fixtures.receipt({
      noteId,
      mutationId: body.mutation_id,
      appliedRevision: note.revision,
      snapshotHashValue: note.snapshot_hash,
    })
    receipts.set(body.mutation_id, { requestHash: JSON.stringify(body), receipt })
    counters.fragments.push({
      note_id: noteId,
      mutation_id: body.mutation_id,
      expected_revision: body.expected_revision,
      source_kind: body.source.source_kind,
      source_id: body.source.source_id,
      selection: body.source.selection,
      target: body.target,
      status: 201,
      revision: note.revision,
    })
    noteRecord.status = 201
    return sendJson(res, receipt, 201, noteHeaders(true))
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
      if (body.fragment !== undefined) {
        const resolved = sourceForKind(body.fragment.source)
        if (resolved.error) {
          counters.noteRequests[counters.noteRequests.length - 1].status =
            resolved.error === 'fragment_source_not_found' ? 404 : 422
          return sendNoteError(
            res,
            true,
            counters.noteRequests[counters.noteRequests.length - 1].status,
            resolved.error,
            'synthetic fragment source failure',
          )
        }
        const range = rangeFromSelection(body.fragment.source.selection, resolved.text)
        if (range.error) {
          counters.noteRequests[counters.noteRequests.length - 1].status = 422
          return sendNoteError(res, true, 422, 'note_request_invalid', 'invalid selection')
        }
        const bindingId = `cb_${sha256(`${body.mutation_id}:create`).slice(0, 32)}`
        const excerpt = resolved.text.slice(range.start, range.end)
        const createdFragment = existing ?? {
          note_id: noteId,
          project_id: fixtures.PROJECT.id,
          title: typeof body.title === 'string' ? body.title : '未命名成果',
          content: `${excerpt}[[cite:${bindingId}]]`,
          note_type: 'human',
          created_at: nowIso(),
          updated_at: nowIso(),
          revision: 1,
          snapshot_hash: null,
          edit_schema: 'd2-v1',
          access_state: 'visible',
          citations: [],
          citation_bindings: [],
          origins: [],
          document_dependencies: [],
        }
        if (existing === undefined) notes.set(noteId, createdFragment)
        createdFragment.citation_bindings = [
          ...(createdFragment.citation_bindings ?? []),
          {
            binding_id: bindingId,
            source_kind: body.fragment.source.source_kind,
            source_id: body.fragment.source.source_id,
            source_version: body.fragment.source.source_version,
            locator:
              resolved.bindingLocator === null
                ? null
                : {
                    ...resolved.bindingLocator,
                    start_utf16: range.start,
                    end_utf16: range.end,
                    content_hash: resolved.contentHash,
                  },
            unresolved: false,
          },
        ]
        createdFragment.origins = [
          ...(createdFragment.origins ?? []),
          {
            origin_id: `origin_frag_${sha256(`${body.mutation_id}:origin`).slice(0, 32)}`,
            source_kind: body.fragment.source.source_kind,
            source_id: body.fragment.source.source_id,
            source_version: body.fragment.source.source_version,
            locator: null,
          },
        ]
        createdFragment.snapshot_hash = fixtures.snapshotHash(
          noteId,
          createdFragment.revision,
          createdFragment.title,
          createdFragment.content,
        )
        const fragmentReceipt = fixtures.receipt({
          noteId,
          mutationId: body.mutation_id,
          appliedRevision: createdFragment.revision,
          snapshotHashValue: createdFragment.snapshot_hash,
        })
        receipts.set(body.mutation_id, { requestHash: JSON.stringify(body), receipt: fragmentReceipt })
        counters.creates += 1
        counters.fragmentCreates += 1
        counters.noteRequests[counters.noteRequests.length - 1].status = 201
        return sendJson(res, fragmentReceipt, 201, noteHeaders(true))
      }
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
          citation_bindings: [],
          origins: [],
          document_dependencies: [],
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
      if (noteMode() === 'restricted' && noteId === 'note_safety') {
        counters.noteRequests[counters.noteRequests.length - 1].status = 403
        return selected
          ? sendNoteError(res, true, 403, 'note_access_restricted', 'synthetic restricted source note')
          : sendJson(res, { detail: 'Note access restricted' }, 403)
      }
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
      if (mode === 'restricted403') {
      noteRecord.status = 403
      counters.fragments.push({ note_id: noteId, mutation_id: body.mutation_id, status: 403 })
      return sendNoteError(res, true, 403, 'note_access_restricted', 'synthetic restricted fragment')
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

  // ── Issue #1048 PR7：本地写作会话/传输（合成） ─────────────────────────
  // GET/PUT editor-state（global/source 同构）
  const editorMatch = pathname.match(/\/sessions\/([^/]+)\/editor-state$/)
  if (editorMatch !== null) {
    const sessionId = decodeURIComponent(editorMatch[1])
    const sourceMatch = pathname.match(/\/sources\/([^/]+)\/chat\/sessions\//)
    const sourceId = sourceMatch === null ? null : decodeURIComponent(sourceMatch[1])
    const ref = {
      domain: 'research',
      kind: sourceId === null ? 'global' : 'source',
      project_id: fixtures.PROJECT.id,
      session_id: sessionId,
      source_id: sourceId,
    }
    const base = fixtures.editorResponse(sessionId)
    const baseState = {
      ...base.editor_state,
      base_scope: sourceId === null ? base.editor_state.base_scope : null,
    }
    if (req.method === 'PUT') {
      const body = await readBody(req)
      const requested =
        body && typeof body.editor_state === 'object' && body.editor_state !== null
          ? body.editor_state
          : baseState
      const revision =
        (body && Number.isInteger(body.expected_revision) ? body.expected_revision : base.editor_revision) + 1
      const state = {
        schema_version: 1,
        base_scope: requested.base_scope ?? null,
        single_source_id: requested.single_source_id ?? null,
        note_ids: Array.isArray(requested.note_ids) ? requested.note_ids : [],
        draft: {
          text: requested.draft && typeof requested.draft.text === 'string' ? requested.draft.text : '',
          token:
            requested.draft && typeof requested.draft.token === 'string'
              ? requested.draft.token
              : 'tok_saved',
        },
        chat_anchor: requested.chat_anchor ?? null,
        reader_anchor: requested.reader_anchor ?? null,
      }
      counters.saves.push({
        session_id: sessionId,
        expected_revision: body ? body.expected_revision : null,
        mutation_id: body ? body.mutation_id : null,
        draft_text: state.draft.text,
        draft_token: state.draft.token,
      })
      return sendJson(
        res,
        {
          session_ref: ref,
          editor_revision: revision,
          editor_state: state,
          mutation_id: body && typeof body.mutation_id === 'string' ? body.mutation_id : 'mut_1',
          saved_at: nowIso(),
          editor_intent_hash: fixtures.sha256(JSON.stringify(state)),
        },
        200,
        { 'x-research-session-contract': 'research-session-v1' },
      )
    }
    return sendJson(res, {
      session_ref: ref,
      editor_revision: base.editor_revision,
      editor_state: baseState,
      state_warnings: [],
      editor_intent_hash: fixtures.sha256(JSON.stringify(baseState)),
      viewer_user_id: 1,
      capabilities: base.capabilities,
    })
  }

  // POST create session（global/source）：客户端预生成 session_id → create_response
  if (
    req.method === 'POST' &&
    (pathname.endsWith('/chat/sessions') || /\/sources\/[^/]+\/chat\/sessions$/.test(pathname))
  ) {
    const body = await readBody(req)
    const sourceMatch = pathname.match(/\/sources\/([^/]+)\/chat\/sessions$/)
    const sourceId = sourceMatch === null ? null : decodeURIComponent(sourceMatch[1])
    const sessionId =
      body && typeof body.session_id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(body.session_id)
        ? body.session_id
        : 'sess_invalid'
    counters.sessionCreates.push({ session_id: sessionId, kind: sourceId === null ? 'global' : 'source', source_id: sourceId })
    const ref = {
      domain: 'research',
      kind: sourceId === null ? 'global' : 'source',
      project_id: fixtures.PROJECT.id,
      session_id: sessionId,
      source_id: sourceId,
    }
    const state = {
      schema_version: 1,
      base_scope:
        sourceId === null ? { mode: 'all', source_ids: [], single_source_id: null } : null,
      single_source_id: null,
      note_ids: [],
      draft: { text: '', token: `tok_${sessionId}` },
      chat_anchor: null,
      reader_anchor: null,
    }
    return sendJson(
      res,
      {
        session_ref: ref,
        editor_revision: 0,
        editor_state: state,
        state_warnings: [],
        created: true,
        editor_intent_hash: fixtures.sha256(JSON.stringify(state)),
      },
      201,
      { 'x-research-session-contract': 'research-session-v1' },
    )
  }

  // POST .../writing（两步：202 受理回执 → Last-Event-ID:0 SSE）
  const writingMatch =
    pathname.match(/\/sources\/([^/]+)\/chat\/sessions\/([^/]+)\/writing$/) ??
    pathname.match(/\/chat\/sessions\/([^/]+)\/writing$/)
  if (writingMatch !== null && req.method === 'POST') {
    const body = await readBody(req)
    const isSource = pathname.includes('/sources/')
    const sourceId = isSource ? decodeURIComponent(writingMatch[1]) : null
    const sessionId = decodeURIComponent(isSource ? writingMatch[2] : writingMatch[1])
    const ref = {
      domain: 'research',
      kind: isSource ? 'source' : 'global',
      project_id: fixtures.PROJECT.id,
      session_id: sessionId,
      source_id: sourceId,
    }
    const idempotencyKey = req.headers['idempotency-key'] ?? null
    const lastEventId = req.headers['last-event-id']
    // host PR7 第一道检查：会话契约头必须存在且为 research-session-v1
    // （`writing_submission.require_writing_headers`）。mock 必须同样校验，
    // 否则证据会空转（独立审查 BLOCKING-1）。
    const sessionContract = req.headers['x-research-session-contract'] ?? null
    const researchContract = req.headers['x-research-contract'] ?? null
    const recordHeaderRejection = (reason) => {
      counters.writingRejectedHeaders.push({
        reason,
        session_contract: sessionContract,
        research_contract: researchContract,
        has_source_scope: body !== null && typeof body === 'object' && 'source_scope' in body,
        last_event_id: lastEventId === undefined ? null : String(lastEventId),
      })
    }
    if (sessionContract !== 'research-session-v1') {
      recordHeaderRejection('session_contract_unsupported')
      return sendJson(
        res,
        { detail: { code: 'session_contract_unsupported', message: 'X-Research-Session-Contract: research-session-v1 is required', retryable: false, request_id: 'req_w_header' } },
        422,
      )
    }
    if (researchContract !== (isSource ? 'v1' : 'c05-v1')) {
      recordHeaderRejection('research_contract_mismatch')
      return sendJson(
        res,
        { detail: { code: 'session_contract_unsupported', message: 'X-Research-Contract mismatch', retryable: false, request_id: 'req_w_contract' } },
        426,
      )
    }
    if (body !== null && typeof body === 'object' && 'source_scope' in body) {
      recordHeaderRejection('source_scope_forbidden')
      return sendJson(
        res,
        { detail: { code: 'scope_header_payload_mismatch', message: 'source_scope is derived by the server', retryable: false, request_id: 'req_w_scope' } },
        422,
      )
    }
    const requiredKeys = [
      'schema_version',
      'editor_revision',
      'draft_token',
      'editor_intent_hash',
      'writing_intent_hash',
      'query',
      'model',
      'response_language',
      'work_purpose',
      'document_context',
      'history_mode',
    ]
    const bodyKeys = body && typeof body === 'object' ? Object.keys(body).sort() : []
    if (
      body === null ||
      JSON.stringify(bodyKeys) !== JSON.stringify([...requiredKeys].sort()) ||
      body.schema_version !== 1 ||
      body.work_purpose !== 'writing' ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(String(body.draft_token)) ||
      !/^[0-9a-f]{64}$/.test(String(body.editor_intent_hash)) ||
      !/^[0-9a-f]{64}$/.test(String(body.writing_intent_hash))
    ) {
      return sendJson(
        res,
        { detail: { code: 'note_request_invalid', message: 'invalid writing request', retryable: false, request_id: 'req_w_invalid' } },
        422,
      )
    }
    const mode = writingMode()
    if (mode === 'limit_exceeded' && lastEventId === undefined) {
      return sendJson(
        res,
        { detail: { code: 'context_limit_exceeded', message: 'synthetic capacity limit', retryable: false, request_id: 'req_w_limit' } },
        422,
      )
    }
    const intentKey = `${sessionId}|${idempotencyKey}|${body.writing_intent_hash}`
    if (mode === 'unknown503' && lastEventId === undefined && !unknownWritingIntents.has(intentKey)) {
      unknownWritingIntents.add(intentKey)
      return sendJson(
        res,
        { detail: { code: 'writing_input_unavailable', message: 'synthetic unknown result', retryable: true, request_id: 'req_w_unknown' } },
        503,
      )
    }
    let generationId = writingByIntent.get(intentKey) ?? null
    if (generationId === null) {
      generationId = `gen_w_${writingStore.size + 1}`
      writingByIntent.set(intentKey, generationId)
    }
    if (!writingStore.has(generationId)) {
      writingStore.set(generationId, { body, sessionRef: ref, mode, submittedAt: nowIso() })
    }
    if (lastEventId === undefined) {
      counters.writingSubmissions.push({
        session_id: sessionId,
        session_kind: ref.kind,
        source_id: sourceId,
        schema_version: body.schema_version,
        work_purpose: body.work_purpose,
        request_keys: Object.keys(body).sort(),
        editor_revision: body.editor_revision,
        draft_token: body.draft_token,
        editor_intent_hash: body.editor_intent_hash,
        writing_intent_hash: body.writing_intent_hash,
        query: body.query,
        model: body.model,
        response_language: body.response_language,
        history_mode: body.history_mode,
        document_context: body.document_context,
        idempotency_key: idempotencyKey,
        generation_id: generationId,
        headers: {
          session_contract: sessionContract,
          research_contract: researchContract,
        },
      })
      const receipt = {
        session_ref: ref,
        draft_token: body.draft_token,
        idempotency_key: idempotencyKey,
        acceptance_state: 'accepted',
        generation_id: generationId,
        generation_state: 'running',
        accepted_editor_revision: body.editor_revision,
        editor_intent_hash: body.editor_intent_hash,
        submitted_draft_text: body.query,
        context_report: null,
      }
      // 与 host `WRITING_RECEIPT_KEYS` 同顺序同键集（前端严格闭合 10 键）。
      counters.writingSubmissions[counters.writingSubmissions.length - 1].receipt_keys =
        Object.keys(receipt)
      return sendJson(
        res,
        receipt,
        202,
        { 'x-research-session-contract': 'research-session-v1', 'x-research-contract': isSource ? 'v1' : 'c05-v1' },
      )
    }
    // attach：SSE 重放（accepted → answer → done）
    counters.writingAttaches.push({ generation_id: generationId, session_id: sessionId })
    res.writeHead(200, {
      ...corsHeaders(),
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-research-session-contract': 'research-session-v1',
      'x-research-contract': 'c05-v1',
    })
    const sendFrame = (type, payload) => {
      res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`)
    }
    sendFrame('usage', {
      event_id: 1,
      accepted: {
        session_ref: ref,
        generation_id: generationId,
        request_id: `req_w_${generationId}`,
        editor_revision: body.editor_revision,
        draft_token: body.draft_token,
        editor_intent_hash: body.editor_intent_hash,
      },
      work_purpose: 'writing',
      work_purpose_source: 'explicit',
    })
    const answerParts = [
      '[synthetic] Suggested revision: ',
      'the D1 cohort objective response rate was 42% (21/50) in the fictional interim analysis.',
    ]
    answerParts.forEach((part, index) => {
      sendFrame('answer', { event_id: index + 2, delta: part })
    })
    sendFrame('done', {
      event_id: answerParts.length + 2,
      completion_status: 'completed',
      session_id: sessionId,
      request_id: `req_w_${generationId}`,
    })
    res.end()
    return
  }

  // GET /writing-contexts/{generation_id}：实际输入回看（含 writing_checks）
  const contextMatch = pathname.match(/\/writing-contexts\/([^/]+)$/)
  if (contextMatch !== null && req.method === 'GET') {
    const generationId = decodeURIComponent(contextMatch[1])
    const stored = writingStore.get(generationId)
    if (!stored) {
      return sendJson(
        res,
        { detail: { code: 'session_not_found', message: 'unknown generation', retryable: false, request_id: 'req_ctx_404' } },
        404,
      )
    }
    const { body, sessionRef } = stored
    const mode = stored.mode
    const documentContext = body.document_context ?? {}
    const note = notes.get(documentContext.note_id) ?? null
    const fullText = note ? note.content : '[synthetic] note body unavailable in fixture'
    const selection = documentContext.selection ?? { kind: 'full' }
    const start = selection.kind === 'range' ? selection.start_utf16 : null
    const end = selection.kind === 'range' ? selection.end_utf16 : null
    const selectedText = selection.kind === 'full' ? fullText : fullText.slice(start, end)
    const restricted = mode === 'restricted'
    const checks =
      mode === 'missing_refs'
        ? { version: 1, missing_binding_ids: ['cb_src'], unavailable_reason: null }
        : mode === 'checks_unavailable'
          ? { version: 1, missing_binding_ids: [], unavailable_reason: 'report_missing' }
          : { version: 1, missing_binding_ids: [], unavailable_reason: null }
    const adopted =
      body.history_mode === 'current'
        ? [
            {
              message_id: 'msg_hist_1',
              role: 'user',
              text: restricted ? null : '[synthetic] earlier question about the D1 cohort',
              text_hash: fixtures.sha256('synthetic-history-turn-1'),
            },
          ]
        : []
    const excluded =
      body.history_mode === 'current'
        ? [{ message_id: 'msg_hist_2', reason: 'history_budget_excluded' }]
        : []
    const projection = {
      generation_id: generationId,
      input_id: `inp_${fixtures.sha256(generationId)}`,
      input_schema_version: 4,
      input_hash: fixtures.sha256(JSON.stringify(body)),
      document_context: {
        note_id: documentContext.note_id,
        revision: documentContext.revision,
        snapshot_hash: documentContext.snapshot_hash,
        selection_kind: selection.kind,
        start_utf16: start,
        end_utf16: end,
        selected_text: restricted ? null : selectedText,
        selected_text_hash: fixtures.sha256(selectedText),
      },
      history: { mode: body.history_mode, adopted, excluded },
      integrity: {
        document_context_hash: fixtures.sha256(JSON.stringify({ note: documentContext.note_id, start, end })),
        history_hash: fixtures.sha256(JSON.stringify(body.history_mode)),
        envelope_hash: fixtures.sha256(JSON.stringify(body)),
      },
      capacity: {
        input_utf8_bytes: Buffer.byteLength(JSON.stringify(body), 'utf8'),
        envelope_utf8_bytes: Buffer.byteLength(JSON.stringify({ body }), 'utf8'),
        limit_utf8_bytes: 1048576,
      },
      writing_checks: mode === 'checks_unavailable' ? checks : checks,
      access_state: restricted ? 'restricted' : 'visible',
    }
    counters.writingContexts.push({
      generation_id: generationId,
      access_state: projection.access_state,
      history_mode: body.history_mode,
      missing_binding_ids: checks.missing_binding_ids,
      session_id: sessionRef.sessionId,
    })
    return sendJson(res, projection)
  }

  // ── workspace chrome (unchanged by PR4) ────────────────────────────────
  if (pathname.endsWith('/chat/sessions') && req.method === 'GET') {
    return sendJson(res, fixtures.SESSIONS)
  }
  const globalDetail = pathname.match(/\/chat\/sessions\/([^/]+)$/)
  if (globalDetail !== null) {
    // 与 host 会话详情一致：limit 默认 50；asc 从最旧、desc 从最新窗口，
    // next_cursor 指向下一窗口（offset_N）。H-1 需要 >50 条真实分页。
    const all = fixtures.GLOBAL_DETAIL.messages
    const limit = Math.max(1, Math.min(200, Number(url.searchParams.get('limit') ?? '50') || 50))
    const order = url.searchParams.get('order') === 'desc' ? 'desc' : 'asc'
    const cursor = url.searchParams.get('cursor')
    const offset = cursor && /^offset_\d+$/.test(cursor) ? Number(cursor.slice('offset_'.length)) : 0
    let page
    let nextCursor = null
    if (order === 'asc') {
      page = all.slice(offset, offset + limit)
      nextCursor = offset + limit < all.length ? `offset_${offset + limit}` : null
    } else {
      const end = Math.max(0, all.length - offset)
      const start = Math.max(0, end - limit)
      page = all.slice(start, end)
      nextCursor = start > 0 ? `offset_${offset + limit}` : null
    }
    return sendJson(
      res,
      { ...fixtures.GLOBAL_DETAIL, messages: page, next_cursor: nextCursor },
      200,
      { 'x-research-message-projection': 'd1e-message-v4' },
    )
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
  if (pathname.endsWith('/insights')) {
    return sendJson(res, fixtures.listPage(fixtures.INSIGHTS))
  }
  if (pathname.endsWith('/jobs') || pathname.endsWith('/transformations')) {
    return sendJson(res, fixtures.listPage([]))
  }
  return sendJson(res, {})
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`synthetic gateway mock (#1046 PR4): http://127.0.0.1:${PORT}`)
  console.log(`mode files: ${NOTE_MODE_FILE} ${SAVE_MODE_FILE}`)
})
