/**
 * 嵌入式模式运行配置（UI-01，设计 §3.2/§4.1；REQ-EMB-01/REQ-DEP-02）。
 *
 * 与后端 SPK-03 的 `RD_EMBEDDED_MODE` 语义一致（"1"/"true"/"yes" 视为开启），
 * 默认关闭（G3：未启用时保持上游行为）。三个变量均为 NEXT_PUBLIC_ 前缀，
 * Next.js 构建时内联进客户端产物，部署方构建嵌入式镜像时必须显式设置：
 *
 * - `NEXT_PUBLIC_RD_EMBEDDED_MODE`：嵌入式模式开关
 * - `NEXT_PUBLIC_RD_GATEWAY_URL`：RDLens Research Gateway 基址（浏览器唯一
 *   可达 API 入口，REQ-DEP-02）
 * - `NEXT_PUBLIC_RD_PARENT_ORIGIN`：父页面（RDLens 主页面）精确 origin，
 *   可逗号分隔多个；postMessage 五要素绑定中的 origin 白名单（契约 v0 §12.1）。
 *   未配置时会话 fail-closed，不接受任何消息。
 */

const EMBEDDED_MODE_ENV = 'NEXT_PUBLIC_RD_EMBEDDED_MODE'
const GATEWAY_URL_ENV = 'NEXT_PUBLIC_RD_GATEWAY_URL'
const PARENT_ORIGIN_ENV = 'NEXT_PUBLIC_RD_PARENT_ORIGIN'

export function isEmbeddedMode(): boolean {
  const value = (process.env[EMBEDDED_MODE_ENV] ?? '').trim().toLowerCase()
  return value === '1' || value === 'true' || value === 'yes'
}

export function getEmbeddedGatewayUrl(): string {
  return (process.env[GATEWAY_URL_ENV] ?? '').trim().replace(/\/+$/, '')
}

/** 父页面精确 origin 白名单；未配置返回空数组（fail-closed）。 */
export function getEmbeddedParentOrigins(): string[] {
  return (process.env[PARENT_ORIGIN_ENV] ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
}
