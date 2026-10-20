import type { Provider } from './types'

/**
 * inceptionlabs-playground — Inception Labs Mercury 系列（dLLM）的 Playground 代理。
 *
 * 上游：https://web-api-proxy.inceptionlabs.ai/v1/playground
 * 协议：OpenAI 风格的子集，实测要点：
 *  - 无需鉴权（auth: 'none'，网关不转发任何客户端凭证）
 *  - 入参仅 model / messages / max_tokens / stream / reasoning_effort；
 *    其余 OpenAI 参数（temperature、stop、tools 等）上游静默忽略，不报错
 *  - 怪癖：省略 stream 字段时上游默认返回 SSE —— 非流式请求必须显式 stream:false
 *  - 出参为 OpenAI 风格 + 额外字段（tool_calls:[]、reasoning_summary、usage 细分等），
 *    由网关归一化层剥掉，无需 transformResponse
 *  - 流式响应带 [DONE]；finish_reason 可能在多个 chunk 重复；不含 usage chunk
 *  - reasoning 只体现在 usage.completion_tokens_details.reasoning_tokens，
 *    不输出 reasoning_content 文本
 *  - 错误为 FastAPI 风格（{"detail":"<嵌套JSON字符串>"} / {"detail":[...]}），
 *    由 errors.ts 归一化
 *  - 上游不支持 /models，模型列表为静态声明
 */
export const inceptionlabsPlayground: Provider = {
  id: 'inceptionlabs-playground',
  name: 'Inception Labs Playground',
  defaultBaseUrl: 'https://web-api-proxy.inceptionlabs.ai/v1',
  versionPath: '/v1',
  auth: 'none',
  models: [
    { id: 'mercury-2', ownedBy: 'inceptionlabs' },
    { id: 'mercury-2.5', ownedBy: 'inceptionlabs' },
    { id: 'mercury-3', ownedBy: 'inceptionlabs' },
  ],
  chat: {
    path: '/playground',
    supportsStreaming: true,
    supportsNonStreaming: true,
    // 实测上游静默忽略的参数：白名单放行了但对该上游无意义，主动丢弃
    unsupportedParams: [
      'frequency_penalty',
      'logit_bias',
      'logprobs',
      'top_logprobs',
      'max_completion_tokens',
      'n',
      'presence_penalty',
      'response_format',
      'seed',
      'stop',
      'stream_options',
      'temperature',
      'tools',
      'tool_choice',
      'parallel_tool_calls',
      'top_p',
      'user',
    ],
    transformRequest: (body) => {
      const out = { ...(body as unknown as Record<string, unknown>) }
      // 上游省略 stream 时默认流式返回：非流式请求必须显式 stream:false
      if (out.stream !== true) out.stream = false
      return out
    },
  },
}
