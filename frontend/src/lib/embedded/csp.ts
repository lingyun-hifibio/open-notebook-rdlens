/**
 * CSP frame-ancestors 策略（UI-01，设计 §3.2；REQ-EMB-01/REQ-DEP-02）。
 *
 * Embedded Web 使用独立受控 Origin，通过 CSP `frame-ancestors` 仅允许
 * RDLens 域名嵌入。`RD_FRAME_ANCESTORS` 为服务端环境变量（next.config
 * headers() 在 next build 时求值一次，固化进 .next/routes-manifest.json；
 * 运行时修改环境变量不生效，必须重建镜像，Issue #102），空格分隔多个
 * 允许来源。未配置时不输出头，保持上游默认行为（G3）。
 */

export interface CspHeader {
  key: string
  value: string
}

export function buildFrameAncestorsCsp(value: string | undefined): CspHeader | null {
  const trimmed = (value ?? '').trim()
  if (trimmed.length === 0) {
    return null
  }
  return {
    key: 'Content-Security-Policy',
    value: `frame-ancestors ${trimmed}`,
  }
}
