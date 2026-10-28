import { filterVideoParams } from '../params'
import type { VideoCreateRequest, VideoResponse } from '../types'
import { errors, GatewayError, mapUpstreamStatus } from '../errors'
import { isRecord, jsonResponse, readMediaInput, unixNow } from '../http'
import { callMedia, callUpstream, readUpstreamBytes } from '../upstream'
import type { ApiRequestContext } from './types'
import type { UpstreamRequest, VideoAdapter, VideoResponseContext } from '../providers/types'

/** POST /videos —— 创建异步任务。 */
export async function handleVideoCreate(req: ApiRequestContext): Promise<Response> {
  const adapter = req.provider.video?.create
  if (!adapter) throw errors.unsupportedEndpoint(req.provider.id, 'videos')
  const input = await readMediaInput(req.c.req.raw, adapter.maxRequestBytes)
  let request: UpstreamRequest
  let requestModel: string
  if (input instanceof FormData) {
    requestModel = String(input.get('model') ?? '')
    if (!requestModel) throw errors.missingModel()
    if (!input.has('prompt')) throw errors.missingPrompt()
    if (adapter.transformMultipartRequest) request = await adapter.transformMultipartRequest(input, req.upstream)
    else {
      const form = new FormData()
      const fields = filterVideoParams(Object.fromEntries(input), adapter)
      for (const [key, value] of input) if (key in fields) form.append(key, value)
      request = { path: adapter.path, method: 'POST', formData: form }
    }
  } else {
    requestModel = typeof input.model === 'string' ? input.model : ''
    if (!requestModel) throw errors.missingModel()
    if (typeof input.prompt !== 'string') throw errors.missingPrompt()
    const filtered = filterVideoParams(input, adapter)
    request = adapter.transformRequest
      ? await adapter.transformRequest(filtered as VideoCreateRequest, req.upstream)
      : { path: adapter.path, method: 'POST', json: filtered }
  }
  return jsonResponse(await executeVideo(req, adapter, request, { requestModel }))
}

async function executeVideo(
  req: ApiRequestContext,
  adapter: VideoAdapter,
  request: UpstreamRequest,
  info: VideoResponseContext,
): Promise<VideoResponse> {
  const res = await callUpstream({
    ctx: req.upstream, timeoutMs: req.timeoutMs, errorContext: 'videos',
    request: { ...request, headers: new Headers(req.headers) },
  })
  const bytes = await readUpstreamBytes(req.upstream, res, 2 * 1024 * 1024, () => errors.upstreamError('Video metadata is too large.'))
  let parsed: unknown = null
  try { parsed = JSON.parse(new TextDecoder().decode(bytes)) } catch { /* 下方统一处理。 */ }
  const transformed = adapter.transformResponse
    ? await adapter.transformResponse(parsed, req.upstream, info)
    : parsed
  const video = normalizeVideoResponse(transformed, info.requestModel)
  if (!video) throw errors.upstreamError('Upstream videos returned malformed metadata.')
  return video
}

async function retrieveVideo(req: ApiRequestContext): Promise<VideoResponse> {
  const adapter = req.provider.video?.get
  if (!adapter) throw errors.unsupportedEndpoint(req.provider.id, 'videos/{video_id}')
  const videoId = req.match.videoId
  if (!videoId) throw errors.badRequest('Missing video id.', 'video_id')
  const path = adapter.path.includes('{video_id}')
    ? adapter.path.replace('{video_id}', encodeURIComponent(videoId))
    : `${adapter.path.replace(/\/+$/, '')}/${encodeURIComponent(videoId)}`
  const request = adapter.transformTaskRequest
    ? await adapter.transformTaskRequest(videoId, req.upstream)
    : { path, method: 'GET' }
  return executeVideo(req, adapter, request, { videoId })
}

/** GET /videos/{video_id} —— 每次仅查询上游，不存储任务状态。 */
export async function handleVideoTask(req: ApiRequestContext): Promise<Response> {
  return jsonResponse(await retrieveVideo(req))
}

/** GET /videos/{video_id}/content —— 有界元数据 + 无凭证流式媒体代理。 */
export async function handleVideoContent(req: ApiRequestContext): Promise<Response> {
  const adapter = req.provider.video?.content
  if (!adapter) throw errors.unsupportedEndpoint(req.provider.id, 'videos/{video_id}/content')
  const variant = req.c.req.query('variant')
  if (variant !== undefined && variant !== 'video') throw errors.badRequest('Only the video content variant is available.', 'variant')
  const range = req.c.req.header('range')?.trim()
  if (range !== undefined && !/^bytes=(?:\d+-\d*|-\d+)$/i.test(range)) {
    throw errors.badRequest('Use a single bytes range for video downloads.', 'range')
  }
  const video = await retrieveVideo(req)
  if (video.status !== 'completed') {
    throw new GatewayError(video.status === 'failed' ? 'Video generation failed.' : 'Video content is not ready.', {
      status: 409, type: 'invalid_request_error', param: 'video_id',
      code: video.status === 'failed' ? 'video_generation_failed' : 'video_not_ready',
    })
  }
  const url = adapter.resolveUrl ? adapter.resolveUrl(video) : video.url
  if (!url) throw errors.upstreamError('Completed video has no media URL.')
  const media = await callMedia(req.upstream, url, range, req.timeoutMs)
  if (!media.ok) {
    await media.body?.cancel().catch(() => {})
    const headers: Record<string, string> = {}
    for (const key of ['content-range', 'retry-after']) {
      const value = media.headers.get(key)
      if (value) headers[key] = value
    }
    throw new GatewayError(`Video download failed with status ${media.status}.`, {
      status: mapUpstreamStatus(media.status), code: 'media_download_failed', headers,
    })
  }
  const contentType = (media.headers.get('content-type') ?? 'application/octet-stream').split(';')[0].trim().toLowerCase()
  const encoded = (media.headers.get('content-encoding') ?? 'identity').trim().toLowerCase() !== 'identity'
  const safeType = /^video\/[a-z0-9.+-]+$/.test(contentType) || ['application/octet-stream', 'application/mp4', 'application/ogg'].includes(contentType)
  // 无法把压缩传输的字节范围解释为解压后媒体的 Range；同源下载也不能执行上游 HTML。
  if (!safeType || !media.body || ![200, 206].includes(media.status) || (encoded && (range !== undefined || media.status === 206))) {
    await media.body?.cancel().catch(() => {})
    throw errors.upstreamError('Upstream returned an unsafe or incompatible video download response.')
  }
  const headers = new Headers({
    'cache-control': 'private, no-store', vary: 'Origin, Authorization, Range',
    'content-type': contentType, 'content-disposition': 'attachment; filename="video.mp4"',
    'x-content-type-options': 'nosniff', 'content-security-policy': "sandbox; default-src 'none'",
  })
  // fetch 已解压正文时，压缩前的长度、范围和强 ETag 都不再描述返回的字节。
  const forwarded = encoded ? ['last-modified'] : ['content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified']
  for (const key of forwarded) {
    const value = media.headers.get(key)
    if (value) headers.set(key, value)
  }
  return new Response(media.body, { status: media.status, headers })
}

const STATUS_MAP: Record<string, VideoResponse['status']> = {
  queued: 'queued', pending: 'queued', waiting: 'queued', submitted: 'queued',
  processing: 'in_progress', running: 'in_progress', in_progress: 'in_progress', generating: 'in_progress',
  succeeded: 'completed', success: 'completed', completed: 'completed', complete: 'completed', done: 'completed',
  failed: 'failed', error: 'failed', cancelled: 'failed', canceled: 'failed',
}

export function normalizeVideoResponse(body: unknown, requestModel?: string): VideoResponse | null {
  if (typeof body === 'string') body = { id: body }
  if (!isRecord(body)) return null
  const id = firstString(body.id, body.video_id, body.task_id, body.request_id)
  if (!id) return null
  const rawStatus = firstString(body.status, body.state)?.toLowerCase() ?? ''
  const status = Object.hasOwn(STATUS_MAP, rawStatus) ? STATUS_MAP[rawStatus] : 'queued'
  const rawError = isRecord(body.error) ? body.error : null
  const url = firstString(body.url, body.video_url, body.output_url, body.result_url,
    isRecord(body.video) ? body.video.url : undefined)
  return {
    id, object: 'video',
    created_at: finite(body.created_at) ?? finite(body.created) ?? unixNow(),
    completed_at: finite(body.completed_at) ?? null,
    expires_at: finite(body.expires_at) ?? null,
    model: firstString(body.model, requestModel) ?? '', status,
    progress: Math.max(0, Math.min(100, finite(body.progress) ?? (status === 'completed' ? 100 : 0))),
    seconds: typeof body.seconds === 'string' || typeof body.seconds === 'number' ? String(body.seconds) : '',
    size: firstString(body.size) ?? '',
    prompt: typeof body.prompt === 'string' ? body.prompt : null,
    remixed_from_video_id: firstString(body.remixed_from_video_id) ?? null,
    error: rawError ? {
      message: firstString(rawError.message, rawError.msg, rawError.detail) ?? 'Video generation failed.',
      code: typeof rawError.code === 'string' || typeof rawError.code === 'number' ? String(rawError.code) : 'video_generation_failed',
      ...(typeof rawError.type === 'string' ? { type: rawError.type } : {}),
      ...(typeof rawError.param === 'string' || rawError.param === null ? { param: rawError.param } : {}),
    } : typeof body.error === 'string' ? { message: body.error, code: 'video_generation_failed' } : null,
    ...(url ? { url } : {}),
    ...(typeof body.video_id === 'string' ? { video_id: body.video_id } : {}),
    ...(typeof body.task_id === 'string' ? { task_id: body.task_id } : {}),
  }
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === 'string' && value !== '')
}

function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}
