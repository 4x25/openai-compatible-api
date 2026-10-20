import { filterVideoParams } from '../params'
import type { VideoGenerationRequest, VideoGenerationResponse } from '../types'
import { errors } from '../errors'
import { isRecord, jsonResponse, unixNow } from '../http'
import { callUpstream, parseJsonBody } from '../upstream'
import type { ApiRequestContext } from './types'
import type { UpstreamRequest, VideoAdapter } from '../providers/types'

/** POST /video/generations —— 创建视频生成任务 */
export async function handleVideoCreate(req: ApiRequestContext): Promise<Response> {
  const { c, provider, upstream, timeoutMs } = req
  const adapter: VideoAdapter | undefined = provider.video?.create
  if (!adapter) throw errors.unsupportedEndpoint(provider.id, 'video/generations')

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

  const filtered = filterVideoParams(body, adapter)
  let upstreamRequest: UpstreamRequest = {
    path: adapter.path,
    method: 'POST',
    json: filtered,
  }
  if (adapter.transformRequest) {
    const transformed = await adapter.transformRequest(filtered as unknown as VideoGenerationRequest, upstream)
    upstreamRequest = transformed
  }

  const headers = new Headers(req.headers)
  const res = await callUpstream({
    ctx: upstream,
    timeoutMs,
    errorContext: 'video/generations',
    request: { ...upstreamRequest, headers },
  })

  const parsed = await parseJsonBody(res)
  const transformedResponse = adapter.transformResponse
    ? (await adapter.transformResponse(parsed, upstream)) ?? parsed
    : parsed
  const normalized = normalizeVideoResponse(transformedResponse, requestModel)
  if (!normalized) {
    throw errors.upstreamError('Upstream video/generations returned a malformed response.')
  }
  return jsonResponse(normalized)
}

/** GET /video/generations/{task_id} —— 查询任务状态 */
export async function handleVideoTask(req: ApiRequestContext): Promise<Response> {
  const { provider, upstream, timeoutMs, match } = req
  const adapter: VideoAdapter | undefined = provider.video?.get
  if (!adapter) throw errors.unsupportedEndpoint(provider.id, 'video/generations/{task_id}')

  const taskId = match.taskId
  if (!taskId) throw errors.badRequest('Missing video task id.')

  const path = adapter.path.includes('{task_id}')
    ? adapter.path.replace('{task_id}', encodeURIComponent(taskId))
    : `${adapter.path.replace(/\/+$/, '')}/${encodeURIComponent(taskId)}`

  const headers = new Headers(req.headers)
  const res = await callUpstream({
    ctx: upstream,
    timeoutMs,
    errorContext: 'video/generations/{task_id}',
    request: { path, method: 'GET', headers },
  })

  const parsed = await parseJsonBody(res)
  const transformedResponse = adapter.transformResponse
    ? (await adapter.transformResponse(parsed, upstream)) ?? parsed
    : parsed
  const normalized = normalizeVideoResponse(transformedResponse, undefined)
  if (!normalized) {
    throw errors.upstreamError('Upstream video/generations/{task_id} returned a malformed response.')
  }
  return jsonResponse(normalized)
}

// ---------------------------------------------------------------------------
// 归一化
// ---------------------------------------------------------------------------

const STATUS_MAP: Record<string, VideoGenerationResponse['status']> = {
  queued: 'queued',
  pending: 'queued',
  waiting: 'queued',
  submitted: 'queued',
  processing: 'in_progress',
  running: 'in_progress',
  in_progress: 'in_progress',
  generating: 'in_progress',
  succeeded: 'succeeded',
  success: 'succeeded',
  completed: 'succeeded',
  complete: 'succeeded',
  done: 'succeeded',
  failed: 'failed',
  error: 'failed',
  cancelled: 'failed',
  canceled: 'failed',
}

export function normalizeVideoResponse(
  body: unknown,
  requestModel?: string,
): VideoGenerationResponse | null {
  if (typeof body === 'string') {
    return {
      id: body,
      object: 'video.generation',
      created: unixNow(),
      model: requestModel ?? '',
      status: 'queued',
    }
  }
  if (!isRecord(body)) return null

  const id = firstString(body.id, body.task_id, body.request_id, body.video_id)
  if (!id) return null

  const rawStatus = firstString(body.status, body.state)
  const status = STATUS_MAP[rawStatus?.toLowerCase() ?? ''] ?? 'queued'

  const videoUrl = firstString(body.url, body.video_url, body.output_url, body.result_url)
  let video: VideoGenerationResponse['video'] = null
  if (videoUrl) {
    video = { url: videoUrl }
  } else if (isRecord(body.video)) {
    video = body.video as { url?: string }
  } else if (Array.isArray(body.data) && isRecord(body.data[0])) {
    const first = body.data[0]
    if (typeof first.url === 'string') video = { url: first.url }
  }

  const rawError = isRecord(body.error) ? body.error : null
  const error = rawError
    ? {
        message: firstString(rawError.message, rawError.msg, rawError.detail) ?? 'Video generation failed.',
        type: firstString(rawError.type, rawError.error_type) ?? 'api_error',
        param: (rawError.param as string | null) ?? null,
        code: (rawError.code as string | number | null) ?? null,
      }
    : null

  return {
    id,
    object: 'video.generation',
    created: typeof body.created === 'number' ? body.created : typeof body.created_at === 'number' ? body.created_at : unixNow(),
    model: firstString(body.model, requestModel) ?? '',
    status,
    ...(video ? { video } : {}),
    ...(error ? { error } : {}),
  }
}

function firstString(...values: unknown[]): string | undefined {
  for (const v of values) {
    if (typeof v === 'string' && v !== '') return v
  }
  return undefined
}
