/**
 * Issue #1191 PR-B（W3-G2）：单份 Markdown 导出前端纯逻辑。
 *
 * 权威依据：
 * - issue #1191 `## 期望交付` 第 2 条（复用 #1050 已冻结后端 API）；
 * - host `src/rdlens/research/issue585/export_contract.py`（请求体闭合三键、
 *   `export_id`/文件字节规则）与 `note_export_store.py#export_record_payload`
 *   （响应固定键 + 相对 `download_url`）；
 * - host `router.py` 的 `POST .../notes/{note_id}/exports` /
 *   `GET .../export/{export_id}/file`（201 新建 / 200 幂等重放；错误包络）。
 *
 * 本模块**不依赖 React**：幂等键签名、响应校验、文件名规则、下载触发与
 * 失败归一都在这里，供 `use-note-export.ts` 与单测直接消费。网络传输在
 * `./note-client.ts`（复用既有 `apiClient`/`noteHeaders()`/`noteUrl()`）。
 *
 * 纪律（计划 §2.5-9..12）：
 * - 请求体恰三键 `{revision, snapshot_hash, format:'markdown'}`；
 * - `download_url` 原样使用，绝不自行拼路径；畸形响应不得冒充成功；
 * - 下载只走 blob + `<a download>`，绝不 `window.open`/`target=_blank`；
 * - 幂等键绑定 `note_id+revision+snapshot_hash+format`（内存内复用，不落盘）。
 */

import {
  normalizeNoteExportApiError,
  type NoteD2ExportResponseEnvelope,
  type NoteExportFileBlob,
} from './note-client'
import type { NoteErrorCode, NoteLeaveBlockReason, ResearchNoteD2 } from './types'

/** 唯一支持的导出格式（本期仅 Markdown，多格式不在范围）。 */
export const NOTE_EXPORT_FORMAT = 'markdown' as const

/** `export_id` 形状（host `EXPORT_ID_PATTERN`：`nex_` + 32 位小写十六进制）。 */
export const NOTE_EXPORT_ID_PATTERN = /^nex_[0-9a-f]{32}$/

/** 文件名 stem 上限（与服务端 `FILENAME_MAX_CHARS` 同量级；另加 `.md`）。 */
export const NOTE_EXPORT_MAX_FILENAME_STEM_CHARS = 80

/** 本地回退文件名前缀（空标题：`note-<note_id>.md`）。 */
export const NOTE_EXPORT_FALLBACK_PREFIX = 'note-'

const RESEARCH_API_PROJECTS_PREFIX = '/v1/research/projects'

// ── 请求体 / 幂等键签名 ─────────────────────────────────────────────────

/** 一次导出所绑定的服务端版本（读完 flush 后的 state.note 才构造）。 */
export interface NoteExportSignature {
  projectId: string
  noteId: string
  revision: number
  snapshotHash: string
  format: typeof NOTE_EXPORT_FORMAT
}

/** `POST .../exports` 请求体（契约闭合三键）。 */
export interface NoteExportRequestBody {
  revision: number
  snapshot_hash: string
  format: typeof NOTE_EXPORT_FORMAT
}

/** 闭合三键请求体（字段顺序无关；不附加任何其它键）。 */
export function buildNoteExportBody(signature: NoteExportSignature): NoteExportRequestBody {
  return {
    revision: signature.revision,
    snapshot_hash: signature.snapshotHash,
    format: NOTE_EXPORT_FORMAT,
  }
}

/** 幂等键签名（绑定 note_id+revision+snapshot_hash+format；含 project 隔离）。 */
export function noteExportSignatureKey(signature: NoteExportSignature): string {
  return [
    signature.projectId,
    signature.noteId,
    String(signature.revision),
    signature.snapshotHash,
    signature.format,
  ].join('\u0000')
}

/** 新幂等键（服务端要求 1..128 非控制字符；只存在于内存，不落盘）。 */
export function newNoteExportIdempotencyKey(): string {
  const cryptoObject =
    typeof globalThis === 'object' ? (globalThis as { crypto?: Crypto }).crypto : undefined
  if (cryptoObject && typeof cryptoObject.randomUUID === 'function') {
    return `nexk-${cryptoObject.randomUUID()}`
  }
  return `nexk-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`
}

/** 幂等键缓存（组件生命周期内复用；同签名重试/再次点击都复用同一键）。 */
export interface NoteExportKeyStore {
  keyFor(signature: NoteExportSignature): string
  /** 丢弃该签名的键：仅用于「用户在冲突后显式重新导出」/版本签名变化。 */
  invalidate(signature: NoteExportSignature): void
}

export function createNoteExportKeyStore(
  options: { createKey?: (() => string) | undefined } = {},
): NoteExportKeyStore {
  const keys = new Map<string, string>()
  const createKey = options.createKey ?? newNoteExportIdempotencyKey
  return {
    keyFor(signature) {
      const cacheKey = noteExportSignatureKey(signature)
      const existing = keys.get(cacheKey)
      if (existing !== undefined) return existing
      const created = createKey()
      keys.set(cacheKey, created)
      return created
    },
    invalidate(signature) {
      keys.delete(noteExportSignatureKey(signature))
    },
  }
}

// ── 可用性（可见性闸的可导出快照） ─────────────────────────────────────

/** 可从当前投影导出的版本快照（d2-v1 + revision + snapshot_hash）。 */
export interface NoteExportNoteSnapshot {
  projectId: string
  noteId: string
  revision: number
  snapshotHash: string
}

/**
 * 当前 Note 是否具备导出版本（fail-closed）。
 *
 * 旧未保护行（`edit_schema=null`）没有保存版本可绑定 → null；缺 revision/
 * snapshot_hash 的投影同样 null（绝不导出“当前草稿”冒充已保存版本）。
 */
export function exportableNoteSnapshot(
  note: ResearchNoteD2 | null | undefined,
): NoteExportNoteSnapshot | null {
  if (!note) return null
  if (note.edit_schema !== 'd2-v1') return null
  if (typeof note.note_id !== 'string' || note.note_id.length === 0) return null
  if (typeof note.project_id !== 'string' || note.project_id.length === 0) return null
  if (typeof note.revision !== 'number' || !Number.isInteger(note.revision) || note.revision < 1) {
    return null
  }
  if (typeof note.snapshot_hash !== 'string' || note.snapshot_hash.length === 0) return null
  return {
    projectId: note.project_id,
    noteId: note.note_id,
    revision: note.revision,
    snapshotHash: note.snapshot_hash,
  }
}

// ── 响应校验（畸形响应绝不冒充成功） ───────────────────────────────────

/** 冻结的相对下载入口前缀：`/v1/research/projects/{project}/export/`。 */
export function expectedExportDownloadPrefix(projectId: string): string {
  return `${RESEARCH_API_PROJECTS_PREFIX}/${encodeURIComponent(projectId)}/export/`
}

/** 冻结的导出文件下载路径：`.../export/{export_id}/file`。 */
export function expectedExportDownloadPath(projectId: string, exportId: string): string {
  return `${expectedExportDownloadPrefix(projectId)}${exportId}/file`
}

/** 已校验的导出记录（只含展示/下载所需字段）。 */
export interface NoteExportCreated {
  exportId: string
  noteId: string
  noteRevision: number
  downloadUrl: string
  replayed: boolean
}

export type NoteExportParseResult =
  | { ok: true; created: NoteExportCreated }
  | { ok: false; failure: NoteExportFailure }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 校验 `POST .../exports` 响应：`export_id` 必须匹配 `^nex_`、`download_url`
 * 必须是**指向本次导出**的相对路径（冻结前缀 + `export_id/file`，可带查询串）；
 * 其余任何形状都按「结果未知」失败，绝不拿去下载。
 */
export function parseNoteExportResponse(
  raw: NoteD2ExportResponseEnvelope,
  expected: { projectId: string; noteId: string; revision: number },
): NoteExportParseResult {
  const invalid: NoteExportParseResult = { ok: false, failure: { kind: 'invalid_response' } }
  if (raw.status !== 200 && raw.status !== 201) return invalid
  if (!isRecord(raw.data)) return invalid
  const data = raw.data

  const exportId = data.export_id
  if (typeof exportId !== 'string' || !NOTE_EXPORT_ID_PATTERN.test(exportId)) return invalid
  if (data.note_id !== expected.noteId) return invalid
  if (data.note_revision !== expected.revision) return invalid
  if (data.format !== NOTE_EXPORT_FORMAT) return invalid

  const downloadUrl = data.download_url
  if (typeof downloadUrl !== 'string' || downloadUrl.length === 0) return invalid
  if (!isRelativeExportDownloadUrl(downloadUrl, expected.projectId)) return invalid
  const prefix = expectedExportDownloadPrefix(expected.projectId)
  if (!downloadUrl.slice(prefix.length).startsWith(`${exportId}/file`)) return invalid

  return {
    ok: true,
    created: {
      exportId,
      noteId: expected.noteId,
      noteRevision: expected.revision,
      downloadUrl,
      replayed: data.replayed === true || raw.status === 200,
    },
  }
}

/** 只接受相对路径（拒绝绝对 URL / 协议相对 URL / 反斜杠变体）。 */
function isRelativeExportDownloadUrl(url: string, projectId: string): boolean {
  if (url.includes('\\')) return false
  if (!url.startsWith(expectedExportDownloadPrefix(projectId))) return false
  return true
}

// ── 文件名（服务端优先，本地按标题回退） ───────────────────────────────

/** 清洗标题为文件名 stem：路径分隔符/控制字符→`_`，压缩空白，去首尾点/空格。 */
export function sanitizeNoteExportFilenameStem(value: string): string {
  const replaced = Array.from(value)
    .map((char) => {
      if (char === '/' || char === '\\') return '_'
      const codePoint = char.codePointAt(0) ?? 0
      // C0/C1 控制字符与 DEL 不得进入文件名。
      if (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)) return '_'
      // Unicode 格式字符（零宽/方向控制等）同样不得进入文件名。
      if (/\p{Cf}/u.test(char)) return '_'
      return char
    })
    .join('')
  const collapsed = replaced.replace(/\s+/g, ' ').trim()
  const trimmed = collapsed.replace(/^[ ._]+/, '').replace(/[ ._]+$/, '')
  return trimmed
    .slice(0, NOTE_EXPORT_MAX_FILENAME_STEM_CHARS)
    .replace(/[ ._]+$/, '')
}

/**
 * 导出文件名：服务端 `Content-Disposition` 可用时优先（清洗后使用），
 * 读不到时按本地标题回退 `<title>.md`；空标题回退 `note-<note_id>.md`。
 *
 * 与本地草稿下载（`note-download.ts` 的 `note-local-draft-*`）严格区分。
 */
export function resolveNoteExportFilename(input: {
  serverFilename?: string | null
  title?: string | null
  noteId: string
}): string {
  const serverFilename = typeof input.serverFilename === 'string' ? input.serverFilename : null
  if (serverFilename !== null && serverFilename.length > 0) {
    const sanitized = sanitizeNoteExportFilenameStem(serverFilename)
    if (sanitized.length > 0) return sanitized
  }
  const title = typeof input.title === 'string' ? input.title : ''
  const stem = sanitizeNoteExportFilenameStem(title)
  if (stem.length > 0) return `${stem}.md`
  const noteStem = sanitizeNoteExportFilenameStem(input.noteId)
  return `${NOTE_EXPORT_FALLBACK_PREFIX}${noteStem.length > 0 ? noteStem : 'unknown'}.md`
}

// ── 下载触发（blob + <a download> + objectURL 回收） ────────────────────

export type NoteExportDownloader = (blob: Blob, filename: string) => boolean

export interface NoteExportDownloadDeps {
  readonly document?: Document | null
  readonly createObjectURL?: ((blob: Blob) => string) | null
  readonly revokeObjectURL?: ((url: string) => void) | null
  /** 延迟回收 object URL（默认 setTimeout 0；测试可注入同步回收）。 */
  readonly scheduleRevoke?: ((callback: () => void) => void) | null
}

/**
 * 触发浏览器下载（不经 `window.open`/`target=_blank`）；返回是否真正发起。
 *
 * SSR/不支持 Blob 的环境返回 false（调用方按 `download_unavailable` 如实
 * 呈现，绝不宣称导出成功）。
 */
export function triggerNoteExportDownload(
  blob: Blob,
  filename: string,
  deps: NoteExportDownloadDeps = {},
): boolean {
  // 显式注入（含 null）优先于浏览器全局：null 表示「该环境不可用」。
  const doc =
    'document' in deps
      ? (deps.document ?? null)
      : typeof document !== 'undefined'
        ? document
        : null
  if (!doc) return false
  const globalUrl = typeof URL !== 'undefined' ? URL : null
  const createObjectURL =
    'createObjectURL' in deps
      ? (deps.createObjectURL ?? null)
      : (globalUrl?.createObjectURL ?? null)
  const revokeObjectURL =
    'revokeObjectURL' in deps
      ? (deps.revokeObjectURL ?? null)
      : (globalUrl?.revokeObjectURL ?? null)
  if (typeof createObjectURL !== 'function') return false

  let objectUrl: string
  try {
    objectUrl = createObjectURL(blob)
  } catch {
    return false
  }

  try {
    const anchor = doc.createElement('a')
    anchor.href = objectUrl
    anchor.download = filename
    anchor.rel = 'noopener'
    anchor.style.display = 'none'
    const parent = doc.body ?? doc.documentElement
    parent?.appendChild(anchor)
    anchor.click()
    parent?.removeChild(anchor)
    const schedule =
      'scheduleRevoke' in deps
        ? (deps.scheduleRevoke ?? ((callback: () => void) => callback()))
        : (callback: () => void) => {
            if (typeof setTimeout === 'function') setTimeout(callback, 0)
            else callback()
          }
    if (typeof revokeObjectURL === 'function') schedule(() => revokeObjectURL(objectUrl))
    return true
  } catch {
    if (typeof revokeObjectURL === 'function') {
      try {
        revokeObjectURL(objectUrl)
      } catch {
        // 回收失败不影响已发起的下载（或由浏览器回收）。
      }
    }
    return false
  }
}

// ── 失败模型（稳定码；组件只映射文案，不展示原始响应体） ────────────────

/** flush 被离开保护阻断（复用既有 leaveReasonLabelKey 文案）。 */
export interface NoteExportBlockedFailure {
  kind: 'blocked'
  reason: NoteLeaveBlockReason
}

/** 服务端契约错误（403/404/409×3/422/503 等；只保留稳定码与 request_id）。 */
export interface NoteExportApiFailure {
  kind: 'api'
  code: NoteErrorCode
  status: number
  requestId: string | null
  retryable: boolean
}

/** 畸形响应（结果未知，不冒充成功；同幂等键重试安全）。 */
export interface NoteExportInvalidResponseFailure {
  kind: 'invalid_response'
}

/** 浏览器无法发起下载（导出记录可能已创建；同幂等键重试可再次取回）。 */
export interface NoteExportDownloadUnavailableFailure {
  kind: 'download_unavailable'
}

/** flush 之后版本已不可导出（旧格式/缺 revision/文档被替换）。 */
export interface NoteExportNotExportableFailure {
  kind: 'not_exportable'
  reason: NoteErrorCode
}

export type NoteExportFailure =
  | NoteExportBlockedFailure
  | NoteExportApiFailure
  | NoteExportInvalidResponseFailure
  | NoteExportDownloadUnavailableFailure
  | NoteExportNotExportableFailure

export function noteExportFailureFromError(
  error: unknown,
  operation: 'create' | 'download',
): NoteExportApiFailure {
  const normalized = normalizeNoteExportApiError(error, operation)
  return {
    kind: 'api',
    code: normalized.code,
    status: normalized.status,
    requestId: normalized.requestId ?? null,
    retryable: normalized.retryable,
  }
}

// ── 流程编排 ────────────────────────────────────────────────────────────

/** 导出传输（可注入，便于单测；生产实现见 `use-note-export.ts`）。 */
export interface NoteExportTransport {
  requestExport(input: {
    projectId: string
    noteId: string
    body: NoteExportRequestBody
    idempotencyKey: string
  }): Promise<NoteD2ExportResponseEnvelope>
  fetchExportFile(downloadUrl: string): Promise<NoteExportFileBlob>
}

export type NoteExportOutcome =
  | { ok: true; exportId: string; filename: string; replayed: boolean }
  | { ok: false; failure: NoteExportFailure }

export interface NoteExportRunInput {
  /** flush 之后重新读取的已保存版本（绝不使用 flush 前的旧 revision）。 */
  signature: NoteExportSignature
  /** 本地回退文件名用的标题（服务端 Content-Disposition 可用时优先）。 */
  title: string | null
  keyStore: NoteExportKeyStore
  client: NoteExportTransport
  /** 下载触发（默认 blob + `<a download>`）；返回 false 视为无法下载。 */
  download?: NoteExportDownloader
}

/**
 * 执行一次单份 Markdown 导出：POST 冻结三键 → 校验响应 → 用响应
 * `download_url` 原样 GET → blob 下载。任何一步失败都返回稳定失败码，
 * 绝不把 409/畸形响应当成功。
 */
export async function runNoteExport(input: NoteExportRunInput): Promise<NoteExportOutcome> {
  const { signature, keyStore, client } = input
  const idempotencyKey = keyStore.keyFor(signature)
  const expected = {
    projectId: signature.projectId,
    noteId: signature.noteId,
    revision: signature.revision,
  }

  let envelope: NoteD2ExportResponseEnvelope
  try {
    envelope = await client.requestExport({
      projectId: signature.projectId,
      noteId: signature.noteId,
      body: buildNoteExportBody(signature),
      idempotencyKey,
    })
  } catch (error) {
    const failure = noteExportFailureFromError(error, 'create')
    // 同幂等键已绑定别的请求摘要：换新键只能由用户「显式重新导出」触发。
    if (failure.code === 'export_request_conflict') {
      keyStore.invalidate(signature)
    }
    return { ok: false, failure }
  }

  const parsed = parseNoteExportResponse(envelope, expected)
  if (!parsed.ok) return parsed

  let file: NoteExportFileBlob
  try {
    file = await client.fetchExportFile(parsed.created.downloadUrl)
  } catch (error) {
    return { ok: false, failure: noteExportFailureFromError(error, 'download') }
  }

  const filename = resolveNoteExportFilename({
    serverFilename: file.filename,
    title: input.title,
    noteId: signature.noteId,
  })
  const download = input.download ?? triggerNoteExportDownload
  if (!download(file.blob, filename)) {
    return { ok: false, failure: { kind: 'download_unavailable' } }
  }
  return {
    ok: true,
    exportId: parsed.created.exportId,
    filename,
    replayed: parsed.created.replayed,
  }
}
