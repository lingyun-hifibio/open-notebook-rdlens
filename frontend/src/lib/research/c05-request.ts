/**
 * Issue #601 PR5（B3/D-05/D-11）：C-05 请求体**唯一构造函数**。
 *
 * 冻结形状（契约 §3 / plan9 §1 头部 JSON）：
 * `{ source_scope: {mode, source_ids, single_source_id}, note_ids }`。
 *
 * 纪律：
 * - C-05 分支禁止非空顶层 `source_ids`（`rejects_c05_with_non_empty_legacy_scope_fields`）；
 * - `extra="forbid"` 入口（Transformation run、旧 Source Chat）与
 *   `ai_insight`（D-09）**永不**经此构造 `source_scope`；
 * - 不得输出"空 ID 集 + all 意图"的旧契约形状（D-11 fail-closed：`all`
 *   只能走 C-05 分支）。
 */

import type { C05ScopeMode } from './c05-contract'

export interface C05ScopeBody {
  mode: C05ScopeMode
  source_ids: string[]
  single_source_id: string | null
}

export interface C05RequestScope {
  mode: C05ScopeMode
  sourceIds: readonly string[]
  noteIds: readonly string[]
  singleSourceId?: string | null
}

/** 构造 `source_scope` 成员（三形态固定取值） */
export function buildSourceScope(scope: C05RequestScope): C05ScopeBody {
  const singleSourceId = scope.mode === 'single'
    ? (scope.singleSourceId ?? null)
    : null
  switch (scope.mode) {
    case 'all':
      return { mode: 'all', source_ids: [], single_source_id: null }
    case 'single':
      return { mode: 'single', source_ids: [], single_source_id: singleSourceId }
    case 'selected':
      return {
        mode: 'selected',
        source_ids: [...scope.sourceIds],
        single_source_id: null,
      }
  }
}

export interface C05GeneratedRequestBase {
  query: string
  model_id: string
  /** C-05 分支恒 auto 或用户显式档位；不据范围覆盖引擎解析（D-12） */
  mode?: string
  context_level?: string
  response_language?: 'zh' | 'en'
  /** C-05 载荷成员 */
  source_scope: C05ScopeBody
  /** 顶层成员（契约：与 source_scope 同级） */
  note_ids: string[]
  session_id?: string
}

/**
 * 构造生成类请求体（Search / Chat / Coverage 共用形状基础）。
 * 头由调用方经 `c05-contract.c05RequestHeaders()` 附加。
 */
export function buildC05GeneratedRequest(scope: C05RequestScope, base: {
  query: string
  model_id: string
  mode?: string
  context_level?: string
  response_language?: 'zh' | 'en'
  session_id?: string
}): C05GeneratedRequestBase {
  if (scope.mode === 'selected' && scope.sourceIds.length === 0 && scope.noteIds.length === 0) {
    // 防御：空 selected 不应到达这里（面板层已拦）；到达即拒发
    throw new Error('c05_request_empty_selected')
  }
  return {
    query: base.query,
    model_id: base.model_id,
    ...(base.mode !== undefined ? { mode: base.mode } : {}),
    ...(base.context_level !== undefined ? { context_level: base.context_level } : {}),
    ...(base.response_language !== undefined ? { response_language: base.response_language } : {}),
    ...(base.session_id !== undefined ? { session_id: base.session_id } : {}),
    source_scope: buildSourceScope(scope),
    note_ids: [...scope.noteIds],
  }
}

/** 类型守卫：请求体是否为 C-05 形状（测试与调试用，不在派发路径依赖） */
export function isC05RequestBody(body: unknown): boolean {
  return body !== null && typeof body === 'object'
    && 'source_scope' in (body as Record<string, unknown>)
}
