import { filterChatParams, wantsStream, wantsUsageInStream } from '../params'
import {
  aggregateChunks,
  normalizeCompletion,
  parseSseJson,
  streamFromCompletion,
  transformUpstreamSse,
} from '../sse'
import type { ChatCompletionRequest } from '../types'
import { errors } from '../errors'
import { isRecord, jsonResponse, sseResponse, streamFromSyncGenerator } from '../http'
import { callUpstream, isSseResponse } from '../upstream'
import type { ApiRequestContext } from './types'

/** 读取上游响应体：JSON 原样解析，非 JSON 文本原样返回（供包装为 assistant content） */
async function readBodyAsJsonOrText(res: Response): Promise<unknown> {
  const text = await res.text()
  if (!text.trim()) return null
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

export async function handleChat(req: ApiRequestContext): Promise<Response> {
  const { c, provider, upstream, timeoutMs } = req
  const adapter = provider.chat
  if (!adapter) throw errors.unsupportedEndpoint(provider.id, 'chat/completions')

  let body: Record<string, unknown>
  try {
    const parsed = await c.req.json()
    if (!isRecord(parsed)) throw new Error('not an object')
    body = parsed
  } catch {
    throw errors.invalidJson()
  }

  const requestModel = typeof body.model === 'string' ? body.model : ''
  if (!requestModel) throw errors.missingModel()
  if (!Array.isArray(body.messages)) throw errors.missingMessages()

  const clientStream = wantsStream(body)
  const includeUsage = wantsUsageInStream(body)

  // 确定上游实际使用的模式（上游能力抹平）
  const supportsStream = adapter.supportsStreaming !== false
  const supportsNonStream = adapter.supportsNonStreaming !== false
  const upstreamStream = supportsStream && supportsNonStream
    ? clientStream
    : supportsStream
      ? true
      : false

  // 参数过滤（stream / stream_options 由网关控制）
  const filtered = filterChatParams(body, adapter)
  delete filtered.stream
  delete filtered.stream_options

  let upstreamBody: Record<string, unknown> = { ...filtered }
  if (upstreamStream) {
    upstreamBody.stream = true
    if (includeUsage) upstreamBody.stream_options = { include_usage: true }
  }
  if (adapter.transformRequest) {
    const transformed = await adapter.transformRequest(upstreamBody as unknown as ChatCompletionRequest, upstream)
    if (isRecord(transformed)) upstreamBody = transformed
  }

  const headers = new Headers(req.headers)
  headers.set('accept', upstreamStream ? 'text/event-stream' : 'application/json')

  const res = await callUpstream({
    ctx: upstream,
    timeoutMs,
    errorContext: 'chat/completions',
    request: {
      path: adapter.path ?? '/chat/completions',
      method: 'POST',
      headers,
      json: upstreamBody,
    },
  })

  const chunkMeta = {
    requestModel,
    id: `chatcmpl-${crypto.randomUUID()}`,
    created: Math.floor(Date.now() / 1000),
  }

  if (isSseResponse(res)) {
    if (clientStream) {
      // 上游流式 + 客户端流式：逐 chunk 归一化透传
      const stream = transformUpstreamSse(res, {
        ...chunkMeta,
        includeUsage,
        transformChunk: adapter.transformStreamChunk
          ? (chunk) => adapter.transformStreamChunk!(chunk, upstream)
          : undefined,
        signal: c.req.raw.signal,
      })
      return sseResponse(stream)
    }
    // 上游流式 + 客户端非流式：聚合为一个完整响应
    const chunks: Record<string, unknown>[] = []
    for await (const raw of parseSseJson(res, c.req.raw.signal)) {
      const transformed = adapter.transformStreamChunk
        ? await adapter.transformStreamChunk(raw, upstream)
        : raw
      if (isRecord(transformed)) chunks.push(transformed)
    }
    const aggregated = aggregateChunks(chunks, requestModel)
    const transformedResponse = adapter.transformResponse
      ? await adapter.transformResponse(aggregated, upstream)
      : aggregated
    const completion = normalizeCompletion(transformedResponse, requestModel)
    if (!completion) throw errors.upstreamError('Upstream chat/completions stream could not be aggregated.')
    return jsonResponse(completion)
  }

  // 上游非流式（或声明流式但返回了 JSON）
  const parsed = await readBodyAsJsonOrText(res)
  const transformedResponse = adapter.transformResponse
    ? (await adapter.transformResponse(parsed, upstream)) ?? parsed
    : parsed
  // 非 JSON 的 200 响应（部分小众网关会直接回纯文本）：包装为 assistant content
  const completionSource =
    typeof transformedResponse === 'string' && transformedResponse.trim() !== ''
      ? { content: transformedResponse }
      : transformedResponse
  const completion = normalizeCompletion(completionSource, requestModel)
  if (!completion) throw errors.upstreamError('Upstream chat/completions returned a malformed response.')

  if (clientStream) {
    // 上游非流式 + 客户端流式：合成 SSE
    const gen = streamFromCompletion(completion, { includeUsage })
    return sseResponse(streamFromSyncGenerator(gen))
  }
  return jsonResponse(completion)
}
