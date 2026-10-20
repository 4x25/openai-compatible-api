/**
 * 网关路由解析。
 *
 * 使用方的 baseUrl 两种形式：
 *   https://example.com/<provider>/v1
 *   https://example.com/<provider>/<providerBaseUrl>   （任意 http(s) URL，允许任意 host）
 *
 * 客户端在其后拼接 OpenAI 标准端点，例如：
 *   /<provider>/v1/chat/completions
 *   /<provider>/https://upstream.example/v1/chat/completions
 *
 * 解析策略：从路径尾部匹配已知端点，端点之前的全部内容视为 provider 前缀；
 * 前缀为空或 /v1 时使用 env / 默认 baseUrl，为绝对 URL 时原样使用（自定义 baseUrl）。
 */

export type EndpointKind =
  | 'models'
  | 'chat.completions'
  | 'images.generations'
  | 'images.edits'
  | 'video.generations'
  | 'video.generations.task'

export interface GatewayRouteMatch {
  providerId: string
  kind: EndpointKind
  /** 端点之前的原始前缀（以 / 开头；自定义 baseUrl 形如 "/https://x/v1"） */
  prefix: string
  /** video.generations.task 专用 */
  taskId: string
}

interface EndpointPattern {
  kind: EndpointKind
  methods: string[]
  regex: RegExp
  taskGroup?: boolean
}

const ENDPOINTS: EndpointPattern[] = [
  {
    kind: 'video.generations.task',
    methods: ['GET'],
    regex: /\/video\/generations\/([^/]+)$/,
    taskGroup: true,
  },
  {
    kind: 'video.generations',
    methods: ['POST'],
    regex: /\/video\/generations$/,
  },
  {
    kind: 'chat.completions',
    methods: ['POST'],
    regex: /\/chat\/completions$/,
  },
  {
    kind: 'images.generations',
    methods: ['POST'],
    regex: /\/images\/generations$/,
  },
  {
    kind: 'images.edits',
    methods: ['POST'],
    regex: /\/images\/edits$/,
  },
  {
    kind: 'models',
    methods: ['GET'],
    regex: /\/models$/,
  },
]

/** 判断 URL 是否是本网关的 API 路径（用于中间件中与 HonoX 页面路由分流） */
export function matchApiRoute(url: string): GatewayRouteMatch | null {
  let path: string
  let search = ''
  try {
    const parsed = new URL(url)
    path = parsed.pathname
    search = parsed.search
  } catch {
    return null
  }
  // 先按纯路径匹配（常规请求，查询串被忽略）
  const byPath = tryMatch(path)
  if (byPath) return byPath
  // 再按 路径+查询串 匹配：支持自定义 baseUrl 本身携带查询参数的少见场景
  // （如 /<provider>/https://x/api?api-version=1/chat/completions）
  if (search) return tryMatch(path + search)
  return null
}

function tryMatch(trimmed: string): GatewayRouteMatch | null {
  const path = trimmed.length > 1 && trimmed.endsWith('/') ? trimmed.slice(0, -1) : trimmed
  const segments = path.split('/')
  if (segments.length < 3) return null
  const providerId = segments[1]
  if (!providerId) return null

  for (const endpoint of ENDPOINTS) {
    const match = endpoint.regex.exec(path)
    if (!match) continue
    // prefix = provider 段之后、端点之前的部分（'' | '/v1' | '/https://...'）
    const rawPrefix = path.slice(0, match.index)
    const prefix = rawPrefix.slice(1 + providerId.length)
    const result: GatewayRouteMatch = {
      providerId,
      kind: endpoint.kind,
      prefix,
      taskId: '',
    }
    if (endpoint.taskGroup) result.taskId = decodeSafe(match[1])
    return result
  }
  return null
}

export function endpointMethods(kind: EndpointKind): string[] {
  const pattern = ENDPOINTS.find((e) => e.kind === kind)
  return pattern?.methods ?? []
}

function decodeSafe(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

// ---------------------------------------------------------------------------
// baseUrl 解析
// ---------------------------------------------------------------------------

export interface BaseUrlOptions {
  defaultBaseUrl: string
  versionPath?: string
  envBaseUrl?: string
}

export type BaseUrlSource = 'default' | 'env' | 'custom'

export interface ResolvedBaseUrl {
  baseUrl: string
  source: BaseUrlSource
}

/**
 * 解析本次请求的上游 baseUrl。
 *
 * - prefix 为空或 '/v1'（provider 的 versionPath）→ env baseUrl → 默认值
 * - prefix 为绝对 http(s) URL → 原样使用（允许任意 host），仅剥掉 userinfo / fragment
 * - 其余 → null（invalid_base_url）
 */
export function resolveBaseUrl(prefix: string, options: BaseUrlOptions): ResolvedBaseUrl | null {
  const versionPath = options.versionPath ?? '/v1'

  const isVersionPrefix = prefix === '' || prefix === `/${versionPath.replace(/^\//, '')}`
  if (isVersionPrefix) {
    const env = options.envBaseUrl?.trim()
    if (env) {
      const normalized = normalizeConfiguredBaseUrl(env, versionPath)
      return normalized ? { baseUrl: normalized, source: 'env' } : null
    }
    const normalized = normalizeConfiguredBaseUrl(options.defaultBaseUrl, versionPath)
    return normalized ? { baseUrl: normalized, source: 'default' } : null
  }

  // 自定义 baseUrl：前缀形如 "/https://host/v1"
  let raw = prefix.startsWith('/') ? prefix.slice(1) : prefix
  raw = decodeSafe(raw)
  const parsed = parseUpstreamUrl(raw)
  return parsed ? { baseUrl: parsed, source: 'custom' } : null
}

/** 校验并规范化 baseUrl：必须是合法 http(s) URL；路径为空时补 versionPath；去尾斜杠 */
function normalizeConfiguredBaseUrl(raw: string, versionPath: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    return null
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
  parsed.username = ''
  parsed.password = ''
  parsed.hash = ''
  if (parsed.pathname === '/' || parsed.pathname === '') {
    parsed.pathname = versionPath.startsWith('/') ? versionPath : `/${versionPath}`
  }
  return parsed.toString().replace(/\/+$/, '')
}

/** 自定义 baseUrl：任意 host 允许，但必须是绝对 http(s) URL */
export function parseUpstreamUrl(raw: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    return null
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
  parsed.username = ''
  parsed.password = ''
  parsed.hash = ''
  return parsed.toString().replace(/\/+$/, '')
}
