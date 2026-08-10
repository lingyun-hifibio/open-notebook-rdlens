import { describe, expect, it } from 'vitest'
import { buildFrameAncestorsCsp } from './csp'

// UI-01 Red：CSP frame-ancestors（设计 §3.2，REQ-EMB-01/REQ-DEP-02）——
// Embedded Web 仅允许 RDLens 域名嵌入；未配置时不输出头（上游行为不变）。

describe('buildFrameAncestorsCsp（设计 §3.2）', () => {
  it('配置 RD_FRAME_ANCESTORS 时输出仅含 frame-ancestors 的 CSP 头', () => {
    expect(buildFrameAncestorsCsp('https://rdlens.example.com')).toEqual({
      key: 'Content-Security-Policy',
      value: 'frame-ancestors https://rdlens.example.com',
    })
  })

  it('支持多个允许来源（空格分隔）', () => {
    expect(buildFrameAncestorsCsp('https://rdlens.example.com https://rdlens.internal')).toEqual({
      key: 'Content-Security-Policy',
      value: 'frame-ancestors https://rdlens.example.com https://rdlens.internal',
    })
  })

  it('未配置时返回 null（不添加头，保持上游默认行为）', () => {
    expect(buildFrameAncestorsCsp(undefined)).toBeNull()
    expect(buildFrameAncestorsCsp('')).toBeNull()
    expect(buildFrameAncestorsCsp('   ')).toBeNull()
  })
})
