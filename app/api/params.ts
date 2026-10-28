/**
 * 参数抹平：以 OpenAI 标准参数白名单为准，未知参数静默丢弃。
 *
 * - 白名单 = 标准 OpenAI 参数 + provider 声明的 extraParams
 * - provider 声明的 unsupportedParams 在白名单基础上再剔除
 * - stream / stream_options 由网关控制，不透传（转换层另行处理）
 */

const CHAT_ALLOWED = new Set([
  'model',
  'messages',
  'frequency_penalty',
  'logit_bias',
  'logprobs',
  'top_logprobs',
  'max_tokens',
  'max_completion_tokens',
  'n',
  'presence_penalty',
  'response_format',
  'seed',
  'stop',
  'stream',
  'stream_options',
  'temperature',
  'top_p',
  'tools',
  'tool_choice',
  'user',
  'parallel_tool_calls',
  'reasoning_effort',
])

const IMAGE_ALLOWED = new Set([
  'model',
  'prompt',
  'n',
  'size',
  'quality',
  'style',
  'response_format',
  'user',
])

const VIDEO_ALLOWED = new Set([
  'model',
  'prompt',
  'input_reference',
  'size',
  'seconds',
])

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function filterParams<T extends Record<string, unknown>>(
  body: T,
  allowed: Set<string>,
  unsupported: string[] | undefined,
  extra: string[] | undefined,
): Record<string, unknown> {
  const blocked = unsupported ? new Set(unsupported) : null
  const allow = new Set(allowed)
  for (const key of extra ?? []) allow.add(key)
  const result: Record<string, unknown> = {}
  for (const key of allow) {
    if (blocked?.has(key)) continue
    if (key in body) result[key] = body[key]
  }
  return result
}

export function filterChatParams(
  body: Record<string, unknown>,
  opts: { unsupportedParams?: string[]; extraParams?: string[] } = {},
): Record<string, unknown> {
  return filterParams(body, CHAT_ALLOWED, opts.unsupportedParams, opts.extraParams)
}

export function filterImageParams(
  body: Record<string, unknown>,
  opts: { unsupportedParams?: string[]; extraParams?: string[] } = {},
): Record<string, unknown> {
  return filterParams(body, IMAGE_ALLOWED, opts.unsupportedParams, opts.extraParams)
}

export function filterVideoParams(
  body: Record<string, unknown>,
  opts: { unsupportedParams?: string[]; extraParams?: string[] } = {},
): Record<string, unknown> {
  return filterParams(body, VIDEO_ALLOWED, opts.unsupportedParams, opts.extraParams)
}

/** 提取客户端请求体中的 stream 意图（默认 false） */
export function wantsStream(body: Record<string, unknown>): boolean {
  return body.stream === true
}

/** 提取 stream_options.include_usage（默认 false） */
export function wantsUsageInStream(body: Record<string, unknown>): boolean {
  const so = body.stream_options
  if (isPlainObject(so)) return so.include_usage === true
  return false
}
