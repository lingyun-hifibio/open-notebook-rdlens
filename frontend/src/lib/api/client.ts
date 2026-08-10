import axios, { AxiosResponse } from 'axios'
import { getApiUrl } from '@/lib/config'
import { getAuthToken } from '@/lib/auth-token'
import { isEmbeddedMode, getEmbeddedGatewayUrl } from '@/lib/embedded/config'
import { getResearchToken } from '@/lib/embedded/token-store'

// API client with runtime-configurable base URL
// The base URL is fetched from the API config endpoint on first request
//
// Request timeout defaults to 10 minutes (600000ms) to accommodate slow LLM
// operations (transformations, insights, synchronous chat) on slower hardware
// (Ollama, LM Studio). Configure it via NEXT_PUBLIC_API_TIMEOUT_MS for models
// that can take longer than 10 minutes to respond (#880).
// Note: value is in milliseconds; an explicit 0 disables the timeout entirely.
// An empty or invalid value falls back to the default (so a present-but-empty
// env var doesn't accidentally disable timeouts).
const DEFAULT_API_TIMEOUT_MS = 600000 // 600 seconds = 10 minutes
const rawTimeout = process.env.NEXT_PUBLIC_API_TIMEOUT_MS
const parsedTimeout = rawTimeout && rawTimeout.trim() !== '' ? Number(rawTimeout) : NaN
const apiTimeout = Number.isFinite(parsedTimeout) && parsedTimeout >= 0
  ? parsedTimeout
  : DEFAULT_API_TIMEOUT_MS

// Resolved request budget in milliseconds (0 = disabled). Exported so streaming
// consumers can align their own idle watchdogs to the same configurable budget.
export const API_TIMEOUT_MS = apiTimeout

export const apiClient = axios.create({
  timeout: apiTimeout,
  headers: {
    'Content-Type': 'application/json',
  },
  withCredentials: false,
})

// Request interceptor to add base URL and auth header
apiClient.interceptors.request.use(async (config) => {
  // Set the base URL dynamically from runtime config.
  // 嵌入式模式（UI-01，REQ-DEP-02）：baseURL 只指向 RDLens Research
  // Gateway；普通模式保持上游行为（/api 相对路径）。
  if (!config.baseURL) {
    if (isEmbeddedMode()) {
      const gatewayUrl = getEmbeddedGatewayUrl()
      if (!gatewayUrl) {
        // fail-closed：未配置 Gateway 时拒绝请求，Research Token 永不
        // 发往未知基址（REQ-EMB-02/REQ-DEP-02）
        return Promise.reject(
          new Error('NEXT_PUBLIC_RD_GATEWAY_URL is not configured for embedded mode'),
        )
      }
      config.baseURL = gatewayUrl
    } else {
      const apiUrl = await getApiUrl()
      config.baseURL = `${apiUrl}/api`
    }
  }

  // 嵌入式模式 Bearer 只取内存 Research Token（REQ-EMB-02），
  // 不读 localStorage `auth-storage`。
  const token = isEmbeddedMode() ? getResearchToken() : getAuthToken()
  if (token) {
    config.headers.Authorization = `Bearer ${token}`
  }

  // Handle FormData vs JSON content types
  if (config.data instanceof FormData) {
    // Remove any Content-Type header to let browser set multipart boundary
    delete config.headers['Content-Type']
  } else if (config.method && ['post', 'put', 'patch'].includes(config.method.toLowerCase())) {
    config.headers['Content-Type'] = 'application/json'
  }

  return config
})

// Response interceptor for error handling
apiClient.interceptors.response.use(
  (response: AxiosResponse) => response,
  (error) => {
    // 嵌入式模式不触发 /login 跳转：会话失效由父页面经 postMessage
    // 刷新/登出/销毁消息驱动（设计 §4.2），Token 续期不是浏览器直连登录页。
    if (error.response?.status === 401 && !isEmbeddedMode()) {
      // Clear auth and redirect to login
      if (typeof window !== 'undefined') {
        localStorage.removeItem('auth-storage')
        window.location.href = '/login'
      }
    }
    return Promise.reject(error)
  }
)

export default apiClient