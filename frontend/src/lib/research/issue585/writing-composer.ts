/**
 * Issue #1048 PR7（D2-B4）：既有 session editor CAS → 写作 composer 保存适配。
 *
 * 方案 §6.1.2：发送前通过既有 session editor CAS 保存 query/draft_token，等待
 * ACK 后**再从已保存 composer** 读取 editor_revision/editor_intent_hash。
 *
 * 本适配只消费既有 `EditorController` 的公开 API（不新建保存通道、不改
 * editor-machine）；失败以闭合结果返回，绝不回退读取 Note revision 或旧
 * schema1 哈希。
 */

import type { EditorController } from '@/lib/research/editor-machine'
import type { ComposerSaveFailureCode, ComposerSaveResult } from './use-writing-compose'

const DRAFT_TOKEN_PATTERN = /^[A-Za-z0-9_-]{1,128}$/
const HEX64_PATTERN = /^[0-9a-f]{64}$/

function failureFromReadiness(reason: string): ComposerSaveFailureCode {
  switch (reason) {
    case 'not_loaded':
      return 'not_loaded'
    case 'dirty':
      return 'dirty'
    case 'saving':
      return 'saving'
    case 'conflict':
      return 'conflict'
    case 'blocked':
      return 'blocked'
    case 'readonly':
      return 'readonly'
    case 'invalidated':
      return 'invalidated'
    case 'no_transport':
      return 'no_transport'
    case 'consumed':
      return 'consumed'
    case 'not_ready':
      return 'not_ready'
    default:
      return 'unknown'
  }
}

/**
 * 保存写作 query 到会话 composer 并等待 ACK，返回**已保存 composer** 身份。
 *
 * 顺序固定：setDraftText(query) → flush('submit') → 等 ACK → 重新读取
 * snapshot 的 revision/intentHash/draftToken。ACK 后如果本地文本已前进
 * （dirty）或不是本次 query，返回失败——绝不把旧/别的 composer 身份用于写作。
 */
export async function saveWritingComposer(
  controller: EditorController | null,
  query: string,
): Promise<ComposerSaveResult> {
  if (controller === null) return { ok: false, code: 'not_ready' }
  const readiness = controller.canSubmit()
  if (
    !readiness.allowed &&
    readiness.reason !== null &&
    readiness.reason !== 'dirty' &&
    readiness.reason !== 'saving'
  ) {
    return { ok: false, code: failureFromReadiness(readiness.reason) }
  }
  controller.setDraftText(query)
  const outcome = await controller.flush('submit')
  if (outcome !== 'saved') {
    if (outcome === 'conflict') return { ok: false, code: 'conflict' }
    if (outcome === 'blocked') return { ok: false, code: 'blocked' }
    if (outcome === 'readonly') return { ok: false, code: 'readonly' }
    if (outcome === 'invalid') return { ok: false, code: 'invalid' }
    return { ok: false, code: 'failed' }
  }
  const snapshot = controller.getSnapshot()
  if (snapshot.draftText !== query || snapshot.dirty) {
    return { ok: false, code: 'failed' }
  }
  if (
    !Number.isInteger(snapshot.revision) ||
    snapshot.revision < 0 ||
    snapshot.intentHash === null ||
    !HEX64_PATTERN.test(snapshot.intentHash) ||
    !DRAFT_TOKEN_PATTERN.test(snapshot.draftToken)
  ) {
    return { ok: false, code: 'failed' }
  }
  return {
    ok: true,
    revision: snapshot.revision,
    intentHash: snapshot.intentHash,
    draftToken: snapshot.draftToken,
  }
}
