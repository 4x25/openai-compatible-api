import { GatewayError, gatewayErrorBody } from './errors'
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
