import { filterImageParams } from '../params'
import type { ImageGenerationRequest, ImagesResponse } from '../types'
import { errors } from '../errors'
import { isRecord, jsonResponse, unixNow } from '../http'
import { callUpstream, parseJsonBody } from '../upstream'
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

  const contentType = c.req.header('content-type') ?? ''
  const isMultipart = contentType.includes('multipart/form-data')

  let upstreamRequest: UpstreamRequest
  if (isMultipart) {
    // multipart：文本字段按白名单过滤，文件（image / mask）原样透传
    let form: FormData
    try {
      form = await c.req.formData()
    } catch {
      throw errors.badRequest('Invalid multipart/form-data body.')
    }
    const filtered = new FormData()
    for (const [key, value] of form.entries()) {
      if (typeof value === 'string') {
        const allowed = EDIT_FORM_FIELDS.has(key) || adapter.extraParams?.includes(key)
        if (allowed && value !== '') filtered.append(key, value)
      } else {
        filtered.append(key, value)
      }
    }
    upstreamRequest = { path: adapter.path, method: 'POST', formData: filtered }
  } else {
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

  const headers = new Headers(req.headers)
  const res = await callUpstream({
    ctx: upstream,
    timeoutMs,
    errorContext: `images/${kind}`,
    request: { ...upstreamRequest, headers },
  })

  const responseContentType = res.headers.get('content-type') ?? ''

  // 上游直接返回图片二进制：包装为 b64_json
  if (responseContentType.startsWith('image/')) {
    const buffer = await res.arrayBuffer()
    const data = [b64(buffer)]
    const body: ImagesResponse = { created: unixNow(), data }
    return jsonResponse(body)
  }

  const parsed = await parseJsonBody(res)
  const transformed = adapter.transformResponse
    ? (await adapter.transformResponse(parsed, upstream)) ?? parsed
    : parsed
  const normalized = normalizeImagesResponse(transformed)
  if (!normalized) {
    throw errors.upstreamError(`Upstream images/${kind} returned a malformed response.`)
  }
  return jsonResponse(normalized)
}

function b64(buffer: ArrayBuffer): { b64_json: string } {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  const chunkSize = 0x8000
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize))
  }
  return { b64_json: btoa(binary) }
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
