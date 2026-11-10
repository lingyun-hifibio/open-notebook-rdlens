/**
 * Synthetic fixtures for Issue #1134 (d2-v1 Note 删除入口, fork frontend
 * single-PR) Before/After visual + browser-behaviour evidence.
 *
 * ALL content is synthetic (`[synthetic]` markers): no real RDLens host,
 * PostgreSQL, SurrealDB, files, models, patients, companies or private data.
 * The Research Gateway is route-mocked over HTTP (`gateway_mock.js`).
 *
 * Fixture identity is shared by BEFORE (fork origin/main f3e4e47) and AFTER
 * (implementation head) captures: same project `p1`, viewer `1`, notes,
 * sources, sessions and capability projection. The only expected visual delta
 * is the #1134 delta (d2-v1 rows gain a compact `note-delete-<id>` delete entry
 * in the catalog + `note-editor-delete` in the editor + the delete
 * confirmation dialog / failure states).
 *
 * d2-v1 wire shapes are mirrored from the authoritative host contract already
 * used by the #1046 PR4 / #1135 / #1136 harness (never invented):
 * - read projection = legacy keys + revision/snapshot_hash/edit_schema/access_state;
 * - mutation receipt = note_id/mutation_id/applied_revision/snapshot_hash/saved_at/replayed;
 * - error envelope = `{detail: {code, message, retryable, request_id, [current_revision], [current_snapshot_hash]}}`;
 * - d2-v1 responses carry `X-Research-Note-Contract: d2-v1`;
 * - delete mutation `DELETE /v1/research/projects/<p>/notes/<id>` with the exact
 *   body `{mutation_id, expected_revision}` and receipt `snapshot_hash: null`.
 */
const crypto = require('node:crypto')

const sha256 = (value) => crypto.createHash('sha256').update(String(value), 'utf8').digest('hex')

const PROJECT = { id: 'p1', user: '1' }
const API = `/v1/research/projects/${PROJECT.id}`

/** Mock-level snapshot hash (hex64 shape). Real d2 canonical hash is server-side. */
const snapshotHash = (noteId, revision, title, content) =>
  sha256(`synthetic-note-snapshot:${noteId}:${revision}:${title}:${content}`)

// ── Notes (fixtures are shared by both phases) ──────────────────────────────
const NOTE_D1_TITLE = '[synthetic] D1 cohort readout'
const NOTE_D1_CONTENT = [
  '## [synthetic] D1 cohort readout',
  '',
  '[synthetic] Interim analysis of the fictional D1 cohort.',
  '',
  '- ORR: 42% (21/50)',
  '- Grade >=3 TRAE: 18%',
].join('\n')

/** Second d2-v1 note: target of the E6 revision-conflict scene (revision 1 → 2). */
const NOTE_D2_TITLE = '[synthetic] D2 PK readout'
const NOTE_D2_CONTENT = [
  '## [synthetic] D2 PK readout',
  '',
  '[synthetic] Fictional dose-proportionality summary.',
  '',
  '- AUC0-24: 1180 h*ng/mL',
  '- Cmax: 92 ng/mL',
].join('\n')

const NOTE_LEGACY_TITLE = '[synthetic] Legacy note (pre-protection)'
const NOTE_LEGACY_CONTENT = [
  '[synthetic] Legacy note created before d2-v1 editing protection (fictional).',
  '',
  '- Owner: synthetic viewer 1',
  '- Binder: B-0001',
].join('\n')

/**
 * NOTE_DEFS is the seed state for both phases.
 *
 * `editSchema: 'd2-v1'` → protected note (revision/hash/editing rule; the
 *                         #1134 delete entry appears on these catalog rows).
 * `editSchema: null`        → legacy unprotected note (old Edit/Delete text
 *                             buttons and old unprotected DELETE path stay).
 */
const NOTE_DEFS = [
  {
    noteId: 'note_d1',
    title: NOTE_D1_TITLE,
    content: NOTE_D1_CONTENT,
    editSchema: 'd2-v1',
    revision: 1,
    createdAt: '2026-11-04T09:00:00.000Z',
    updatedAt: '2026-11-04T09:30:00.000Z',
  },
  {
    noteId: 'note_d2',
    title: NOTE_D2_TITLE,
    content: NOTE_D2_CONTENT,
    editSchema: 'd2-v1',
    revision: 1,
    createdAt: '2026-11-05T09:00:00.000Z',
    updatedAt: '2026-11-05T09:20:00.000Z',
  },
  {
    noteId: 'note_legacy',
    title: NOTE_LEGACY_TITLE,
    content: NOTE_LEGACY_CONTENT,
    editSchema: null,
    revision: null,
    createdAt: '2026-10-20T08:00:00.000Z',
    updatedAt: '2026-10-20T08:00:00.000Z',
  },
]

/** Fresh mutable store (the gateway keeps state per run, reset via /__reset). */
function initialNoteStore() {
  const store = new Map()
  for (const def of NOTE_DEFS) {
    store.set(def.noteId, {
      note_id: def.noteId,
      project_id: PROJECT.id,
      title: def.title,
      content: def.content,
      note_type: 'human',
      created_at: def.createdAt,
      updated_at: def.updatedAt,
      revision: def.revision,
      snapshot_hash:
        def.editSchema === null
          ? null
          : snapshotHash(def.noteId, def.revision, def.title, def.content),
      edit_schema: def.editSchema,
      access_state: 'visible',
      citations: [],
    })
  }
  return store
}

// ── Legacy (v1) vs d2-v1 read projections ──────────────────────────────────
/** Old contract shape: protected internals stripped (host `_legacy_note_view`). */
function legacyNoteView(note) {
  return {
    note_id: note.note_id,
    project_id: note.project_id,
    title: note.title,
    content: note.content,
    note_type: note.note_type,
    created_at: note.created_at,
    updated_at: note.updated_at,
  }
}

/** d2-v1 projection: legacy keys + revision/snapshot_hash/edit_schema/access_state. */
function d2NoteView(note, { includeCitations = false } = {}) {
  const view = {
    note_id: note.note_id,
    project_id: note.project_id,
    title: note.title,
    content: note.content,
    note_type: note.note_type,
    created_at: note.created_at,
    updated_at: note.updated_at,
    revision: note.revision,
    snapshot_hash: note.snapshot_hash,
    edit_schema: note.edit_schema,
    access_state: note.access_state ?? 'visible',
  }
  if (includeCitations) view.citations = []
  return view
}

function listPage(items) {
  return { items, next_cursor: null }
}

/** Receipt shape (`mutation_contract.build_receipt`); `snapshot_hash` null on delete. */
function receipt({ noteId, mutationId, appliedRevision, snapshotHashValue, replayed = false }) {
  return {
    note_id: noteId,
    mutation_id: mutationId,
    applied_revision: appliedRevision,
    snapshot_hash: snapshotHashValue,
    saved_at: new Date().toISOString(),
    replayed,
  }
}

/** Deterministic new-note id (host derives note_id from project/actor/mutation). */
function syntheticNoteId(mutationId) {
  return `note_${sha256(`synthetic-create:${mutationId}`).slice(0, 16)}`
}

// ── Capabilities (`/models`) ────────────────────────────────────────────────
const C05_CAPABILITY = {
  contract: 'c05-v1',
  enabled: true,
  preview_supported: true,
  entries: {
    search: {
      scope_modes: ['all', 'selected', 'single'],
      execution_modes: ['sync'],
      context_levels: ['focused'],
      preview_supported: true,
      execution_ready: true,
      unavailable_reason: null,
    },
    chat: {
      scope_modes: ['all', 'selected', 'single'],
      execution_modes: ['sync'],
      context_levels: ['focused'],
      preview_supported: true,
      execution_ready: true,
      unavailable_reason: null,
    },
  },
}

const MODELS = [
  {
    model_id: 'm-local-qwen',
    display_name: 'Local Qwen (synthetic)',
    provider_id: 'local-sglang',
    data_egress: false,
    interactive_context_levels: ['focused', 'document', 'workspace'],
  },
]

/** PR4 capability projection: every key is `{available, reason}` (§8.2). */
function noteCapabilities({ editorAvailable, existingAvailable = true }) {
  return {
    note_editor: {
      available: Boolean(editorAvailable),
      reason: editorAvailable
        ? null
        : existingAvailable
          ? 'disabled_by_flag'
          : 'note_store_unavailable',
    },
    note_editor_existing: {
      available: Boolean(existingAvailable),
      reason: existingAvailable ? null : 'note_store_unavailable',
    },
    markdown_export: { available: false, reason: 'not_ready' },
    writing_local: { available: false, reason: 'not_ready' },
    writing_external: { available: false, reason: 'not_ready' },
  }
}

const modelCatalog = (capabilities) => ({
  models: MODELS,
  capabilities: {
    coverage_all_selected: false,
    c05: C05_CAPABILITY,
    ...capabilities,
  },
})

/** Both `note_editor` and `note_editor_existing` available (default scenes). */
const MODELS_EDITOR_ON = modelCatalog(
  noteCapabilities({ editorAvailable: true, existingAvailable: true }),
)

/**
 * E10: `note_editor_existing.available=false` reason `note_store_unavailable`
 * (capacity to open/edit existing protected notes is off at runtime, while the
 * creation capability stays available). The d2 delete entry must stay hidden
 * (fail-closed) and the capability-blocked hint must be visible.
 */
const MODELS_EXISTING_OFF = modelCatalog(
  noteCapabilities({ editorAvailable: true, existingAvailable: false }),
)

// ── Sources / sessions (workspace chrome; unchanged by #1134) ──────────────
const SOURCE_DEFS = [
  {
    sourceId: 'src_pdf',
    documentId: 'doc_pdf',
    version: 'v1',
    title: '[synthetic] D1 cohort report (PDF)',
    sourceType: 'pdf',
    fileAvailable: true,
    fileName: 'synthetic-d1-cohort-report.pdf',
    mime: 'application/pdf',
    markdown: '[synthetic] D1 cohort interim analysis: ORR was 42% (21/50).',
  },
]

const SOURCES = SOURCE_DEFS.map((def) => ({
  source_id: def.sourceId,
  document_id: def.documentId,
  document_version: def.version,
  status: 'ready',
  content_hash: sha256(`synthetic-source:${def.documentId}:${def.version}`),
  synced_at: '2026-11-01T08:00:00+00:00',
  last_error: null,
}))

const SOURCE_DETAILS = Object.fromEntries(
  SOURCE_DEFS.map((def) => [
    def.sourceId,
    {
      ...SOURCES.find((source) => source.source_id === def.sourceId),
      title: def.title,
      source_type: def.sourceType,
      file_available: def.fileAvailable,
      markdown_chunks: [
        {
          chunk_id: `chunk_${def.sourceId}_0`,
          chunk_ordinal: 0,
          page_idx: 0,
          content_hash: sha256(`synthetic-chunk:${def.sourceId}:0`),
          markdown: def.markdown,
        },
      ],
    },
  ]),
)

const GLOBAL_SESSION = {
  session_ref: {
    domain: 'research',
    kind: 'global',
    project_id: PROJECT.id,
    session_id: 'sess_global',
    source_id: null,
  },
  title: '[synthetic] D1 cohort session',
  created_at: '2026-11-04T10:00:00+00:00',
  updated_at: '2026-11-04T10:12:00+00:00',
  record_visibility: 'visible',
  has_draft: false,
}

const SESSIONS = {
  items: [GLOBAL_SESSION],
  next_cursor: null,
  viewer_user_id: 1,
  capabilities: {
    sessions: {
      contract: 'research-session-v1',
      editor_ready: true,
      submission_ready: { global: true, source: true },
    },
  },
}

const GLOBAL_DETAIL = {
  session: {
    session_id: 'sess_global',
    title: '[synthetic] D1 cohort session',
    owner_user_id: 1,
    created_at: '2026-11-04T10:00:00+00:00',
    updated_at: '2026-11-04T10:12:00+00:00',
    record_visibility: 'visible',
  },
  messages: [],
  cards: [],
  next_cursor: null,
}

function editorStateFor(sessionId) {
  return {
    schema_version: 1,
    base_scope: { mode: 'all', source_ids: [], single_source_id: null },
    single_source_id: null,
    note_ids: [],
    draft: { text: '', token: `tok_${sessionId}` },
    chat_anchor: null,
    reader_anchor: null,
  }
}

function editorResponse(sessionId, revision = 3) {
  return {
    session_ref: {
      domain: 'research',
      kind: 'global',
      project_id: PROJECT.id,
      session_id: sessionId,
      source_id: null,
    },
    editor_revision: revision,
    editor_state: editorStateFor(sessionId),
    state_warnings: [],
    editor_intent_hash: sha256(`synthetic-intent:${sessionId}`),
    viewer_user_id: 1,
    capabilities: {
      sessions: {
        contract: 'research-session-v1',
        editor_ready: true,
        submission_ready: { global: true, source: true },
      },
    },
  }
}

const PREFERENCES = {
  project_id: PROJECT.id,
  default_context_level: 'focused',
  preferred_model_id: 'm-local-qwen',
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
  source_count: SOURCE_DEFS.length,
  chunk_count: SOURCE_DEFS.length,
  note_count: NOTE_DEFS.length,
  token_estimate: 900,
  direct_or_background: 'direct',
  needs_consent: false,
  coverage: {},
  warnings: [],
}

module.exports = {
  PROJECT,
  API,
  NOTE_DEFS,
  NOTE_D1_TITLE,
  NOTE_D1_CONTENT,
  NOTE_D2_TITLE,
  NOTE_D2_CONTENT,
  NOTE_LEGACY_TITLE,
  NOTE_LEGACY_CONTENT,
  SOURCE_DEFS,
  SOURCES,
  SOURCE_DETAILS,
  GLOBAL_SESSION,
  SESSIONS,
  GLOBAL_DETAIL,
  MODELS,
  MODELS_EDITOR_ON,
  MODELS_EXISTING_OFF,
  PREFERENCES,
  CONSENT,
  PREVIEW,
  initialNoteStore,
  legacyNoteView,
  d2NoteView,
  listPage,
  receipt,
  syntheticNoteId,
  snapshotHash,
  editorResponse,
  sha256,
}
