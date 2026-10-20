import { jsonResponse, isRecord } from '../http'
import type { ProviderCallContext } from '../providers/types'
import { callUpstream, parseJsonBody } from '../upstream'
import { errors } from '../errors'
import type { ApiRequestContext } from './types'
import type { ModelListResponse } from '../types'

export async function handleModels(req: ApiRequestContext): Promise<Response> {
  const { provider, upstream, timeoutMs } = req

  let models
  if (Array.isArray(provider.models)) {
    models = provider.models
  } else {
    const ctx: ProviderCallContext = upstream
    models = await provider.models(ctx)
  }

  if (!Array.isArray(models)) {
    throw errors.upstreamError('Provider model list function returned a non-array value.')
  }

  const body: ModelListResponse = {
    object: 'list',
    data: models
      .filter((m) => isRecord(m) && typeof m.id === 'string')
      .map((m) => ({
        id: (m as { id: string }).id,
        object: 'model' as const,
        created: typeof m.created === 'number' ? m.created : 0,
        owned_by: typeof m.ownedBy === 'string' ? m.ownedBy : 'provider',
      })),
  }
  return jsonResponse(body)
}

/** 动态模型列表示例：供 models 为函数的供应商复用（拉取上游 /models 并归一化） */
export async function fetchUpstreamModels(
  upstream: ProviderCallContext,
  path = '/models',
  timeoutMs = 60_000,
): Promise<ModelListResponse['data']> {
  const res = await callUpstream({
    ctx: upstream,
    timeoutMs,
    errorContext: 'models',
    request: { path, method: 'GET', headers: { accept: 'application/json' } },
  })
  const parsed = await parseJsonBody(res)
  if (!isRecord(parsed) || !Array.isArray(parsed.data)) {
    throw errors.upstreamError('Upstream /models returned a malformed response.')
  }
  return parsed.data
    .filter((m): m is Record<string, unknown> => isRecord(m) && typeof m.id === 'string')
    .map((m) => ({
      id: m.id as string,
      object: 'model' as const,
      created: typeof m.created === 'number' ? m.created : 0,
      owned_by: typeof m.owned_by === 'string' ? m.owned_by : 'provider',
    }))
}
