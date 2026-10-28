import { filterImageParams } from '../params'
import type { ImageGenerationRequest, ImagesResponse } from '../types'
import { errors, GatewayError } from '../errors'
import { bytesToBase64, isRecord, jsonResponse, readMediaInput, unixNow } from '../http'
import { callUpstream, readUpstreamBytes } from '../upstream'
import type { ImageAdapter, UpstreamRequest } from '../providers/types'
import type { ApiRequestContext } from './types'

/** images/edits multipart 中允许透传的文本字段 */
const EDIT_FORM_FIELDS = new Set([
  'model',
  'prompt',
  'n',
  'size',
  'quality',
  'style',
  'response_format',
  'user',
])

export async function handleImages(req: ApiRequestContext, kind: 'generations' | 'edits'): Promise<Response> {
  const { c, provider, upstream, timeoutMs } = req
  const adapter: ImageAdapter | undefined = provider.images?.[kind]
  if (!adapter) throw errors.unsupportedEndpoint(provider.id, `images/${kind}`)

  const input = await readMediaInput(c.req.raw, adapter.maxRequestBytes)
  let upstreamRequest: UpstreamRequest | UpstreamRequest[]
  if (input instanceof FormData) {
    if (adapter.transformMultipartRequest) {
      // 供应商负责解析和过滤嵌套的 SDK 字段，默认透传路径仍按公共白名单处理。
      upstreamRequest = await adapter.transformMultipartRequest(input, upstream)
    } else {
      // multipart：文本字段按白名单过滤，文件（image / mask）原样透传
      const filtered = new FormData()
      for (const [key, value] of input.entries()) {
        if (adapter.unsupportedParams?.includes(key)) continue
        if (typeof value === 'string') {
          const allowed = EDIT_FORM_FIELDS.has(key) || adapter.extraParams?.includes(key)
          if (allowed && value !== '') filtered.append(key, value)
        } else {
          filtered.append(key, value)
        }
      }
      upstreamRequest = { path: adapter.path, method: 'POST', formData: filtered }
    }
  } else {
    const body = input
    const requestModel = typeof body.model === 'string' ? body.model : ''
    if (!requestModel) throw errors.missingModel()
    if (kind === 'generations' && typeof body.prompt !== 'string') throw errors.missingPrompt()

    const filtered = filterImageParams(body, adapter)
    upstreamRequest = {
      path: adapter.path,
      method: 'POST',
      json: filtered,
    }
    if (adapter.transformRequest) {
      const transformed = await adapter.transformRequest(filtered as unknown as ImageGenerationRequest, upstream)
      upstreamRequest = transformed
    }
  }

  const requests = Array.isArray(upstreamRequest) ? upstreamRequest : [upstreamRequest]
  if (requests.length === 0) throw errors.upstreamError('Image adapter returned no upstream requests.')
  const settled = await Promise.allSettled(requests.map((request) => callUpstream({
    ctx: upstream, timeoutMs, errorContext: `images/${kind}`,
    request: { ...request, headers: new Headers(req.headers) },
  })))
  const responses = settled.flatMap((result) => result.status === 'fulfilled' ? [result.value] : [])
  try {
    const failure = settled.find((result) => result.status === 'rejected')
    if (failure?.status === 'rejected') throw failure.reason
    let remaining = adapter.maxResponseBytes ?? Infinity
    const payloads: ImagesResponse[] = []
    for (const res of responses) {
      const bytes = await readUpstreamBytes(upstream, res, remaining, () => errors.upstreamError('Aggregated image response is too large.'))
      remaining -= bytes.byteLength
      if ((res.headers.get('content-type') ?? '').startsWith('image/')) {
        payloads.push({ created: unixNow(), data: [{ b64_json: bytesToBase64(bytes) }] })
        continue
      }
      let parsed: unknown = null
      try { parsed = JSON.parse(new TextDecoder().decode(bytes)) } catch { /* 下方统一处理。 */ }
      const transformed = adapter.transformResponse ? await adapter.transformResponse(parsed, upstream) : parsed
      const normalized = normalizeImagesResponse(transformed)
      if (!normalized) throw errors.upstreamError(`Upstream images/${kind} returned a malformed response.`)
      payloads.push(normalized)
    }
    return jsonResponse({ ...payloads[0], data: payloads.flatMap((payload) => payload.data) })
  } catch (error) {
    if (upstream.signal.aborted) throw new GatewayError('Client aborted the request.', { status: 499 })
    throw error
  } finally {
    await Promise.allSettled(responses.map((res) => res.body?.cancel()))
  }
}

/** 归一化图片响应：支持 data[] / images[] / 单 url / b64_json 字段风格 */
export function normalizeImagesResponse(body: unknown): ImagesResponse | null {
  if (typeof body === 'string') {
    return { created: unixNow(), data: [{ url: body }] }
  }
  if (!isRecord(body)) return null

  let items: unknown[] | null = null
  if (Array.isArray(body.data)) items = body.data
  else if (Array.isArray(body.images)) items = body.images
  else if (Array.isArray(body.outputs)) items = body.outputs
  else if (typeof body.url === 'string' || typeof body.b64_json === 'string') items = [body]
  if (!items || items.length === 0) return null

  const data = items
    .map((item): { url?: string; b64_json?: string; revised_prompt?: string } | null => {
      if (typeof item === 'string') return { url: item }
      if (!isRecord(item)) return null
      const out: { url?: string; b64_json?: string; revised_prompt?: string } = {}
      if (typeof item.url === 'string' && item.url) out.url = item.url
      if (typeof item.b64_json === 'string' && item.b64_json) out.b64_json = item.b64_json
      if (typeof item.image === 'string' && item.image) out.b64_json = item.image
      if (typeof item.revised_prompt === 'string') out.revised_prompt = item.revised_prompt
      if (!out.url && !out.b64_json) return null
      return out
    })
    .filter((x): x is { url?: string; b64_json?: string; revised_prompt?: string } => x !== null)

  if (data.length === 0) return null
  return {
    created: typeof body.created === 'number' ? body.created : unixNow(),
    data,
  }
}
