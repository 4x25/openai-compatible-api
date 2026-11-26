import { PASSTHROUGH_PROVIDER_ID } from './ids'
import type { Provider } from './types'

/**
 * `_` — 完全透传调试供应商。
 *
 * 目标地址取 `/_` 之后的全部路径与查询串：
 *  - `/_/https://upstream.example/v1/chat/completions` → 原样转发到该 URL
 *  - `/_/https://upstream.example/any/path?x=1`        → 任意路径、任意方法
 *  - `/_/v1/chat/completions`                          → 拼到 `__BASE_URL`（默认 OpenAI）
 *
 * 不解析请求体、不校验参数、不转换认证头，也不抹平错误 / JSON / SSE：
 * 上游状态码、响应头和正文原样返回，仅修正 fetch 自动解压造成的编码头不一致。
 */
export const passthrough: Provider = {
  id: PASSTHROUGH_PROVIDER_ID,
  name: 'Raw Passthrough',
  defaultBaseUrl: 'https://api.openai.com/v1',
  versionPath: '/v1',
  models: [],
  passthrough: true,
  pinned: true,
}
