import { describe, expect, it } from 'vitest'
import { decodeResearchProjectId } from './project'

// UI-03 Red：Research 项目上下文（契约 v0 §4.1/§12.2）——Token 消息
// 不含 project_id，iframe 从 JWT payload 读取 claim（不做签名校验，
// 信任来自服务端签发）；无效载荷 fail-closed 返回 null。

// 手工构造 base64url JWT payload
function b64url(input: string): string {
  return Buffer.from(input).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_')
}

function tokenWith(payload: string): string {
  return `header.${b64url(payload)}.signature`
}

describe('decodeResearchProjectId', () => {
  it('从合法 JWT payload 提取 project_id', () => {
    const token = tokenWith(JSON.stringify({ sub: 'u1', project_id: 'proj_42', aud: 'research-workspace' }))
    expect(decodeResearchProjectId(token)).toBe('proj_42')
  })

  it('payload 缺 project_id 返回 null', () => {
    const token = tokenWith(JSON.stringify({ sub: 'u1', aud: 'research-workspace' }))
    expect(decodeResearchProjectId(token)).toBeNull()
  })

  it('非字符串 project_id 返回 null', () => {
    const token = tokenWith(JSON.stringify({ project_id: 42 }))
    expect(decodeResearchProjectId(token)).toBeNull()
  })

  it('非法 JWT（段数不足/坏 base64/坏 JSON）fail-closed 返回 null', () => {
    expect(decodeResearchProjectId('not-a-jwt')).toBeNull()
    expect(decodeResearchProjectId('a.b.c')).toBeNull()
    expect(decodeResearchProjectId('a.!!!.c')).toBeNull()
    expect(decodeResearchProjectId('')).toBeNull()
    expect(decodeResearchProjectId(null as unknown as string)).toBeNull()
  })

  it('空 project_id 字符串返回 null', () => {
    const token = tokenWith(JSON.stringify({ project_id: '' }))
    expect(decodeResearchProjectId(token)).toBeNull()
  })
})
