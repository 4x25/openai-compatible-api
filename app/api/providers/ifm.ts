import { GatewayError } from '../errors'
import { isRecord } from '../http'
import type { ChatRequestMessage } from '../types'
import type { Provider } from './types'

function invalidParameter(message: string, param: string): never {
  throw new GatewayError(message, {
    status: 400,
    type: 'invalid_request_error',
    code: 'invalid_parameter',
    param,
  })
}

/** 空字符串也是有效的推理历史；canonical 字段优先于旧别名。 */
function reasoningText(message: Record<string, unknown>): string | undefined {
  if (typeof message.reasoning_content === 'string') return message.reasoning_content
  if (typeof message.reasoning === 'string') return message.reasoning
  return undefined
}

function transformMessage(raw: ChatRequestMessage, index: number): Record<string, unknown> {
  const param = `messages.${index}`
  if (!isRecord(raw)) invalidParameter('Each message must be an object.', param)
  const message: Record<string, unknown> = { ...raw }
  if (message.role === 'developer') message.role = 'system'
  if (typeof message.role !== 'string' || !['system', 'user', 'assistant', 'tool'].includes(message.role)) {
    invalidParameter('Invalid message role for IFM.', `${param}.role`)
  }

  const content = message.content
  if (Array.isArray(content)) {
    message.content = content.map((part: unknown, partIndex: number) => {
      const partParam = `${param}.content.${partIndex}`
      if (!isRecord(part) || part.type !== 'text') {
        invalidParameter('IFM chat messages require text content parts.', partParam)
      }
      if (typeof part.text !== 'string') {
        invalidParameter('Text content must be a string.', `${partParam}.text`)
      }
      return part.text
    }).join('')
  } else if (typeof content !== 'string') {
    const toolTurn = message.role === 'assistant'
      && Array.isArray(message.tool_calls) && message.tool_calls.length > 0
    if (toolTurn && (content === null || content === undefined)) message.content = ''
    else invalidParameter('Message content must be a string or text parts.', `${param}.content`)
  }

  if (message.role === 'assistant') {
    const reasoning = reasoningText(message) ?? ''
    // IFM 多后端分别读取不同别名；统一发送，不存储或重建缺失的推理。
    message.reasoning_content = reasoning
    message.reasoning = reasoning
  }
  return message
}

function normalizeReasoning(raw: Record<string, unknown>): Record<string, unknown> {
  const out = { ...raw }
  const reasoning = reasoningText(raw)
  delete out.reasoning
  if (reasoning !== undefined) out.reasoning_content = reasoning
  return out
}

function transformChoices(raw: unknown, field: 'message' | 'delta'): unknown {
  if (!isRecord(raw) || !Array.isArray(raw.choices)) return raw
  return {
    ...raw,
    choices: raw.choices.map((choice: unknown) => {
      if (!isRecord(choice) || !isRecord(choice[field])) return choice
      const message = normalizeReasoning(choice[field])
      if (field === 'message' && message.content === undefined
        && Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
        message.content = null
      }
      return { ...choice, [field]: message }
    }),
  }
}

/** IFM Chat Completions：消息限制及多后端推理别名适配。 */
export const ifm: Provider = {
  id: 'ifm',
  name: 'IFM',
  defaultBaseUrl: 'https://api.ifm.ai/v1',
  versionPath: '/v1',
  models: [
    { id: 'IFM/K2-Horizon-375B-A23B', ownedBy: 'MBZUAI' },
    { id: 'IFM/Jais-3-MoVA-36B-A4B', ownedBy: 'MBZUAI' },
  ],
  chat: {
    path: '/chat/completions',
    supportsStreaming: true,
    supportsNonStreaming: true,
    transformRequest: (req) => {
      if (req.n !== undefined && req.n !== null && req.n !== 1) {
        invalidParameter('IFM supports only n=1.', 'n')
      }
      return { ...req, messages: req.messages.map(transformMessage) }
    },
    transformResponse: (res) => transformChoices(res, 'message'),
    transformStreamChunk: (chunk) => transformChoices(chunk, 'delta'),
  },
}
