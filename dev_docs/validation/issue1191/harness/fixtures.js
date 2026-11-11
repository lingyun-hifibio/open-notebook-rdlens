/**
 * Synthetic fixtures for Issue #1046 PR4 (D2-B2 Markdown editor & recovery)
 * fork visual evidence.
 *
 * ALL content is synthetic (`[synthetic]` markers): no real RDLens host,
 * PostgreSQL, SurrealDB, files, models, patients, companies or private data.
 * The Research Gateway is route-mocked over HTTP (`gateway_mock.js`).
 *
 * Fixture identity is shared by BEFORE (fork pin 906aaf0) and AFTER (PR head)
 * captures: same project `p1`, viewer `1`, notes, sources, sessions and modes.
 * The only expected visual delta is the PR4 UI delta (note catalog, editor,
 * save status, draft recovery banner, conflict/leave dialogs, capability
 * blocked state, local-cache degradation notice).
 *
 * d2-v1 wire shapes are mirrored from the authoritative host implementation
 * (`repo/src/rdlens/research/issue585/note_api.py`,
 * `repo/src/rdlens/research/router.py` note routes, contract
 * `deploy/research/issue585_d2_contract_v1.yaml`), never invented:
 * - read projection = legacy keys + revision/snapshot_hash/edit_schema/access_state;
 * - mutation receipt = note_id/mutation_id/applied_revision/snapshot_hash/saved_at/replayed;
 * - error envelope = `{detail: {code, message, retryable, request_id, [current_revision], [current_snapshot_hash]}}`;
 * - d2-v1 responses carry `X-Research-Note-Contract: d2-v1`.
 */
const crypto = require('node:crypto')

const sha256 = (value) => crypto.createHash('sha256').update(String(value), 'utf8').digest('hex')

const PROJECT = { id: 'p1', user: '1' }
const API = `/v1/research/projects/${PROJECT.id}`

/** Mock-level snapshot hash (hex64 shape). Real d2 canonical hash is server-side. */
const snapshotHash = (noteId, revision, title, content) =>
  sha256(`synthetic-note-snapshot:${noteId}:${revision}:${title}:${content}`)

// ── Notes (fixtures are shared by both phases) ──────────────────────────────
const NOTE_D1_CONTENT = [
  '## [synthetic] D1 cohort readout',
  '',
  '[synthetic] Interim analysis of the fictional D1 cohort.',
  '',
  '- ORR: 42% (21/50)',
  '- Median follow-up: 9.4 months',
  '- Grade >=3 TRAE: 18%',
  '',
  '| Arm | ORR |',
  '| --- | --- |',
  '| S1 | 45% |',
  '| S2 | 39% |',
].join('\n')

const NOTE_SAFETY_CONTENT = [
  '## [synthetic] Safety summary',
  '',
  '[synthetic] Fictional safety narrative for the D1 cohort.',
  '',
  '1. Grade >=3 TRAE rate was 18%.',
  '2. No new safety signals were reported.',
].join('\n')

const CHAT_TAIL_CONTENT =
  '[synthetic] Tail assistant answer after a 60-message history: ORR 42% (21/50).'

const NOTE_CITE_CONTENT = [
  '## [synthetic] Citation round-trip note',
  '',
  '[synthetic] D1 cohort readout with a verified source citation[[cite:cb_src]].',
  '',
  'The ORR figure is traceable to the synthetic D1 report.',
  '',
  'Tail citation from the long session[[cite:cb_tail]].',
  '',
  'Cross-note citation[[cite:cb_note]].',
].join('\n')

const NOTE_LEGACY_CONTENT =
  '[synthetic] Legacy note created before d2-v1 editing protection (fictional).'

/**
 * NOTE_DEFS is the seed state for both phases.
 *
 * `editSchema: 'd2-v1'` → protected note (revision/hash/editing rule).
 * `editSchema: null`        → legacy note (old unprotected form stays valid).
 */
const NOTE_DEFS = [
  {
    noteId: 'note_d1',
    title: '[synthetic] D1 cohort readout',
    content: NOTE_D1_CONTENT,
    editSchema: 'd2-v1',
    revision: 3,
    createdAt: '2026-11-04T09:00:00.000Z',
    updatedAt: '2026-11-04T09:30:00.000Z',
  },
  {
    noteId: 'note_safety',
    title: '[synthetic] Safety summary',
    content: NOTE_SAFETY_CONTENT,
    editSchema: 'd2-v1',
    revision: 2,
    createdAt: '2026-11-04T09:05:00.000Z',
    updatedAt: '2026-11-04T09:40:00.000Z',
  },
  {
    noteId: 'note_cite',
    title: '[synthetic] Citation round-trip note',
    content: NOTE_CITE_CONTENT,
    editSchema: 'd2-v1',
    revision: 2,
    createdAt: '2026-11-04T09:10:00.000Z',
    updatedAt: '2026-11-04T09:45:00.000Z',
  },
  {
    noteId: 'note_legacy',
    title: '[synthetic] Legacy note (pre-protection)',
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
      // PR5/B3 additive read projection (d2-v1 detail only).
      citation_bindings:
        def.noteId === 'note_cite'
          ? [
              {
                binding_id: 'cb_src',
                source_kind: 'source',
                source_id: 'src_pdf',
                source_version: 'v1',
                locator: {
                  document_id: 'doc_pdf',
                  document_version: 'v1',
                  start_utf16: 0,
                  end_utf16: 46,
                  content_hash: SOURCE_JOINED_HASH.src_pdf,
                },
                unresolved: false,
              },
              {
                binding_id: 'cb_tail',
                source_kind: 'chat_message',
                source_id: 'msg_tail',
                source_version: null,
                locator: {
                  surface: 'global',
                  session_id: 'sess_global',
                  message_id: 'msg_tail',
                  start_utf16: 0,
                  end_utf16: CHAT_TAIL_CONTENT.length,
                  content_hash: sha256(CHAT_TAIL_CONTENT),
                },
                unresolved: false,
              },
              {
                binding_id: 'cb_note',
                source_kind: 'note',
                source_id: 'note_safety',
                source_version: `2:${snapshotHash(
                  'note_safety',
                  2,
                  '[synthetic] Safety summary',
                  NOTE_SAFETY_CONTENT,
                )}`,
                locator: {
                  start_utf16: 0,
                  end_utf16: 10,
                  content_hash: sha256(NOTE_SAFETY_CONTENT),
                },
                unresolved: false,
              },
            ]
          : [],
      origins:
        def.noteId === 'note_cite'
          ? [
              {
                origin_id: 'origin_frag_seed',
                source_kind: 'source',
                source_id: 'src_pdf',
                source_version: 'v1',
                locator: {
                  document_id: 'doc_pdf',
                  document_version: 'v1',
                  start_utf16: 0,
                  end_utf16: 46,
                  content_hash: SOURCE_JOINED_HASH.src_pdf,
                },
              },
            ]
          : [],
      document_dependencies:
        def.noteId === 'note_cite'
          ? [{ document_id: 'doc_pdf', document_version: 'v1' }]
          : [],
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
    citation_bindings: note.citation_bindings ?? [],
    origins: note.origins ?? [],
    document_dependencies: note.document_dependencies ?? [],
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
    coverage: {
      scope_modes: ['selected'],
      execution_modes: ['job'],
      context_levels: ['focused'],
      preview_supported: false,
      execution_ready: true,
      unavailable_reason: null,
    },
    compare: {
      scope_modes: ['selected'],
      execution_modes: ['sync'],
      context_levels: ['focused'],
      preview_supported: false,
      execution_ready: true,
      unavailable_reason: null,
    },
    ai_insight: {
      scope_modes: ['selected'],
      execution_modes: ['sync'],
      context_levels: ['focused'],
      preview_supported: false,
      execution_ready: true,
      unavailable_reason: null,
    },
    transformation: {
      scope_modes: ['selected'],
      execution_modes: ['sync'],
      context_levels: ['focused'],
      preview_supported: false,
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
function noteCapabilities({
  editorAvailable,
  existingAvailable = true,
  writingAvailable = false,
  exportAvailable = false,
}) {
  return {
    'd1e_roundtrip': { contract: 'd1e-roundtrip-v1', enabled: true },
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
    markdown_export: {
      available: Boolean(exportAvailable),
      reason: exportAvailable ? null : 'not_ready',
    },
    writing_local: {
      available: Boolean(writingAvailable),
      reason: writingAvailable ? null : 'not_ready',
    },
    writing_external: { available: false, reason: 'not_ready' },
  }
}

const MODELS_EDITOR_ON = {
  models: MODELS,
  capabilities: {
    coverage_all_selected: false,
    c05: C05_CAPABILITY,
    ...noteCapabilities({ editorAvailable: true }),
  },
}

/** `note_editor` off (flag closed) but existing d2-v1 notes stay editable. */
const MODELS_EDITOR_OFF = {
  models: MODELS,
  capabilities: {
    coverage_all_selected: false,
    c05: C05_CAPABILITY,
    ...noteCapabilities({ editorAvailable: false }),
  },
}

/** Issue #1048 PR7：本地写作能力打开（模式文件 writing_on）。 */
const MODELS_WRITING_ON = {
  models: MODELS,
  capabilities: {
    coverage_all_selected: false,
    c05: C05_CAPABILITY,
    ...noteCapabilities({ editorAvailable: true, writingAvailable: true }),
  },
}

/** Issue #1048 PR7：本地写作能力关闭（默认关闭；入口必须不显示）。 */
const MODELS_WRITING_OFF = {
  models: MODELS,
  capabilities: {
    coverage_all_selected: false,
    c05: C05_CAPABILITY,
    ...noteCapabilities({ editorAvailable: true, writingAvailable: false }),
  },
}

/** Issue #1191 PR-B：单份 Markdown 导出能力打开（模式文件 export_on）。 */
const MODELS_EXPORT_ON = {
  models: MODELS,
  capabilities: {
    coverage_all_selected: false,
    c05: C05_CAPABILITY,
    ...noteCapabilities({ editorAvailable: true, writingAvailable: true, exportAvailable: true }),
  },
}

/** `note_editor_existing` unavailable (runtime failure) — everything blocked. */
const MODELS_EXISTING_OFF = {
  models: MODELS,
  capabilities: {
    coverage_all_selected: false,
    c05: C05_CAPABILITY,
    ...noteCapabilities({ editorAvailable: false, existingAvailable: false }),
  },
}

// ── Sources / sessions (workspace chrome; unchanged by PR4) ────────────────
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
    markdown:
      '[synthetic] D1 cohort interim analysis.\n\nORR was 42% (21/50) in the fictional D1 cohort.\n\nMedian follow-up: 9.4 months.',
  },
  {
    sourceId: 'src_ppt',
    documentId: 'doc_ppt',
    version: 'v1',
    title: '[synthetic] D1 cohort deck (PPT)',
    sourceType: 'ppt',
    fileAvailable: true,
    fileName: 'synthetic-d1-cohort-deck.pptx',
    mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    markdown: '[synthetic] Slide 2: ORR was 42% (21/50) in the D1 cohort.',
  },
]

const SOURCE_JOINED_TEXT = Object.fromEntries(
  SOURCE_DEFS.map((def) => [def.sourceId, def.markdown]),
)
const SOURCE_JOINED_HASH = Object.fromEntries(
  SOURCE_DEFS.map((def) => [def.sourceId, sha256(SOURCE_JOINED_TEXT[def.sourceId])]),
)

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
  messages: [
    {
      message_id: 'msg_answer_1',
      role: 'assistant',
      content:
        '[synthetic] The fictional D1 cohort reported ORR 42% (21/50) at a median follow-up of 9.4 months.',
      thinking: null,
      citations: [],
      usage: null,
      resolved_mode: 'sync',
      degradation_reasons: [],
      created_at: '2026-11-04T10:05:00+00:00',
    },
        {
      message_id: 'msg_user_2',
      role: 'user',
      content: '[synthetic] filler question 2',
      thinking: null,
      citations: [],
      usage: null,
      resolved_mode: 'sync',
      degradation_reasons: [],
      created_at: '2026-11-04T10:00:02+00:00',
    },
    {
      message_id: 'msg_user_3',
      role: 'user',
      content: '[synthetic] filler question 3',
      thinking: null,
      citations: [],
      usage: null,
      resolved_mode: 'sync',
      degradation_reasons: [],
      created_at: '2026-11-04T10:00:03+00:00',
    },
    {
      message_id: 'msg_user_4',
      role: 'user',
      content: '[synthetic] filler question 4',
      thinking: null,
      citations: [],
      usage: null,
      resolved_mode: 'sync',
      degradation_reasons: [],
      created_at: '2026-11-04T10:00:04+00:00',
    },
    {
      message_id: 'msg_user_5',
      role: 'user',
      content: '[synthetic] filler question 5',
      thinking: null,
      citations: [],
      usage: null,
      resolved_mode: 'sync',
      degradation_reasons: [],
      created_at: '2026-11-04T10:00:05+00:00',
    },
    {
      message_id: 'msg_user_6',
      role: 'user',
      content: '[synthetic] filler question 6',
      thinking: null,
      citations: [],
      usage: null,
      resolved_mode: 'sync',
      degradation_reasons: [],
      created_at: '2026-11-04T10:00:06+00:00',
    },
    {
      message_id: 'msg_user_7',
      role: 'user',
      content: '[synthetic] filler question 7',
      thinking: null,
      citations: [],
      usage: null,
      resolved_mode: 'sync',
      degradation_reasons: [],
      created_at: '2026-11-04T10:00:07+00:00',
    },
    {
      message_id: 'msg_user_8',
      role: 'user',
      content: '[synthetic] filler question 8',
      thinking: null,
      citations: [],
      usage: null,
      resolved_mode: 'sync',
      degradation_reasons: [],
      created_at: '2026-11-04T10:00:08+00:00',
    },
    {
      message_id: 'msg_user_9',
      role: 'user',
      content: '[synthetic] filler question 9',
      thinking: null,
      citations: [],
      usage: null,
      resolved_mode: 'sync',
      degradation_reasons: [],
      created_at: '2026-11-04T10:00:09+00:00',
    },
    {
      message_id: 'msg_user_10',
      role: 'user',
      content: '[synthetic] filler question 10',
      thinking: null,
      citations: [],
      usage: null,
      resolved_mode: 'sync',
      degradation_reasons: [],
      created_at: '2026-11-04T10:00:10+00:00',
    },
    {
      message_id: 'msg_user_11',
      role: 'user',
      content: '[synthetic] filler question 11',
      thinking: null,
      citations: [],
      usage: null,
      resolved_mode: 'sync',
      degradation_reasons: [],
      created_at: '2026-11-04T10:00:11+00:00',
    },
    {
      message_id: 'msg_user_12',
      role: 'user',
      content: '[synthetic] filler question 12',
      thinking: null,
      citations: [],
      usage: null,
      resolved_mode: 'sync',
      degradation_reasons: [],
      created_at: '2026-11-04T10:00:12+00:00',
    },
    {
      message_id: 'msg_user_13',
      role: 'user',
      content: '[synthetic] filler question 13',
      thinking: null,
      citations: [],
      usage: null,
      resolved_mode: 'sync',
      degradation_reasons: [],
      created_at: '2026-11-04T10:00:13+00:00',
    },
    {
      message_id: 'msg_user_14',
      role: 'user',
      content: '[synthetic] filler question 14',
      thinking: null,
      citations: [],
      usage: null,
      resolved_mode: 'sync',
      degradation_reasons: [],
      created_at: '2026-11-04T10:00:14+00:00',
    },
    {
      message_id: 'msg_user_15',
      role: 'user',
      content: '[synthetic] filler question 15',
      thinking: null,
      citations: [],
      usage: null,
      resolved_mode: 'sync',
      degradation_reasons: [],
      created_at: '2026-11-04T10:00:15+00:00',
    },
    {
      message_id: 'msg_user_16',
      role: 'user',
      content: '[synthetic] filler question 16',
      thinking: null,
      citations: [],
      usage: null,
      resolved_mode: 'sync',
      degradation_reasons: [],
      created_at: '2026-11-04T10:00:16+00:00',
    },
    {
      message_id: 'msg_user_17',
      role: 'user',
      content: '[synthetic] filler question 17',
      thinking: null,
      citations: [],
      usage: null,
      resolved_mode: 'sync',
      degradation_reasons: [],
      created_at: '2026-11-04T10:00:17+00:00',
    },
    {
      message_id: 'msg_user_18',
      role: 'user',
      content: '[synthetic] filler question 18',
      thinking: null,
      citations: [],
      usage: null,
      resolved_mode: 'sync',
      degradation_reasons: [],
      created_at: '2026-11-04T10:00:18+00:00',
    },
    {
      message_id: 'msg_user_19',
      role: 'user',
      content: '[synthetic] filler question 19',
      thinking: null,
      citations: [],
      usage: null,
      resolved_mode: 'sync',
      degradation_reasons: [],
      created_at: '2026-11-04T10:00:19+00:00',
    },
    {
      message_id: 'msg_user_20',
      role: 'user',
      content: '[synthetic] filler question 20',
      thinking: null,
      citations: [],
      usage: null,
      resolved_mode: 'sync',
      degradation_reasons: [],
      created_at: '2026-11-04T10:00:20+00:00',
    },
    {
      message_id: 'msg_user_21',
      role: 'user',
      content: '[synthetic] filler question 21',
      thinking: null,
      citations: [],
      usage: null,
      resolved_mode: 'sync',
      degradation_reasons: [],
      created_at: '2026-11-04T10:00:21+00:00',
    },
    {
      message_id: 'msg_user_22',
      role: 'user',
      content: '[synthetic] filler question 22',
      thinking: null,
      citations: [],
      usage: null,
      resolved_mode: 'sync',
      degradation_reasons: [],
      created_at: '2026-11-04T10:00:22+00:00',
    },
    {
      message_id: 'msg_user_23',
      role: 'user',
      content: '[synthetic] filler question 23',
      thinking: null,
      citations: [],
      usage: null,
      resolved_mode: 'sync',
      degradation_reasons: [],
      created_at: '2026-11-04T10:00:23+00:00',
    },
    {
      message_id: 'msg_user_24',
      role: 'user',
      content: '[synthetic] filler question 24',
      thinking: null,
      citations: [],
      usage: null,
      resolved_mode: 'sync',
      degradation_reasons: [],
      created_at: '2026-11-04T10:00:24+00:00',
    },
    {
      message_id: 'msg_user_25',
      role: 'user',
      content: '[synthetic] filler question 25',
      thinking: null,
      citations: [],
      usage: null,
      resolved_mode: 'sync',
      degradation_reasons: [],
      created_at: '2026-11-04T10:00:25+00:00',
    },
    {
      message_id: 'msg_user_26',
      role: 'user',
      content: '[synthetic] filler question 26',
      thinking: null,
      citations: [],
      usage: null,
      resolved_mode: 'sync',
      degradation_reasons: [],
      created_at: '2026-11-04T10:00:26+00:00',
    },
    {
      message_id: 'msg_user_27',
      role: 'user',
      content: '[synthetic] filler question 27',
      thinking: null,
      citations: [],
      usage: null,
      resolved_mode: 'sync',
      degradation_reasons: [],
      created_at: '2026-11-04T10:00:27+00:00',
    },
    {
      message_id: 'msg_user_28',
      role: 'user',
      content: '[synthetic] filler question 28',
      thinking: null,
      citations: [],
      usage: null,
      resolved_mode: 'sync',
      degradation_reasons: [],
      created_at: '2026-11-04T10:00:28+00:00',
    },
    {
      message_id: 'msg_user_29',
      role: 'user',
      content: '[synthetic] filler question 29',
      thinking: null,
      citations: [],
      usage: null,
      resolved_mode: 'sync',
      degradation_reasons: [],
      created_at: '2026-11-04T10:00:29+00:00',
    },
    {
      message_id: 'msg_user_30',
      role: 'user',
      content: '[synthetic] filler question 30',
      thinking: null,
      citations: [],
      usage: null,
      resolved_mode: 'sync',
      degradation_reasons: [],
      created_at: '2026-11-04T10:00:30+00:00',
    },
    {
      message_id: 'msg_user_31',
      role: 'user',
      content: '[synthetic] filler question 31',
      thinking: null,
      citations: [],
      usage: null,
      resolved_mode: 'sync',
      degradation_reasons: [],
      created_at: '2026-11-04T10:00:31+00:00',
    },
    {
      message_id: 'msg_user_32',
      role: 'user',
      content: '[synthetic] filler question 32',
      thinking: null,
      citations: [],
      usage: null,
      resolved_mode: 'sync',
      degradation_reasons: [],
      created_at: '2026-11-04T10:00:32+00:00',
    },
    {
      message_id: 'msg_user_33',
      role: 'user',
      content: '[synthetic] filler question 33',
      thinking: null,
      citations: [],
      usage: null,
      resolved_mode: 'sync',
      degradation_reasons: [],
      created_at: '2026-11-04T10:00:33+00:00',
    },
    {
      message_id: 'msg_user_34',
      role: 'user',
      content: '[synthetic] filler question 34',
      thinking: null,
      citations: [],
      usage: null,
      resolved_mode: 'sync',
      degradation_reasons: [],
      created_at: '2026-11-04T10:00:34+00:00',
    },
    {
      message_id: 'msg_user_35',
      role: 'user',
      content: '[synthetic] filler question 35',
      thinking: null,
      citations: [],
      usage: null,
      resolved_mode: 'sync',
      degradation_reasons: [],
      created_at: '2026-11-04T10:00:35+00:00',
    },
    {
      message_id: 'msg_user_36',
      role: 'user',
      content: '[synthetic] filler question 36',
      thinking: null,
      citations: [],
      usage: null,
      resolved_mode: 'sync',
      degradation_reasons: [],
      created_at: '2026-11-04T10:00:36+00:00',
    },
    {
      message_id: 'msg_user_37',
      role: 'user',
      content: '[synthetic] filler question 37',
      thinking: null,
      citations: [],
      usage: null,
      resolved_mode: 'sync',
      degradation_reasons: [],
      created_at: '2026-11-04T10:00:37+00:00',
    },
    {
      message_id: 'msg_user_38',
      role: 'user',
      content: '[synthetic] filler question 38',
      thinking: null,
      citations: [],
      usage: null,
      resolved_mode: 'sync',
      degradation_reasons: [],
      created_at: '2026-11-04T10:00:38+00:00',
    },
    {
      message_id: 'msg_user_39',
      role: 'user',
      content: '[synthetic] filler question 39',
      thinking: null,
      citations: [],
      usage: null,
      resolved_mode: 'sync',
      degradation_reasons: [],
      created_at: '2026-11-04T10:00:39+00:00',
    },
    {
      message_id: 'msg_user_40',
      role: 'user',
      content: '[synthetic] filler question 40',
      thinking: null,
      citations: [],
      usage: null,
      resolved_mode: 'sync',
      degradation_reasons: [],
      created_at: '2026-11-04T10:00:40+00:00',
    },
    {
      message_id: 'msg_user_41',
      role: 'user',
      content: '[synthetic] filler question 41',
      thinking: null,
      citations: [],
      usage: null,
      resolved_mode: 'sync',
      degradation_reasons: [],
      created_at: '2026-11-04T10:00:41+00:00',
    },
    {
      message_id: 'msg_user_42',
      role: 'user',
      content: '[synthetic] filler question 42',
      thinking: null,
      citations: [],
      usage: null,
      resolved_mode: 'sync',
      degradation_reasons: [],
      created_at: '2026-11-04T10:00:42+00:00',
    },
    {
      message_id: 'msg_user_43',
      role: 'user',
      content: '[synthetic] filler question 43',
      thinking: null,
      citations: [],
      usage: null,
      resolved_mode: 'sync',
      degradation_reasons: [],
      created_at: '2026-11-04T10:00:43+00:00',
    },
    {
      message_id: 'msg_user_44',
      role: 'user',
      content: '[synthetic] filler question 44',
      thinking: null,
      citations: [],
      usage: null,
      resolved_mode: 'sync',
      degradation_reasons: [],
      created_at: '2026-11-04T10:00:44+00:00',
    },
    {
      message_id: 'msg_user_45',
      role: 'user',
      content: '[synthetic] filler question 45',
      thinking: null,
      citations: [],
      usage: null,
      resolved_mode: 'sync',
      degradation_reasons: [],
      created_at: '2026-11-04T10:00:45+00:00',
    },
    {
      message_id: 'msg_user_46',
      role: 'user',
      content: '[synthetic] filler question 46',
      thinking: null,
      citations: [],
      usage: null,
      resolved_mode: 'sync',
      degradation_reasons: [],
      created_at: '2026-11-04T10:00:46+00:00',
    },
    {
      message_id: 'msg_user_47',
      role: 'user',
      content: '[synthetic] filler question 47',
      thinking: null,
      citations: [],
      usage: null,
      resolved_mode: 'sync',
      degradation_reasons: [],
      created_at: '2026-11-04T10:00:47+00:00',
    },
    {
      message_id: 'msg_user_48',
      role: 'user',
      content: '[synthetic] filler question 48',
      thinking: null,
      citations: [],
      usage: null,
      resolved_mode: 'sync',
      degradation_reasons: [],
      created_at: '2026-11-04T10:00:48+00:00',
    },
    {
      message_id: 'msg_user_49',
      role: 'user',
      content: '[synthetic] filler question 49',
      thinking: null,
      citations: [],
      usage: null,
      resolved_mode: 'sync',
      degradation_reasons: [],
      created_at: '2026-11-04T10:00:49+00:00',
    },
    {
      message_id: 'msg_user_50',
      role: 'user',
      content: '[synthetic] filler question 50',
      thinking: null,
      citations: [],
      usage: null,
      resolved_mode: 'sync',
      degradation_reasons: [],
      created_at: '2026-11-04T10:00:50+00:00',
    },
    {
      message_id: 'msg_user_51',
      role: 'user',
      content: '[synthetic] filler question 51',
      thinking: null,
      citations: [],
      usage: null,
      resolved_mode: 'sync',
      degradation_reasons: [],
      created_at: '2026-11-04T10:00:51+00:00',
    },
    {
      message_id: 'msg_user_52',
      role: 'user',
      content: '[synthetic] filler question 52',
      thinking: null,
      citations: [],
      usage: null,
      resolved_mode: 'sync',
      degradation_reasons: [],
      created_at: '2026-11-04T10:00:52+00:00',
    },
    {
      message_id: 'msg_user_53',
      role: 'user',
      content: '[synthetic] filler question 53',
      thinking: null,
      citations: [],
      usage: null,
      resolved_mode: 'sync',
      degradation_reasons: [],
      created_at: '2026-11-04T10:00:53+00:00',
    },
    {
      message_id: 'msg_user_54',
      role: 'user',
      content: '[synthetic] filler question 54',
      thinking: null,
      citations: [],
      usage: null,
      resolved_mode: 'sync',
      degradation_reasons: [],
      created_at: '2026-11-04T10:00:54+00:00',
    },
    {
      message_id: 'msg_user_55',
      role: 'user',
      content: '[synthetic] filler question 55',
      thinking: null,
      citations: [],
      usage: null,
      resolved_mode: 'sync',
      degradation_reasons: [],
      created_at: '2026-11-04T10:00:55+00:00',
    },
    {
      message_id: 'msg_user_56',
      role: 'user',
      content: '[synthetic] filler question 56',
      thinking: null,
      citations: [],
      usage: null,
      resolved_mode: 'sync',
      degradation_reasons: [],
      created_at: '2026-11-04T10:00:56+00:00',
    },
    {
      message_id: 'msg_user_57',
      role: 'user',
      content: '[synthetic] filler question 57',
      thinking: null,
      citations: [],
      usage: null,
      resolved_mode: 'sync',
      degradation_reasons: [],
      created_at: '2026-11-04T10:00:57+00:00',
    },
    {
      message_id: 'msg_user_58',
      role: 'user',
      content: '[synthetic] filler question 58',
      thinking: null,
      citations: [],
      usage: null,
      resolved_mode: 'sync',
      degradation_reasons: [],
      created_at: '2026-11-04T10:00:58+00:00',
    },
    {
      message_id: 'msg_user_59',
      role: 'user',
      content: '[synthetic] filler question 59',
      thinking: null,
      citations: [],
      usage: null,
      resolved_mode: 'sync',
      degradation_reasons: [],
      created_at: '2026-11-04T10:00:59+00:00',
    },
    {
      message_id: 'msg_tail',
      role: 'assistant',
      content: CHAT_TAIL_CONTENT,
      thinking: null,
      citations: [],
      usage: null,
      resolved_mode: 'sync',
      degradation_reasons: [],
      created_at: '2026-11-04T10:12:00+00:00',
    },
  ],
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

const INSIGHTS = [
  {
    insight_id: 'ins_legacy_1',
    project_id: PROJECT.id,
    title: '[synthetic] Legacy insight',
    content: '[synthetic] Legacy insight content kept for read-back regression.',
    insight_type: 'manual',
    model_id: null,
    created_at: '2026-10-20T08:00:00+00:00',
    updated_at: '2026-10-20T08:00:00+00:00',
    citations: [],
  },
]

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
  NOTE_D1_CONTENT,
  NOTE_SAFETY_CONTENT,
  NOTE_LEGACY_CONTENT,
  SOURCE_DEFS,
  SOURCE_JOINED_TEXT,
  SOURCE_JOINED_HASH,
  SOURCES,
  INSIGHTS,
  NOTE_CITE_CONTENT,
  SOURCE_DETAILS,
  GLOBAL_SESSION,
  SESSIONS,
  GLOBAL_DETAIL,
  MODELS,
  MODELS_EDITOR_ON,
  MODELS_EDITOR_OFF,
  MODELS_EXISTING_OFF,
  MODELS_WRITING_ON,
  MODELS_WRITING_OFF,
  MODELS_EXPORT_ON,
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
