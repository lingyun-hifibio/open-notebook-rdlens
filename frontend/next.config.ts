import type { NextConfig } from "next";
import { buildFrameAncestorsCsp } from "./src/lib/embedded/csp";

// Next.js dev server blocks cross-origin requests (including the HMR
// websocket) from any host not in this list, to guard against DNS
// rebinding. Set NEXT_ALLOWED_DEV_ORIGINS (comma-separated hostnames, no
// protocol/port) to access the dev server from a LAN IP or custom hostname.
const allowedDevOrigins = process.env.NEXT_ALLOWED_DEV_ORIGINS
  ? process.env.NEXT_ALLOWED_DEV_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean)
  : undefined;

const nextConfig: NextConfig = {
  // Enable standalone output for optimized Docker deployment
  output: "standalone",

  ...(allowedDevOrigins && allowedDevOrigins.length > 0 ? { allowedDevOrigins } : {}),

  // Experimental features
  // Type assertion needed: proxyClientMaxBodySize is valid in Next.js 15 but types lag behind
  experimental: {
    // Increase proxy body size limit for file uploads (default is 10MB)
    // This allows larger files to be uploaded through the /api/* rewrite proxy to FastAPI
    proxyClientMaxBodySize: '100mb',
  } as NextConfig['experimental'],

  // API Rewrites: Proxy /api/* requests to FastAPI backend
  // This simplifies reverse proxy configuration - users only need to proxy to port 8502
  // Next.js handles internal routing to the API backend on port 5055
  async rewrites() {
    // INTERNAL_API_URL: Where Next.js server-side should proxy API requests
    // Default: http://localhost:5055 (single-container deployment)
    // Override for multi-container: INTERNAL_API_URL=http://api-service:5055
    const internalApiUrl = process.env.INTERNAL_API_URL || 'http://localhost:5055'

    console.log(`[Next.js Rewrites] Proxying /api/* to ${internalApiUrl}/api/*`)

    return [
      {
        source: '/api/:path*',
        destination: `${internalApiUrl}/api/:path*`,
      },
    ]
  },

  // UI-01（设计 §3.2，REQ-EMB-01/REQ-DEP-02）：Embedded Web 独立受控
  // Origin，通过 CSP `frame-ancestors` 仅允许 RDLens 域名嵌入。服务端
  // 环境变量 `RD_FRAME_ANCESTORS`（空格分隔多个来源）在请求时读取；
  // 未配置时不输出头，保持上游默认行为（G3）。
  async headers() {
    const frameAncestors = buildFrameAncestorsCsp(process.env.RD_FRAME_ANCESTORS)
    if (!frameAncestors) {
      return []
    }
    return [
      {
        source: '/:path*',
        headers: [frameAncestors],
      },
    ]
  },
};

export default nextConfig;
