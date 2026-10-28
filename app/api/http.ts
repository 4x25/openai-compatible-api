import { errors, GatewayError, gatewayErrorBody } from './errors'
import type { OpenAiErrorResponse } from './types'

export function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  })
}

export function errorResponse(
  body: OpenAiErrorResponse,
  status: number,
  headers: Record<string, string> = {},
): Response {
  return jsonResponse(body, status, headers)
}

export function gatewayErrorResponse(e: GatewayError, headers: Record<string, string> = {}): Response {
  return jsonResponse(gatewayErrorBody(e), e.status, { ...e.headers, ...headers })
}

export function internalErrorResponse(message = 'The gateway encountered an internal error.'): Response {
  return jsonResponse(
    {
      error: {
        message,
        type: 'api_error',
        param: null,
        code: 'internal_error',
      },
    },
    500,
  )
}

export function sseResponse(stream: ReadableStream<Uint8Array>): Response {
  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    },
  })
}

export function streamFromSyncGenerator(gen: Generator<Uint8Array>): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      try {
        for (const chunk of gen) controller.enqueue(chunk)
        controller.close()
      } catch (e) {
        controller.error(e)
      }
    },
  })
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function unixNow(): number {
  return Math.floor(Date.now() / 1000)
}

/** Web 标准的二进制编码，按小块处理以避免 spread 超出参数上限。 */
export function bytesToBase64(bytes: Uint8Array): string {
  const chunks: string[] = []
  for (let i = 0; i < bytes.length; i += 0x8000) {
    chunks.push(String.fromCharCode(...bytes.subarray(i, i + 0x8000)))
  }
  return btoa(chunks.join(''))
}

/** 有界读取；越界或读取失败时取消流并释放锁。 */
export async function readBytes(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
  tooLarge: () => Error,
): Promise<Uint8Array<ArrayBuffer>> {
  if (!body) return new Uint8Array()
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      length += value.byteLength
      if (length > maxBytes) throw tooLarge()
      chunks.push(value)
    }
  } catch (error) {
    await reader.cancel().catch(() => {})
    throw error
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.length
  }
  return bytes
}

/** 媒体请求有界解析，限制在 multipart 展开和 Base64 编码之前生效。 */
export async function readMediaInput(request: Request, maxBytes = Infinity): Promise<Record<string, unknown> | FormData> {
  const bytes = await readBytes(request.body, maxBytes, () => new GatewayError('Request body is too large.', {
    status: 413, type: 'invalid_request_error', code: 'request_too_large',
  }))
  if ((request.headers.get('content-type') ?? '').toLowerCase().includes('multipart/form-data')) {
    try {
      return await new Response(bytes, { headers: request.headers }).formData()
    } catch {
      throw errors.badRequest('Invalid multipart/form-data body.')
    }
  }
  try {
    const body: unknown = JSON.parse(new TextDecoder().decode(bytes))
    if (isRecord(body)) return body
  } catch {
    // 统一为网关的 JSON 参数错误。
  }
  throw errors.invalidJson()
}
