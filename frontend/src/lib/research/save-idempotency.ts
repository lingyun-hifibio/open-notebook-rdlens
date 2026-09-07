/**
 * RWV2-23（Issue #43，设计决策 D3）：Save-as-Insight/Note 的确定性 Idempotency-Key。
 *
 * RWV2-22（RDLens `deterministic_save_id`）服务端按
 * (project_id, user_id, idempotency_key, origin_kind, origin_id,
 * destination_kind) 派生目标 artifact id。因此「同一逻辑保存」必须恒用同一
 * key，使相同保存跨刷新/重开结果/多标签重放时服务端返回**原 artifact**
 * （200），从客户端杜绝重复 Insight/Note——UI 永不“旋转”本 key。
 *
 * 域字符串包含 project/origin_kind/origin_id/destination_kind；
 * **不含 title**：当前动作不发自定义标题。若未来引入标题编辑，必须把标题
 * 纳入幂等域或改用随机键，否则同键重放会收敛到首版标题（防回归测试锁定）。
 *
 * 输出 `sv-` + 16 位 hex（两个独立种子各 8 位，64-bit 域摘要）：总长 19 <= 后端
 * 128 限制，且无 <32 控制字符（RDLens `require_idempotency_key`：1..128 字符、
 * 拒控制字符）。纯同步、确定性、无随机源。
 */
import type {
  ResearchSaveDestinationKind,
  ResearchSaveOriginKind,
} from '../types/research'

const KEY_PREFIX = 'sv-'
const SEED_A = 0x9e3779b9
const SEED_B = 0x85ebca6b

/** cyrb53：确定性字符串哈希（返回 [0, 2^53)）。 */
function cyrb53(str: string, seed = 0): number {
  let h1 = 0xdeadbeef ^ seed
  let h2 = 0x41c6ce57 ^ seed
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 =
    Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^
    Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 =
    Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^
    Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return 4294967296 * (2097151 & h2) + (h1 >>> 0)
}

function hex32(value: number): string {
  return (value >>> 0).toString(16).padStart(8, '0')
}

/**
 * 生成保存动作的确定性 Idempotency-Key。
 * 相同 (projectId, originKind, originId, destinationKind) 恒返回同一 key。
 */
export function saveIdempotencyKey(
  projectId: string,
  originKind: ResearchSaveOriginKind,
  originId: string,
  destinationKind: ResearchSaveDestinationKind,
): string {
  const domain = [projectId, originKind, originId, destinationKind].join(':')
  const a = cyrb53(domain, SEED_A) >>> 0
  const b = cyrb53(domain, SEED_B) >>> 0
  return `${KEY_PREFIX}${hex32(a)}${hex32(b)}`
}
