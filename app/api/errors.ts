import type { OpenAiError, OpenAiErrorResponse } from './types'

/** 网关内部错误类型：携带 OpenAI 语义的 status / type / code */
export class GatewayError extends Error {
  readonly status: number
  readonly type: string
  readonly code: string | number | null
  readonly param: string | null

  constructor(
    message: string,
    opts: {
      status?: number
      type?: string
      code?: string | number | null
      param?: string | null
    } = {},
  ) {
    super(message)
    this.name = 'GatewayError'
    this.status = opts.status ?? 500
    this.type = opts.type ?? 'api_error'
    this.code = opts.code ?? null
    this.param = opts.param ?? null
  }
}

const badRequest = (message: string, param: string | null = null) =>
  new GatewayError(message, { status: 400, type: 'invalid_request_error', param })

export const errors = {
  badRequest,
  unknownProvider: (provider: string) =>
    new GatewayError(`Unknown provider: ${provider}. Check the first path segment of your baseUrl.`, {
      status: 404,
      type: 'invalid_request_error',
      code: 'unknown_provider',
    }),
  unknownEndpoint: (path: string) =>
    new GatewayError(
      `Unknown API endpoint: ${path}. Supported endpoints: /models, /chat/completions, /images/generations, /images/edits, /video/generations, /video/generations/{task_id}.`,
      { status: 404, type: 'invalid_request_error', code: 'unknown_endpoint' },
    ),
  methodNotAllowed: (allowed: string[]) =>
    new GatewayError(
      `Method not allowed. Allowed: ${allowed.join(', ')}.`,
      { status: 405, type: 'invalid_request_error', code: 'method_not_allowed' },
    ),
  invalidBaseUrl: (raw: string) =>
    new GatewayError(`Invalid upstream base URL: ${raw}`, {
      status: 400,
      type: 'invalid_request_error',
      code: 'invalid_base_url',
      param: 'base_url',
    }),
  unsupportedEndpoint: (provider: string, endpoint: string) =>
    new GatewayError(
      `Provider "${provider}" does not support the ${endpoint} endpoint.`,
      { status: 404, type: 'invalid_request_error', code: 'unsupported_endpoint' },
    ),
  invalidJson: () =>
    badRequest('Request body must be valid JSON with Content-Type: application/json.'),
  missingModel: () => badRequest("Missing required parameter: 'model'.", 'model'),
  missingPrompt: () => badRequest("Missing required parameter: 'prompt'.", 'prompt'),
  missingMessages: () => badRequest("Missing required parameter: 'messages'.", 'messages'),
  upstreamTimeout: (ms: number) =>
    new GatewayError(`Upstream request timed out after ${ms}ms.`, {
      status: 504,
      type: 'api_error',
      code: 'upstream_timeout',
    }),
  upstreamError: (message: string) =>
    new GatewayError(message, { status: 502, type: 'api_error', code: 'upstream_error' }),
}

/** 渲染为 OpenAI 错误响应体 */
export function toErrorBody(error: OpenAiError): OpenAiErrorResponse {
  return { error }
}

export function gatewayErrorBody(e: GatewayError): OpenAiErrorResponse {
  return toErrorBody({
    message: e.message,
    type: e.type,
    param: e.param,
    code: e.code,
  })
}

/**
 * 把上游错误响应体归一化为 OpenAI 错误。
 * 覆盖的已知形状：
 *  - {"error": "message"}                         （字符串）
 *  - {"error": {"message": ..., "type": ...}}     （OpenAI / Anthropic 风格）
 *  - {"message": "..."} / {"detail": "..."}       （杂牌网关常见）
 *  - 纯文本 / HTML / 任意 JSON
 */
export function normalizeUpstreamError(
  status: number,
  bodyText: string,
  context: { provider: string; endpoint: string },
): OpenAiErrorResponse {
  let message = ''
  let type: string | undefined
  let code: string | number | null = null
  let param: string | null = null

  const text = bodyText.trim()
  if (text.startsWith('{') || text.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(text)
      const extracted = extractErrorFromJson(parsed)
      if (extracted) {
        message = extracted.message
        type = extracted.type
        code = extracted.code ?? null
        param = extracted.param ?? null
      } else if (typeof parsed === 'object' && parsed !== null) {
        // JSON 但没有可识别的错误字段：原样截断返回
        message = truncate(text)
      }
    } catch {
      message = truncate(text)
    }
  } else {
    message = truncate(text)
  }

  if (!message) {
    message = `Upstream ${context.provider} responded with status ${status} on ${context.endpoint}.`
  }

  // 类型推断（状态码映射由 mapUpstreamStatus 负责）
  const resolvedType = type ?? inferErrorType(mapUpstreamStatus(status))

  return toErrorBody({
    message,
    type: resolvedType,
    param,
    code: code ?? (status === 429 ? 'rate_limit_exceeded' : null),
  })
}

/** 上游状态码映射：客户端错误保留原状态，服务端错误统一 502 */
export function mapUpstreamStatus(status: number): number {
  if (status >= 500) return 502
  if (status >= 400) return status
  return 502
}

interface ExtractedError {
  message: string
  type?: string
  code?: string | number | null
  param?: string | null
}

function extractErrorFromJson(parsed: unknown, depth = 0): ExtractedError | null {
  if (typeof parsed === 'string') {
    const message = messageFrom(parsed, depth)
    return message ? { message } : null
  }
  if (Array.isArray(parsed)) {
    // FastAPI 校验错误列表（{"detail":[{...}]}）：逐项提取后合并。
    // 注意：不透传数组项的 type（FastAPI 的 "missing"/"value_error" 不是 OpenAI 错误类型）
    const parts = parsed.map((item) => extractErrorFromJson(item, depth)).filter((p): p is ExtractedError => p !== null)
    if (parts.length === 0) return null
    if (parts.length === 1) {
      return { ...parts[0], type: undefined }
    }
    return {
      message: parts.map((p) => p.message).join('; '),
      code: parts.find((p) => p.code != null)?.code ?? null,
      param: parts.find((p) => p.param != null)?.param ?? null,
    }
  }
  if (typeof parsed !== 'object' || parsed === null) return null

  const obj = parsed as Record<string, unknown>

  // {"error": ...}
  if ('error' in obj) {
    const err = obj.error
    if (typeof err === 'string' || Array.isArray(err)) {
      const found = extractErrorFromJson(err, depth)
      if (found) return found
    } else if (typeof err === 'object' && err !== null) {
      const e = err as Record<string, unknown>
      // detail（FastAPI 通用字段）刻意放在最后：优先采用明确的错误字段
      const message = messageFrom(e.message, depth) ?? firstString(e.msg, e.reason) ?? messageFrom(e.detail, depth)
      if (message) {
        return {
          message,
          type: firstString(e.type, e.error_type),
          code: (e.code as string | number | undefined) ?? null,
          param: (e.param as string | undefined) ?? null,
        }
      }
    }
  }

  // detail（FastAPI 通用字段）刻意放在最后：优先采用明确的错误字段
  const message =
    messageFrom(obj.message, depth) ??
    firstString(obj.msg, obj.error_message, obj.errorMessage) ??
    messageFrom(obj.detail, depth)
  if (message) {
    return {
      message,
      type: firstString(obj.type, obj.error_type),
      code: (obj.code as string | number | undefined) ?? null,
    }
  }
  return null
}

/**
 * 从错误字段值中提取可读 message：
 * - 字符串：若是 JSON（FastAPI 的 {"detail":"{\"error\":...}"} 套娃），解析后递归提取
 * - 数组：逐项提取后合并
 */
function messageFrom(value: unknown, depth = 0): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (trimmed === '') return undefined
    if ((trimmed.startsWith('{') || trimmed.startsWith('[')) && depth < 8) {
      try {
        const found = extractErrorFromJson(JSON.parse(trimmed), depth + 1)
        if (found) return found.message
      } catch {
        // 不是合法 JSON，按原文处理
      }
    }
    return trimmed
  }
  if (Array.isArray(value)) {
    const found = extractErrorFromJson(value, depth)
    return found?.message
  }
  return undefined
}

function firstString(...values: unknown[]): string | undefined {
  for (const v of values) {
    if (typeof v === 'string' && v.trim() !== '') return v
  }
  return undefined
}

function inferErrorType(status: number): string {
  if (status === 401 || status === 403) return 'authentication_error'
  if (status === 404) return 'invalid_request_error'
  if (status === 429) return 'rate_limit_error'
  if (status === 400 || status === 422) return 'invalid_request_error'
  return 'api_error'
}

function truncate(text: string, max = 400): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}
