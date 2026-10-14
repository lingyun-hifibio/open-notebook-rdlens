/**
 * Issue #601 PR5（D-01/D-14）：`resolved_scope` 投影消费——**存在才消费，
 * 严格校验**；缺失显示"服务端未返回范围详情"，畸形按不可用处理并记录
 * `c05_scope_projection_invalid`；不展示半真数据。
 *
 * 校验对应 fixtures `resolved_scope` schema（v8 §2.1）：
 * - `contains_document_body === false`；
 * - `resolved_source_refs` 为 `{document_id: string, document_version: string}[]`；
 * - `warnings` 成员形状合法（`{code, message, documents?}`）；
 * - `contract_version === 'c05-v1'`。
 */

export interface C05DocumentRef {
  document_id: string
  document_version: string
}

export interface C05ScopeWarning {
  code: string
  message: string
  /** `{document_id, used_version, skipped_version}`；`used_version` 可为空串（不虚构被回退版本） */
  documents?: Array<{ document_id: string; used_version: string; skipped_version: string }>
}

export interface C05ResolvedScope {
  mode: C05ScopeMode
  contract_version: 'c05-v1'
  resolved_source_refs: C05DocumentRef[]
  note_ids: string[]
  single_source_id: string | null
  missing_source_ids: string[]
  includes_exact_versions: boolean
  contains_document_body: false
  warnings: C05ScopeWarning[]
}

export type C05ProjectionResult =
  | { kind: 'present'; scope: C05ResolvedScope }
  /** 响应未携带投影（fresh/202 主路径现状，D-01）——不是错误，不猜测 */
  | { kind: 'absent' }
  /** 携带但校验失败——按不可用处理并记录 */
  | { kind: 'invalid'; reason: string }

import type { C05ScopeMode } from './c05-contract'

function isStringRecordArray(value: unknown): value is Array<Record<string, unknown>> {
  return Array.isArray(value)
    && value.every(item => typeof item === 'object' && item !== null && !Array.isArray(item))
}

export function parseResolvedScope(value: unknown): C05ProjectionResult {
  if (value === undefined) return { kind: 'absent' }
  if (value === null) return { kind: 'absent' }
  if (typeof value !== 'object' || Array.isArray(value)) {
    return { kind: 'invalid', reason: 'c05_scope_projection_invalid' }
  }
  const raw = value as Record<string, unknown>
  if (raw.contract_version !== 'c05-v1') {
    return { kind: 'invalid', reason: 'c05_scope_projection_invalid' }
  }
  if (raw.contains_document_body !== false) {
    // 契约硬约束：范围对象不含正文（ADR §3.4）
    return { kind: 'invalid', reason: 'c05_scope_projection_invalid' }
  }
  const mode = raw.mode
  if (mode !== 'all' && mode !== 'selected' && mode !== 'single') {
    return { kind: 'invalid', reason: 'c05_scope_projection_invalid' }
  }
  if (!isStringRecordArray(raw.resolved_source_refs)) {
    return { kind: 'invalid', reason: 'c05_scope_projection_invalid' }
  }
  const refs: C05DocumentRef[] = []
  for (const item of raw.resolved_source_refs as Array<Record<string, unknown>>) {
    if (typeof item.document_id !== 'string' || typeof item.document_version !== 'string') {
      return { kind: 'invalid', reason: 'c05_scope_projection_invalid' }
    }
    refs.push({ document_id: item.document_id, document_version: item.document_version })
  }
  if (!isStringRecordArray(raw.warnings ?? [])) {
    return { kind: 'invalid', reason: 'c05_scope_projection_invalid' }
  }
  const warnings: C05ScopeWarning[] = []
  for (const item of (raw.warnings ?? []) as Array<Record<string, unknown>>) {
    if (typeof item.code !== 'string' || typeof item.message !== 'string') {
      return { kind: 'invalid', reason: 'c05_scope_projection_invalid' }
    }
    let documents: C05ScopeWarning['documents'] = undefined
    if (item.documents !== undefined) {
      if (!isStringRecordArray(item.documents)) {
        return { kind: 'invalid', reason: 'c05_scope_projection_invalid' }
      }
      // 评审 MEDIUM-9：成员字段必须**校验**而不是 `String(...)` 强转——
      // `documents:[{}]` 强转后变成 used_version='' 的"被排除文档"，把畸形
      // 投影当成有效数据展示（本模块的契约是"严格校验，畸形按不可用"）。
      const mapped: NonNullable<C05ScopeWarning['documents']> = []
      for (const doc of item.documents as Array<Record<string, unknown>>) {
        if (typeof doc.document_id !== 'string') {
          return { kind: 'invalid', reason: 'c05_scope_projection_invalid' }
        }
        // `used_version` 允许空串（= 无可读版本，不虚构被回退版本）；
        // `skipped_version` 缺失时按空串处理（历史载荷），但存在且非字符串即畸形
        if (doc.used_version !== undefined && typeof doc.used_version !== 'string') {
          return { kind: 'invalid', reason: 'c05_scope_projection_invalid' }
        }
        if (doc.skipped_version !== undefined && typeof doc.skipped_version !== 'string') {
          return { kind: 'invalid', reason: 'c05_scope_projection_invalid' }
        }
        mapped.push({
          document_id: doc.document_id,
          used_version: typeof doc.used_version === 'string' ? doc.used_version : '',
          skipped_version: typeof doc.skipped_version === 'string' ? doc.skipped_version : '',
        })
      }
      documents = mapped
    }
    warnings.push({ code: item.code, message: item.message, documents })
  }
  const noteIds = Array.isArray(raw.note_ids)
    ? (raw.note_ids as unknown[]).filter((v): v is string => typeof v === 'string')
    : []
  const single = typeof raw.single_source_id === 'string' ? raw.single_source_id : null
  const missing = Array.isArray(raw.missing_source_ids)
    ? (raw.missing_source_ids as unknown[]).filter((v): v is string => typeof v === 'string')
    : []
  return {
    kind: 'present',
    scope: {
      mode,
      contract_version: 'c05-v1',
      resolved_source_refs: refs,
      note_ids: noteIds,
      single_source_id: single,
      missing_source_ids: missing,
      includes_exact_versions: raw.includes_exact_versions === true,
      contains_document_body: false,
      warnings,
    },
  }
}

/** 从 200/202 JSON 响应体提取投影（`scope_contract_version` + `resolved_scope`） */
export function extractScopeProjection(body: unknown): C05ProjectionResult {
  if (body === null || typeof body !== 'object') return { kind: 'absent' }
  const raw = body as Record<string, unknown>
  if (raw.scope_contract_version === undefined && raw.resolved_scope === undefined) {
    return { kind: 'absent' }
  }
  if (raw.scope_contract_version !== 'c05-v1') {
    return { kind: 'invalid', reason: 'c05_scope_projection_invalid' }
  }
  return parseResolvedScope(raw.resolved_scope)
}
