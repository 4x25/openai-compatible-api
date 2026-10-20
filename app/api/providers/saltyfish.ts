import type { Provider } from './types'

/**
 * saltyfish — 首个供应商。
 *
 * 上游：https://ai.saltyfish.live/v1
 * 协议：OpenAI compatible（含 reasoning_content 扩展字段）
 * 能力：/models、/chat/completions（流式 + 非流式）
 * 说明：上游会返回字符画等“乱回文字”内容，属于正常行为，网关不做内容处理。
 */
export const saltyfish: Provider = {
  id: 'saltyfish',
  name: 'SaltyFish',
  defaultBaseUrl: 'https://ai.saltyfish.live/v1',
  versionPath: '/v1',
  models: [
    { id: 'claude-fable-5-1', ownedBy: 'anthropic' },
    { id: 'claude-opus-5-5', ownedBy: 'anthropic' },
    { id: 'gpt-6-astra', ownedBy: 'openai' },
  ],
  auth: {
    // 标准 Authorization: Bearer 透传，无需转换
  },
  chat: {
    path: '/chat/completions',
    supportsStreaming: true,
    supportsNonStreaming: true,
  },
}
