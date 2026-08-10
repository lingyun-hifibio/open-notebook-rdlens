import { describe, expect, it } from 'vitest'
import { decodeResearchClaims, isAdminReadonly } from './claims'

// UI-02 Red：Research Token claims 纯函数解码（设计 §4.2/契约 v0 §4.1，
// REQ-AUTH-02/REQ-SCOPE-04）——iframe 需要从 JWT 载荷读取 project_id 与
// role（owner/admin_readonly）以构建 Gateway 路径与 Owner 写/Admin 只读
// 矩阵；Token 仅内存解码，不验签（签名权威在 Gateway），永不落日志。

// JWT payload base64url 编码辅助（测试专用，不触碰产品代码）
function encodePayload(payload: Record<string, unknown>): string {
  const json = JSON.stringify(payload)
  const b64 = Buffer.from(json, 'utf-8').toString('base64url')
  return `header.${b64}.signature`
}

describe('decodeResearchClaims', () => {
  it('解析合法 token：project_id、role、scopes 全部取出（owner）', () => {
    const token = encodePayload({
      sub: 'user_1',
      project_id: 'proj_abc',
      role: 'owner',
      scopes: ['workspace:read', 'notes:write', 'research:run'],
      aud: 'research-workspace',
      iat: 1754460000,
      nbf: 1754460000,
      exp: 1754460300,
      jti: 'j_1',
    })
    const claims = decodeResearchClaims(token)
    expect(claims).not.toBeNull()
    expect(claims?.projectId).toBe('proj_abc')
    expect(claims?.role).toBe('owner')
    expect(claims?.scopes).toEqual(['workspace:read', 'notes:write', 'research:run'])
  })

  it('解析 admin_readonly 角色', () => {
    const token = encodePayload({
      sub: 'user_2',
      project_id: 'proj_xyz',
      role: 'admin_readonly',
      scopes: ['workspace:read'],
      aud: 'research-workspace',
      iat: 0,
      nbf: 0,
      exp: 300,
      jti: 'j_2',
    })
    const claims = decodeResearchClaims(token)
    expect(claims?.role).toBe('admin_readonly')
    expect(claims?.scopes).toEqual(['workspace:read'])
  })

  it('垃圾输入返回 null（不抛异常）', () => {
    expect(decodeResearchClaims('')).toBeNull()
    expect(decodeResearchClaims('not-a-jwt')).toBeNull()
    expect(decodeResearchClaims('a.b.c')).toBeNull()
    expect(decodeResearchClaims(null as unknown as string)).toBeNull()
    expect(decodeResearchClaims(undefined as unknown as string)).toBeNull()
  })

  it('payload 非 JSON 返回 null', () => {
    const b64 = Buffer.from('not-json', 'utf-8').toString('base64url')
    expect(decodeResearchClaims(`h.${b64}.s`)).toBeNull()
  })

  it('缺 project_id 返回 null（iframe 无法构建 Gateway 路径）', () => {
    const token = encodePayload({
      sub: 'user_1',
      role: 'owner',
      scopes: ['workspace:read'],
      aud: 'research-workspace',
      iat: 0,
      nbf: 0,
      exp: 300,
      jti: 'j_1',
    })
    expect(decodeResearchClaims(token)).toBeNull()
  })

  it('非法 role 返回 null（Owner/Admin 矩阵不可猜测）', () => {
    const token = encodePayload({
      sub: 'user_1',
      project_id: 'proj_abc',
      role: 'superuser',
      scopes: ['workspace:read'],
      aud: 'research-workspace',
      iat: 0,
      nbf: 0,
      exp: 300,
      jti: 'j_1',
    })
    expect(decodeResearchClaims(token)).toBeNull()
  })

  it('scopes 缺失或非数组返回 null', () => {
    const noScopes = encodePayload({
      sub: 'user_1',
      project_id: 'proj_abc',
      role: 'owner',
      aud: 'research-workspace',
      iat: 0,
      nbf: 0,
      exp: 300,
      jti: 'j_1',
    })
    expect(decodeResearchClaims(noScopes)).toBeNull()
  })
})

// UI-02：页面展示辅助——owner/admin 布尔语义（设计 §4.4 权限矩阵）
describe('role helpers', () => {
  it('isAdminReadonly 判定 admin_readonly，owner 不是', () => {
    const owner = decodeResearchClaims(
      encodePayload({
        sub: 'u',
        project_id: 'p',
        role: 'owner',
        scopes: ['workspace:read'],
        aud: 'research-workspace',
        iat: 0,
        nbf: 0,
        exp: 300,
        jti: 'j',
      }),
    )
    const admin = decodeResearchClaims(
      encodePayload({
        sub: 'u',
        project_id: 'p',
        role: 'admin_readonly',
        scopes: ['workspace:read'],
        aud: 'research-workspace',
        iat: 0,
        nbf: 0,
        exp: 300,
        jti: 'j',
      }),
    )
    expect(isAdminReadonly(owner)).toBe(false)
    expect(isAdminReadonly(admin)).toBe(true)
  })
})
