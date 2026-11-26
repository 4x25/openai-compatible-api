import type { Context } from 'hono'
import { errors } from '../errors'
import { envPrefix } from '../providers/registry'
import type { Provider, ProviderCallContext } from '../providers/types'
import { parseRawUpstreamUrl, resolveBaseUrl } from '../router'
import type { GatewayRouteMatch } from '../router'
import { fetchWithTimeout } from '../upstream'

/** 代理必须自行处理或由 fetch 重写的逐跳 / 连接级头。 */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

const SCHEME_LIKE = /^\/[a-z][a-z0-9+.-]*:/i
const ENCODED_SCHEME_LIKE = /^\/[a-z][a-z0-9+.-]*%3A/i
const HEADER_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/
const BODYLESS_METHODS = new Set(['GET', 'HEAD'])

export interface PassthroughRequestContext {
  c: Context
  provider: Provider
  match: GatewayRouteMatch
  env: Record<string, string | undefined>
  fetch: typeof fetch
  timeoutMs: number
}

/**
 * 完全透传：请求体直接以流转发，请求头只剔除逐跳字段，响应（含错误 / SSE）原样返回。
 * 不做参数过滤、认证转换、JSON 解析或错误抹平。
 */
export async function handlePassthrough(req: PassthroughRequestContext): Promise<Response> {
  const url = passthroughUrl(req)

  const headers = new Headers(req.c.req.raw.headers)
  stripHopByHop(headers)
  // fetch 会按目标 URL 重写，或与流式正文长度冲突。
  headers.delete('host')
  headers.delete('content-length')
  // 让上游尽量返回未压缩字节，避免 fetch 自动解压后响应头与正文不一致。
  headers.set('accept-encoding', 'identity')

  const method = req.c.req.method
  const body = BODYLESS_METHODS.has(method) ? undefined : req.c.req.raw.body
  // Node/undici 要求流式请求体显式声明 duplex；其他运行时忽略该字段。
  const init: RequestInit & { duplex?: 'half' } = {
    method,
    headers,
    body,
    redirect: 'manual',
    ...(body ? { duplex: 'half' as const } : {}),
  }

  const upstream: ProviderCallContext = {
    baseUrl: url,
    credential: null,
    env: req.env,
    fetch: req.fetch,
    signal: req.c.req.raw.signal,
  }
  const res = await fetchWithTimeout(upstream, url, init, req.timeoutMs, 'passthrough')
  return passthroughResponse(res)
}

/**
 * 目标解析：
 * - `/_/https://host/path` → 绝对 URL 原样使用
 * - `/_/v1/chat/...`     → 拼到 `__BASE_URL` / 默认 baseUrl（`/v1` 仅作版本标记）
 */
function passthroughUrl(req: PassthroughRequestContext): string {
  const target = req.match.target ?? '/'
  const search = new URL(req.c.req.url).search

  // 先按原始 target 解析，保留 %2F / %3F / 尾斜杠；解码形式作为兼容回退。
  const decoded = decodeSafe(target)
  const rawScheme = SCHEME_LIKE.test(target)
  const decodedScheme = SCHEME_LIKE.test(decoded)
  if (rawScheme || decodedScheme) {
    const absolute =
      (rawScheme ? parseRawUpstreamUrl(target.slice(1)) : null) ??
      (decodedScheme ? parseRawUpstreamUrl(decoded.slice(1)) : null)
    // 形如 scheme 的目标不能被静默当成相对路径发往默认上游。
    if (!absolute) throw errors.invalidBaseUrl(target)
    return appendSearch(absolute, search)
  }

  // 整体编码但无法解码（如含非法 %zz）的 scheme-like 目标同样拒绝，避免改发默认上游。
  if (ENCODED_SCHEME_LIKE.test(target)) throw errors.invalidBaseUrl(target)

  const resolved = resolveBaseUrl('', {
    defaultBaseUrl: req.provider.defaultBaseUrl,
    versionPath: req.provider.versionPath,
    envBaseUrl: req.env[`${envPrefix(req.provider.id)}_BASE_URL`],
  })
  if (!resolved) throw errors.invalidBaseUrl(target)

  const versionPath = `/${(req.provider.versionPath ?? '/v1').replace(/^\/+|\/+$/g, '')}`
  const path = target === versionPath || target === `${versionPath}/`
    ? '/'
    : target.startsWith(`${versionPath}/`)
      ? target.slice(versionPath.length)
      : target

  // env baseUrl 可能自带查询串，拼接路径时保留。
  const queryIndex = resolved.baseUrl.indexOf('?')
  const basePath = queryIndex === -1 ? resolved.baseUrl : resolved.baseUrl.slice(0, queryIndex)
  const baseQuery = queryIndex === -1 ? '' : resolved.baseUrl.slice(queryIndex)
  return appendSearch(basePath.replace(/\/+$/, '') + path + baseQuery, search)
}

/** 保持原始查询串编码，不做 URLSearchParams 往返。 */
function appendSearch(url: string, search: string): string {
  if (!search) return url
  const separator = !url.includes('?') ? '?' : /[?&]$/.test(url) ? '' : '&'
  return url + separator + search.slice(1)
}

function passthroughResponse(res: Response): Response {
  const headers = new Headers(res.headers)
  stripHopByHop(headers)
  // Node fetch 会自动解压正文，但仍保留 content-encoding；原样返回会让客户端二次解码。
  const encoding = headers.get('content-encoding')?.trim().toLowerCase()
  if (encoding && encoding !== 'identity') {
    headers.delete('content-encoding')
    headers.delete('content-length')
  }
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers })
}

/** 删除 Connection 中列举的字段，再删除标准逐跳头。 */
function stripHopByHop(headers: Headers): void {
  const connection = headers.get('connection')
  if (connection) {
    for (const token of connection.split(',')) {
      const name = token.trim()
      // Headers.delete 对非法 header name 抛 TypeError；畸形 token 直接跳过。
      if (HEADER_TOKEN.test(name)) headers.delete(name)
    }
  }
  for (const name of HOP_BY_HOP) headers.delete(name)
}

function decodeSafe(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}
