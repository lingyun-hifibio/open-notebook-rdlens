/**
 * Issue #1046 PR4（D2-B2）：本地草稿 Markdown 下载（用户取回入口）。
 *
 * 权威依据：方案 v4 §4.4 ——「下载本地草稿是用户取回入口，不冒充已保存
 * §7 版本导出」；删除/受限/冲突/未知结果时都必须能用它取回正文。
 *
 * 设计要点：
 * - 文件名带 `note-local-draft-` 前缀，并固定加一行 HTML 注释标记
 *   “本地编辑草稿、非服务端已保存导出”；
 * - 正文**逐字节保留**（不 strip、不做换行/Unicode 归一化）；
 * - DOM 操作经依赖注入，纯函数部分（文件名/内容）可在 jsdom/Node 断言。
 */

/** 本地草稿文件前缀（与服务端 §7 导出文件名区分）。 */
export const NOTE_LOCAL_DRAFT_FILENAME_PREFIX = 'note-local-draft'

/** 本地草稿标记行（HTML 注释；渲染 Markdown 时不可见）。 */
export const NOTE_LOCAL_DRAFT_MARKER_PREFIX = '<!-- rdlens-local-draft:'

export interface NoteLocalDraftInput {
  title: string
  content: string
  noteId?: string | null
  /** 草稿最近一次本地持久化时间（ISO）；缺省 unknown。 */
  savedAt?: string | null
}

export interface NoteLocalDraftFile {
  filename: string
  contents: string
}

function sanitizeFileSegment(value: string): string {
  return value
    .trim()
    .replace(/[\s\u3000]+/g, '-')
    .replace(/[\\/:*?"<>|#%&{}$!'@+`=]+/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60)
}

/** 文件名：`note-local-draft-<标题 slug>.md`（空标题 → untitled）。 */
export function localDraftFilename(title: string): string {
  const slug = sanitizeFileSegment(title)
  const base = slug.length > 0 ? slug : 'untitled'
  return `${NOTE_LOCAL_DRAFT_FILENAME_PREFIX}-${base}.md`
}

function markerLine(input: NoteLocalDraftInput): string {
  const noteId = typeof input.noteId === 'string' && input.noteId.length > 0 ? input.noteId : 'none'
  const savedAt =
    typeof input.savedAt === 'string' && input.savedAt.length > 0 ? input.savedAt : 'unknown'
  return `${NOTE_LOCAL_DRAFT_MARKER_PREFIX} not-a-saved-export; note_id=${noteId}; saved_at=${savedAt} -->`
}

/** 纯函数：生成下载文件（标记行 + 空行 + 原始正文）。 */
export function buildLocalDraftMarkdown(input: NoteLocalDraftInput): NoteLocalDraftFile {
  return {
    filename: localDraftFilename(input.title),
    contents: `${markerLine(input)}\n\n${input.content}`,
  }
}

export interface LocalDraftDownloadDeps {
  readonly document?: Document | null
  readonly createObjectURL?: ((blob: Blob) => string) | null
  readonly revokeObjectURL?: ((url: string) => void) | null
  /** 延迟回收 object URL（默认 setTimeout 0；测试可注入同步回收）。 */
  readonly scheduleRevoke?: ((callback: () => void) => void) | null
}

/**
 * 触发浏览器下载；返回是否真正发起（SSR/不支持 Blob 的环境返回 false，
 * 调用方仍可通过 `buildLocalDraftMarkdown` 提供文本兜底）。
 */
export function downloadLocalDraftMarkdown(
  input: NoteLocalDraftInput,
  deps: LocalDraftDownloadDeps = {},
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
    const { contents } = buildLocalDraftMarkdown(input)
    objectUrl = createObjectURL(new Blob([contents], { type: 'text/markdown;charset=utf-8' }))
  } catch {
    return false
  }

  try {
    const anchor = doc.createElement('a')
    anchor.href = objectUrl
    anchor.download = localDraftFilename(input.title)
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
        // 回收失败不影响用户取回（下载已发起/或由浏览器回收）
      }
    }
    return false
  }
}
