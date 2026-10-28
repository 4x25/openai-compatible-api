import { GatewayError, errors, mapUpstreamStatus, normalizeUpstreamError } from './errors'
import type { OpenAiErrorResponse } from './types'
import { readBytes } from './http'
import type { Provider, ProviderAuth, ProviderCallContext, UpstreamRequest } from './providers/types'

// ---------------------------------------------------------------------------
// 环境变量读取（边缘兼容：c.env 优先，Node 回退 process.env）
// ---------------------------------------------------------------------------

function readEnv(env: unknown, key: string): string | undefined {
  if (typeof env === 'object' && env !== null) {
    const value = (env as Record<string, unknown>)[key]
    if (typeof value === 'string' && value.length > 0) return value
  }
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
  const value = proc?.env?.[key]
  if (typeof value === 'string' && value.length > 0) return value
  return undefined
}

export interface ProviderEnv {
  [key: string]: string | undefined
}

export function providerEnv(env: unknown): ProviderEnv {
  // 收集本网关关心的变量前缀，避免把无关绑定全部暴露
  const result: ProviderEnv = {}
  if (typeof env === 'object' && env !== null) {
    for (const [key, value] of Object.entries(env as Record<string, unknown>)) {
      if (typeof value === 'string') result[key] = value
    }
  }
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
  if (proc?.env) {
    for (const [key, value] of Object.entries(proc.env)) {
      if (typeof value === 'string' && value !== undefined && result[key] === undefined) {
        result[key] = value
      }
    }
  }
  return result
}

// ---------------------------------------------------------------------------
// 认证解析
// ---------------------------------------------------------------------------

const bearerPrefix = /^(\w+(?:-\w+)*)\s+(.+)$/i

/**
 * 解析使用方凭证与上游请求头。
 *
 * 规则：
 * 1. 客户端 Authorization > 客户端 x-api-key > `${PROVIDER}_API_KEY_FOR_DEV`（兜底）
 * 2. 默认（Authorization + Bearer）时，客户端 Authorization 原样透传
 * 3. 自定义 header/scheme 时，从客户端凭证中剥掉 scheme 后重新组装
 */
export function resolveAuth(
  headers: Headers,
  provider: Provider,
  clientAuth: string | null,
  clientApiKey: string | null,
  env: ProviderEnv,
): { credential: string | null } {
  // 'none'：上游无需鉴权，不转发任何客户端凭证，也不使用 dev key
  if (provider.auth === 'none') return { credential: null }

  const auth: ProviderAuth = provider.auth ?? {}
  const headerName = (auth.header ?? 'authorization').toLowerCase()
  const scheme = auth.scheme !== undefined ? auth.scheme : 'Bearer'

  let credential: string | null = null
  let passthrough = false

  if (clientAuth) {
    const match = bearerPrefix.exec(clientAuth.trim())
    credential = match ? match[2].trim() : clientAuth.trim()
    passthrough = headerName === 'authorization' && !provider.auth
  } else if (clientApiKey) {
    credential = clientApiKey.trim()
  } else {
    const prefix = provider.id.toUpperCase().replace(/[^A-Z0-9]/g, '_')
    const dev = readEnv(env, `${prefix}_API_KEY_FOR_DEV`)
    if (dev) credential = dev
  }

  if (credential) {
    if (passthrough && clientAuth) {
      headers.set('Authorization', clientAuth)
    } else if (headerName === 'authorization') {
      headers.set('Authorization', scheme ? `${scheme} ${credential}` : credential)
    } else {
      headers.set(headerName, scheme ? `${scheme} ${credential}` : credential)
    }
  }

  return { credential }
}

export function buildUpstreamHeaders(
  provider: Provider,
  clientAuth: string | null,
  clientApiKey: string | null,
  env: ProviderEnv,
  accept: 'json' | 'events',
): { headers: Headers; credential: string | null } {
  const headers = new Headers()
  const { credential } = resolveAuth(headers, provider, clientAuth, clientApiKey, env)

  const authConf = provider.auth === 'none' ? undefined : provider.auth
  for (const [key, value] of Object.entries(provider.headers ?? {})) {
    headers.set(key, value)
  }
  for (const [key, value] of Object.entries(authConf?.extraHeaders ?? {})) {
    headers.set(key, value)
  }
  headers.set('accept', accept === 'events' ? 'text/event-stream' : 'application/json')
  return { headers, credential }
}

// ---------------------------------------------------------------------------
// 上游调用
// ---------------------------------------------------------------------------

export const DEFAULT_TIMEOUT_MS = 300_000

export interface UpstreamCallOptions {
  ctx: ProviderCallContext
  request: UpstreamRequest
  timeoutMs: number
  /** 出错时的错误上下文描述 */
  errorContext: string
}

export function upstreamUrl(baseUrl: string, request: Pick<UpstreamRequest, 'path' | 'baseUrl' | 'query'>): string {
  const path = new URL(request.path.replace(/^\/+/, ''), 'https://path.invalid/')
  const u = new URL(request.baseUrl ?? baseUrl)
  const cleanPath = u.pathname.replace(/\/+$/, '')
  u.pathname = cleanPath + path.pathname
  for (const [key, value] of path.searchParams) u.searchParams.set(key, value)
  for (const [key, value] of Object.entries(request.query ?? {})) u.searchParams.set(key, value)
  return u.toString()
}

async function readUpstreamError(res: Response, errorContext: string): Promise<OpenAiErrorResponse> {
  const text = await res.text().catch(() => '')
  return normalizeUpstreamError(res.status, text, { provider: '', endpoint: errorContext })
}

/**
 * 调用上游并抹平错误：
 * - 非 2xx -> OpenAI 错误响应体 + 映射状态码
 * - 2xx 但不是 JSON/SSE -> 包装为 OpenAI 错误
 */
export async function callUpstream(options: UpstreamCallOptions): Promise<Response> {
  const { ctx, request, timeoutMs, errorContext } = options
  const url = upstreamUrl(ctx.baseUrl, request)
  const method = request.method ?? 'POST'

  const headers = new Headers(request.headers ?? undefined)

  let body: BodyInit | undefined
  if (request.json !== undefined) {
    headers.set('content-type', 'application/json')
    body = JSON.stringify(request.json)
  } else if (request.formData !== undefined) {
    headers.delete('content-type')
    body = request.formData
  }

  const res = await fetchWithTimeout(ctx, url, { method, headers, body, redirect: 'error' }, timeoutMs, errorContext)

  if (!res.ok) {
    const errorBody = await readUpstreamError(res, errorContext)
    // 仅放行重试提示，避免把上游 cookie、认证或内部账户信息暴露给客户端。
    const retryAfter = res.headers.get('retry-after')
    throw new GatewayError(errorBody.error.message, {
      status: mapUpstreamStatus(res.status),
      type: errorBody.error.type,
      code: errorBody.error.code,
      param: errorBody.error.param,
      headers: retryAfter ? { 'retry-after': retryAfter } : undefined,
    })
  }

  return res
}

/** 媒体下载使用全新的头集合，绝不转发供应商凭证。 */
export async function callMedia(
  ctx: ProviderCallContext,
  url: string,
  range: string | undefined,
  timeoutMs: number,
): Promise<Response> {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw errors.upstreamError('Upstream returned an invalid media URL.')
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw errors.upstreamError('Upstream returned an invalid media URL.')
  }
  const headers = new Headers({ accept: 'video/*,application/octet-stream', 'accept-encoding': 'identity' })
  if (range) headers.set('range', range)
  return fetchWithTimeout(ctx, parsed.toString(), { headers, redirect: 'follow' }, timeoutMs, 'video content')
}

async function fetchWithTimeout(
  ctx: ProviderCallContext,
  url: string,
  init: RequestInit,
  timeoutMs: number,
  errorContext: string,
): Promise<Response> {
  if (ctx.signal.aborted) throw new GatewayError('Client aborted the request.', { status: 499 })
  const controller = new AbortController()
  const timer = setTimeout(() => {
    controller.abort(new GatewayError(`Upstream timeout after ${timeoutMs}ms`, {
      status: 504,
      type: 'api_error',
      code: 'upstream_timeout',
    }))
  }, timeoutMs)

  const onClientAbort = () => controller.abort(ctx.signal.reason)
  ctx.signal.addEventListener('abort', onClientAbort, { once: true })
  const release = () => ctx.signal.removeEventListener('abort', onClientAbort)

  try {
    const res = await ctx.fetch(url, {
      ...init,
      signal: controller.signal,
    })
    if (!res.body) {
      release()
      return res
    }
    // Headers 返回后仍保持取消关联，读完或取消 body 时再释放监听。
    const reader = res.body.getReader()
    return new Response(new ReadableStream<Uint8Array>({
      async pull(target) {
        try {
          const { done, value } = await reader.read()
          if (done) {
            release()
            reader.releaseLock()
            target.close()
          } else target.enqueue(value)
        } catch (error) {
          release()
          reader.releaseLock()
          target.error(error)
        }
      },
      async cancel(reason) {
        release()
        controller.abort(reason)
        try {
          await reader.cancel(reason)
        } finally {
          reader.releaseLock()
        }
      },
    }), { status: res.status, statusText: res.statusText, headers: res.headers })
  } catch (e) {
    release()
    if (controller.signal.aborted && controller.signal.reason instanceof GatewayError) {
      throw controller.signal.reason
    }
    if (ctx.signal.aborted) {
      // 客户端主动断开，直接结束
      throw new GatewayError('Client aborted the request.', { status: 499 })
    }
    throw errors.upstreamError(`Upstream ${errorContext} failed: ${String((e as Error)?.message ?? e)}`)
  } finally {
    clearTimeout(timer)
  }
}

// ---------------------------------------------------------------------------
// 响应体解析
// ---------------------------------------------------------------------------

export async function parseJsonBody(res: Response): Promise<unknown | null> {
  try {
    return await res.json()
  } catch {
    return null
  }
}

/** 上游正文断连属于 502，客户端取消仍保留 499，限额错误原样保留。 */
export async function readUpstreamBytes(
  ctx: ProviderCallContext,
  res: Response,
  maxBytes: number,
  tooLarge: () => Error,
): Promise<Uint8Array<ArrayBuffer>> {
  try {
    return await readBytes(res.body, maxBytes, tooLarge)
  } catch (error) {
    if (ctx.signal.aborted) throw new GatewayError('Client aborted the request.', { status: 499 })
    if (error instanceof GatewayError) throw error
    throw errors.upstreamError('Upstream response body could not be read.')
  }
}

export function isSseResponse(res: Response): boolean {
  return (res.headers.get('content-type') ?? '').includes('text/event-stream')
}
