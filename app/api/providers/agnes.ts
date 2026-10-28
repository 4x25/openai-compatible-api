import { errors, GatewayError } from '../errors'
import { bytesToBase64, isRecord } from '../http'
import type { ChatCompletionRequest, ChatRequestMessage, ImageGenerationRequest, VideoCreateRequest } from '../types'
import type { ImageAdapter, Provider, ProviderCallContext, UpstreamRequest, VideoResponseContext } from './types'

const VIDEO_MODEL = 'agnes-video-2.5-flash'
const MIB = 1024 * 1024
const MAX_REQUEST_BYTES = 50 * MIB
const MAX_FILE_BYTES = 20 * MIB
const MAX_IMAGE_FILES = 16

function invalid(message: string, param: string): never {
  throw new GatewayError(message, { status: 400, type: 'invalid_request_error', code: 'invalid_parameter', param })
}

function text(value: unknown, param: string): string {
  if (typeof value !== 'string' || !value.trim()) invalid(`${param} must be a non-empty string.`, param)
  return value
}

function optionalText(value: unknown, param: string): string | undefined {
  return value === undefined ? undefined : text(value, param)
}

function optionalObject(value: unknown, param: string): Record<string, unknown> | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value)) invalid(`${param} must be an object.`, param)
  return value
}

function integer(value: unknown, param: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) invalid(`${param} must be an integer.`, param)
  return value
}

// ---------------------------------------------------------------------------
// Chat Completions
// ---------------------------------------------------------------------------

function chatContent(value: unknown, param: string): string | Record<string, unknown>[] {
  if (typeof value === 'string') return value
  if (!Array.isArray(value) || value.length === 0) invalid(`${param} must be text or a non-empty content array.`, param)
  const parts: Record<string, unknown>[] = []
  for (const [index, part] of value.entries()) {
    const path = `${param}.${index}`
    if (!isRecord(part) || typeof part.type !== 'string') invalid(`${path} must be a typed content block.`, path)
    if (part.type === 'text') {
      if (typeof part.text !== 'string') invalid(`${path}.text must be a string.`, `${path}.text`)
      parts.push({ type: 'text', text: part.text })
    } else if (part.type === 'image_url') {
      const url = typeof part.image_url === 'string' ? part.image_url
        : isRecord(part.image_url) ? part.image_url.url : undefined
      parts.push({ type: 'image_url', image_url: { url: text(url, `${path}.image_url`) } })
    }
  }
  if (parts.length === 0) invalid(`${param} contains no text or image content.`, param)
  return parts
}

function chatMessage(raw: ChatRequestMessage, index: number): Record<string, unknown> {
  const param = `messages.${index}`
  if (!isRecord(raw)) invalid('Each message must be an object.', param)
  const role = raw.role === 'developer' ? 'system' : raw.role
  if (!['system', 'user', 'assistant', 'tool'].includes(role)) invalid('Invalid Agnes message role.', `${param}.role`)
  if (role === 'tool') {
    const content = Array.isArray(raw.content) ? raw.content.map((part, partIndex) => {
      const path = `${param}.content.${partIndex}`
      if (!isRecord(part) || part.type !== 'text' || typeof part.text !== 'string') invalid('Tool content blocks must contain text.', path)
      return part.text
    }).join('') : raw.content
    if (typeof content !== 'string') invalid('Tool content must be a string or text blocks.', `${param}.content`)
    return { role, content, tool_call_id: text(raw.tool_call_id, `${param}.tool_call_id`) }
  }
  const message: Record<string, unknown> = { role }
  if (role === 'assistant' && raw.tool_calls !== undefined) {
    if (!Array.isArray(raw.tool_calls)) invalid('tool_calls must be an array.', `${param}.tool_calls`)
    if (raw.tool_calls.length > 0) {
      message.tool_calls = raw.tool_calls.map((call, callIndex) => {
        const path = `${param}.tool_calls.${callIndex}`
        if (!isRecord(call)) invalid('Tool call must be an object.', path)
        if (call.type !== 'function') invalid('Tool call type must be function.', `${path}.type`)
        if (!isRecord(call.function)) invalid('Tool function must be an object.', `${path}.function`)
        if (typeof call.function.arguments !== 'string') invalid('Tool arguments must be a string.', `${path}.function.arguments`)
        return {
          id: text(call.id, `${path}.id`), type: 'function',
          function: { name: text(call.function.name, `${path}.function.name`), arguments: call.function.arguments },
        }
      })
    }
  }
  message.content = message.tool_calls && (raw.content === null || raw.content === undefined)
    ? null : chatContent(raw.content, `${param}.content`)
  return message
}

function chatRequest(req: ChatCompletionRequest): Record<string, unknown> {
  if (req.messages.length === 0) invalid('messages must not be empty.', 'messages')
  const body: Record<string, unknown> = {
    model: text(req.model, 'model'), messages: req.messages.map(chatMessage), stream: req.stream === true,
  }
  for (const name of ['temperature', 'top_p'] as const) {
    const value = req[name]
    if (value === undefined) continue
    if (typeof value !== 'number' || !Number.isFinite(value)) invalid(`${name} must be a finite number.`, name)
    body[name] = value
  }
  const tokenParam = req.max_completion_tokens !== undefined ? 'max_completion_tokens' : 'max_tokens'
  if (req[tokenParam] !== undefined) {
    const maxTokens = integer(req[tokenParam], tokenParam)
    if (maxTokens <= 0) invalid('Token limit must be positive.', tokenParam)
    body.max_tokens = maxTokens
  }
  if (req.tools !== undefined) {
    if (!Array.isArray(req.tools)) invalid('tools must be an array.', 'tools')
    body.tools = req.tools
  }
  if (req.tool_choice !== undefined) {
    if (typeof req.tool_choice !== 'string' && !isRecord(req.tool_choice)) invalid('tool_choice must be a string or object.', 'tool_choice')
    body.tool_choice = req.tool_choice
  }
  const extensions = req as ChatCompletionRequest & { chat_template_kwargs?: unknown }
  const template = optionalObject(extensions.chat_template_kwargs, 'chat_template_kwargs')
  if (template) body.chat_template_kwargs = { ...template }
  if (req.reasoning_effort !== undefined) {
    if (typeof req.reasoning_effort !== 'string') invalid('reasoning_effort must be a string.', 'reasoning_effort')
    body.chat_template_kwargs = { ...template, enable_thinking: req.reasoning_effort !== 'none' }
  }
  if (req.stream_options !== undefined) body.stream_options = req.stream_options
  return body
}

function chatResponse(raw: unknown): unknown {
  if (!isRecord(raw) || !Array.isArray(raw.choices)) return raw
  return {
    ...raw,
    choices: raw.choices.map((choice: unknown) => {
      if (!isRecord(choice) || !isRecord(choice.message)) return choice
      const message = { ...choice.message }
      if (message.content === undefined && Array.isArray(message.tool_calls) && message.tool_calls.length) message.content = null
      return { ...choice, message }
    }),
  }
}

// ---------------------------------------------------------------------------
// Images / multipart
// ---------------------------------------------------------------------------

function tooManyFiles(param: string): never {
  throw new GatewayError(`At most ${MAX_IMAGE_FILES} image files are accepted.`, {
    status: 413, type: 'invalid_request_error', code: 'too_many_files', param,
  })
}

async function fileReference(value: FormDataEntryValue, param: string): Promise<string> {
  if (typeof value === 'string') return text(value, param)
  if (value.size > MAX_FILE_BYTES) {
    throw new GatewayError('Image file is too large.', { status: 413, type: 'invalid_request_error', code: 'file_too_large', param })
  }
  let mime = value.type.toLowerCase()
  if (mime && mime !== 'application/octet-stream' && !mime.startsWith('image/')) invalid('Expected an image file.', param)
  const bytes = new Uint8Array(await value.arrayBuffer())
  if (!mime || mime === 'application/octet-stream') {
    mime = imageMime(bytes) ?? ''
    if (!mime) invalid('Uploaded file must contain a recognized image.', param)
  }
  return `data:${mime};base64,${bytesToBase64(bytes)}`
}

/** SDK 文件流常省略 MIME；只从常见光栅图的文件签名识别，不使用扩展名猜测。 */
function imageMime(bytes: Uint8Array): string | undefined {
  const starts = (signature: number[], offset = 0) => signature.every((value, index) => bytes[offset + index] === value)
  if (bytes.length >= 24 && starts([137, 80, 78, 71, 13, 10, 26, 10]) && starts([73, 72, 68, 82], 12)) return 'image/png'
  if (bytes.length >= 4 && starts([255, 216, 255])) return 'image/jpeg'
  if (bytes.length >= 10 && (starts([71, 73, 70, 56, 55, 97]) || starts([71, 73, 70, 56, 57, 97]))) return 'image/gif'
  if (bytes.length >= 16 && starts([82, 73, 70, 70]) && starts([87, 69, 66, 80], 8)) return 'image/webp'
  return undefined
}

function stringArray(value: unknown, param: string): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) invalid(`${param} must be an array.`, param)
  return value.map((item, index) => text(item, `${param}.${index}`))
}

function imageReferences(value: unknown, param: string): string[] {
  if (value === undefined) return []
  return (Array.isArray(value) ? value : [value]).flatMap((item, index) => {
    const path = `${param}.${index}`
    if (typeof item === 'string') return [text(item, path)]
    if (!isRecord(item)) invalid('Expected an image URL, Data URI or reference object.', path)
    const url = typeof item.image_url === 'string' ? item.image_url
      : isRecord(item.image_url) ? item.image_url.url : undefined
    if (url !== undefined) return [text(url, `${path}.image_url`)]
    if (item.file_id !== undefined) return []
    invalid('Image reference must contain image_url.', path)
  })
}

type FormNode = Record<string, unknown> | unknown[]

function formScalar(name: string, value: string, hasResponseFormat: boolean): unknown {
  if (['n', 'seed'].includes(name)) return Number(value)
  if (['start_seconds', 'require_audio'].includes(name)) {
    try { return JSON.parse(value) } catch { invalid(`${name} must contain a JSON scalar.`, name) }
  }
  if (['extra_body', 'images', 'audios', 'videos'].includes(name)) {
    try { return JSON.parse(value) } catch { invalid(`${name} must contain valid JSON.`, name) }
  }
  if (name === 'return_base64' && !hasResponseFormat) {
    if (value !== 'true' && value !== 'false') invalid('return_base64 must be a boolean.', name)
    return value === 'true'
  }
  return value
}

function hasFormValue(node: unknown, keys: string[]): boolean {
  if (keys.length === 0) return node !== undefined
  if (!isRecord(node) && !Array.isArray(node)) return true
  if (keys[0] === '') return false
  return Object.hasOwn(node, keys[0]) && hasFormValue((node as Record<string, unknown>)[keys[0]], keys.slice(1))
}

/** 只重建已放行的根字段，阻止危险键、稀疏大索引和互相覆盖的结构。 */
function setFormValue(node: FormNode, keys: string[], value: unknown, param: string): void {
  const [key, ...rest] = keys
  const arrayChild = rest[0] === '' || /^\d+$/.test(rest[0] ?? '')
  if (key === '') {
    if (!Array.isArray(node)) invalid('Conflicting multipart field structure.', param)
    if (rest.length === 0) node.push(value)
    else {
      let child = node.at(-1)
      if (child === undefined || hasFormValue(child, rest)) {
        child = arrayChild ? [] : {}
        node.push(child)
      }
      setFormValue(child as FormNode, rest, value, param)
    }
    if (node.length > 32) invalid('Too many multipart array values.', param)
    return
  }
  if (Array.isArray(node) && (!/^\d+$/.test(key) || Number(key) > 31)) invalid('Invalid multipart array index.', param)
  const target = node as Record<string, unknown>
  if (rest.length === 0) {
    if (Object.hasOwn(target, key)) invalid('Duplicate multipart field.', param)
    target[key] = value
  } else {
    if (!Object.hasOwn(target, key)) target[key] = arrayChild ? [] : {}
    const child = target[key]
    if (!(arrayChild ? Array.isArray(child) : isRecord(child))) invalid('Conflicting multipart field structure.', param)
    setFormValue(child as FormNode, rest, value, param)
  }
}

function formFields(form: FormData, allowed: Set<string>, repeatedFields: string[] = []): Record<string, unknown> {
  const body: Record<string, unknown> = {}
  const seen = new Set<string>()
  for (const [name, value] of form) {
    if (!allowed.has(name) || repeatedFields.includes(name)) continue
    if (seen.has(name)) invalid('Duplicate multipart scalar field.', name)
    seen.add(name)
    if (typeof value !== 'string') {
      if (name === 'input_reference') continue
      invalid('Multipart scalar field must be text.', name)
    }
    body[name] = formScalar(name, value, form.has('response_format'))
  }
  for (const [name, value] of form) {
    if (allowed.has(name) || !name.includes('[')) continue
    const root = name.split('[')[0]
    // 这两个输入由文件适配器单独处理；完整 JSON 根字段优先于括号表示。
    if (!allowed.has(root) || ['image', 'input_reference'].includes(root) || form.has(root)) continue
    if (!/^[^\[\]]+(?:\[[^\[\]]*\])+$/.test(name)) invalid('Invalid multipart field name.', root)
    const keys = [root, ...Array.from(name.matchAll(/\[([^\]]*)\]/g), (match) => match[1])]
    if (keys.length > 6 || keys.some((key) => ['__proto__', 'constructor', 'prototype'].includes(key))) invalid('Invalid multipart field path.', root)
    if (typeof value !== 'string') invalid('Use the image upload field for files.', root)
    const leaf = keys.at(-1) ?? ''
    const parsed = leaf === '' ? value : formScalar(leaf, value, form.has('response_format'))
    setFormValue(body, keys, parsed, root)
  }
  return body
}

const IMAGE_FIELDS = new Set(['model', 'prompt', 'size', 'n', 'response_format', 'ratio', 'return_base64', 'extra_body', 'image', 'image[]', 'images'])

function imageRequests(req: ImageGenerationRequest, edit: boolean): UpstreamRequest[] {
  const body: Record<string, unknown> = {
    model: text(req.model, 'model'), prompt: text(req.prompt, 'prompt'),
    size: optionalText(req.size, 'size') ?? '1024x1024',
  }
  const ratio = optionalText(req.ratio, 'ratio')
  if (ratio !== undefined) body.ratio = ratio
  const extra = { ...optionalObject(req.extra_body, 'extra_body') }
  if (edit) {
    const source = req.images !== undefined ? req.images : req.image !== undefined ? req.image : extra.image
    const images = imageReferences(source, req.images !== undefined ? 'images' : req.image !== undefined ? 'image' : 'extra_body.image')
    if (images.length === 0) invalid('At least one input image is required.', 'image')
    if (images.length > MAX_IMAGE_FILES) tooManyFiles('image')
    extra.image = images
  }
  if (req.response_format !== undefined) {
    if (!['url', 'b64_json'].includes(req.response_format)) invalid('response_format must be url or b64_json.', 'response_format')
    // 使用已验证的输出格式控制，标准字段优先于供应商扩展。
    extra.response_format = req.response_format
  } else if (req.return_base64 !== undefined) {
    if (typeof req.return_base64 !== 'boolean') invalid('return_base64 must be a boolean.', 'return_base64')
    body.return_base64 = req.return_base64
  }
  if (Object.keys(extra).length > 0) body.extra_body = extra
  const n = req.n === undefined ? 1 : integer(req.n, 'n')
  if (n < 1 || n > 10) invalid('n must be an integer from 1 to 10.', 'n')
  return Array.from({ length: n }, () => ({ path: '/images/generations', method: 'POST', json: body }))
}

async function imageFormRequests(form: FormData, edit: boolean): Promise<UpstreamRequest[]> {
  const body = formFields(form, IMAGE_FIELDS, ['image', 'image[]'])
  if (edit) {
    const entries = [...form.getAll('image'), ...form.getAll('image[]')]
    if (entries.length > MAX_IMAGE_FILES) tooManyFiles('image')
    if (entries.length) {
      body.images = [
        ...await Promise.all(entries.map((value, index) => fileReference(value, `image.${index}`))),
        ...imageReferences(body.images, 'images'),
      ]
    }
  }
  return imageRequests(body as ImageGenerationRequest, edit)
}

function imageAdapter(edit: boolean): ImageAdapter {
  return {
    path: '/images/generations',
    extraParams: ['ratio', 'return_base64', 'extra_body', ...(edit ? ['image', 'image[]', 'images'] : [])],
    unsupportedParams: ['quality', 'style', 'user'],
    maxRequestBytes: MAX_REQUEST_BYTES, maxResponseBytes: 64 * MIB,
    transformRequest: (req) => imageRequests(req, edit),
    transformMultipartRequest: (form) => imageFormRequests(form, edit),
  }
}

// ---------------------------------------------------------------------------
// Videos
// ---------------------------------------------------------------------------

const VIDEO_FIELDS = new Set(['model', 'prompt', 'seconds', 'size', 'input_reference', 'input_reference[image_url]',
  'input_reference[file_id]', 'image', 'mode', 'aspect_ratio', 'seed', 'n', 'first_frame', 'last_frame', 'images', 'audios', 'videos', 'extra_body'])
const VIDEO_RATIOS = new Set(['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'])
const VIDEO_PIXEL_RATIOS: Record<string, string> = {
  '720x1280': '9:16', '1280x720': '16:9', '1024x1792': '9:16', '1792x1024': '16:9',
}
const VIDEO_MODE_ALIASES: Record<string, string> = { keyframes: 'keyframe', ti2vid: 'keyframe', i2vid: 'keyframe', multi_reference: 'reference' }

function videoReference(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value === 'string') return text(value, 'input_reference')
  if (!isRecord(value)) invalid('input_reference must be an image reference.', 'input_reference')
  if (value.image_url !== undefined) {
    return text(isRecord(value.image_url) ? value.image_url.url : value.image_url, 'input_reference.image_url')
  }
  // Agnes 没有文件 ID 查询能力，不能静默退化成文生视频。
  invalid('input_reference requires an image URL or uploaded image.', 'input_reference')
}

function videoRequest(req: VideoCreateRequest): UpstreamRequest {
  const source: Record<string, unknown> = { ...req }
  const extra = optionalObject(req.extra_body, 'extra_body')
  for (const [name, value] of Object.entries(extra ?? {})) {
    if (VIDEO_FIELDS.has(name) && !['model', 'prompt', 'extra_body'].includes(name) && source[name] === undefined) source[name] = value
  }
  const model = text(req.model, 'model')
  if (model !== VIDEO_MODEL) invalid(`Video model must be ${VIDEO_MODEL}.`, 'model')
  const rawSeconds = source.seconds === undefined ? 4 : source.seconds
  const seconds = typeof rawSeconds === 'string' && rawSeconds.trim() ? Number(rawSeconds) : rawSeconds
  if (typeof seconds !== 'number' || !Number.isInteger(seconds) || seconds < 4 || seconds > 12) invalid('seconds must be an integer from 4 to 12.', 'seconds')
  const inputSize = optionalText(source.size, 'size')
  const explicitRatio = optionalText(source.aspect_ratio, 'aspect_ratio')
  if (explicitRatio !== undefined && !VIDEO_RATIOS.has(explicitRatio)) invalid('Invalid video aspect_ratio.', 'aspect_ratio')
  const mappedRatio = inputSize !== undefined && Object.hasOwn(VIDEO_PIXEL_RATIOS, inputSize) ? VIDEO_PIXEL_RATIOS[inputSize] : undefined
  if (inputSize !== undefined && inputSize !== '720P' && !mappedRatio) invalid('Flash size must be 720P or a supported OpenAI pixel size.', 'size')
  const aspectRatio = mappedRatio ?? explicitRatio ?? (inputSize === undefined ? '9:16' : '16:9')
  const firstFrame = source.input_reference !== undefined ? videoReference(source.input_reference)
    : optionalText(source.first_frame !== undefined ? source.first_frame : source.image, 'first_frame')
  const lastFrame = optionalText(source.last_frame, 'last_frame')
  const images = stringArray(source.images, 'images')
  const audios = stringArray(source.audios, 'audios')
  if (images.length > 5) invalid('Flash images length must not exceed 5.', 'images')
  if (audios.length > 3) invalid('Flash audios length must not exceed 3.', 'audios')
  if (source.videos !== undefined && (!Array.isArray(source.videos) || source.videos.length > 0)) invalid('Flash reference video input is unavailable.', 'videos')
  if (source.n !== undefined && integer(source.n, 'n') !== 1) invalid('Video generation requires n=1.', 'n')
  const hasKeyframes = firstFrame !== undefined || lastFrame !== undefined
  const hasReferences = images.length > 0 || audios.length > 0
  const rawMode = optionalText(source.mode, 'mode')?.toLowerCase()
  const mode = rawMode === undefined ? hasKeyframes ? 'keyframe' : hasReferences ? 'reference' : 'text'
    : VIDEO_MODE_ALIASES[rawMode] ?? rawMode
  if (!['text', 'keyframe', 'reference'].includes(mode)) invalid('mode must be text, keyframe or reference.', 'mode')
  if ((mode === 'text' && (hasKeyframes || hasReferences))
    || (mode === 'keyframe' && (!hasKeyframes || hasReferences))
    || (mode === 'reference' && (!hasReferences || hasKeyframes))) invalid('mode does not match the provided media.', 'mode')
  const body: Record<string, unknown> = { model, prompt: text(req.prompt, 'prompt'), seconds: String(seconds), size: '720P', aspect_ratio: aspectRatio, mode }
  if (firstFrame !== undefined) body.first_frame = firstFrame
  if (lastFrame !== undefined) body.last_frame = lastFrame
  if (images.length) body.images = images
  if (audios.length) body.audios = audios
  if (source.seed !== undefined) body.seed = integer(source.seed, 'seed')
  return { path: '/videos', method: 'POST', json: body }
}

async function videoFormRequest(form: FormData): Promise<UpstreamRequest> {
  const body = formFields(form, VIDEO_FIELDS)
  const direct = form.getAll('input_reference')
  const urls = form.getAll('input_reference[image_url]')
  const ids = form.getAll('input_reference[file_id]')
  if (direct.length > 1 || urls.length > 1 || ids.length > 1) invalid('Only one input_reference is accepted.', 'input_reference')
  if (direct.length) body.input_reference = await fileReference(direct[0], 'input_reference')
  else if (urls.length) body.input_reference = text(urls[0], 'input_reference.image_url')
  else if (ids.length) invalid('input_reference requires an image URL or uploaded image.', 'input_reference')
  return videoRequest(body as VideoCreateRequest)
}

function videoAddress(id: string): { model: string; videoId: string } {
  if (!id || id.length > 1024) invalid('Invalid video id.', 'video_id')
  const prefix = `${VIDEO_MODEL}:`
  const videoId = id.startsWith(prefix) ? id.slice(prefix.length) : id
  if (!videoId || videoId.length > 512) invalid('Invalid video id.', 'video_id')
  return { model: VIDEO_MODEL, videoId }
}

function videoTaskRequest(id: string, ctx: ProviderCallContext): UpstreamRequest {
  const address = videoAddress(id)
  const root = new URL(ctx.baseUrl)
  // 仅去掉末尾版本段，保留反向代理路径和自定义查询参数。
  root.pathname = root.pathname.replace(/\/+$/, '').replace(/\/v1$/i, '') || '/'
  return { baseUrl: root.toString(), path: '/agnesapi', method: 'GET', query: { video_id: address.videoId, model_name: address.model } }
}

function videoResponse(raw: unknown, _ctx: ProviderCallContext, info: VideoResponseContext): unknown {
  if (!isRecord(raw)) throw errors.upstreamError('Agnes returned invalid video metadata.')
  if (!['queued', 'in_progress', 'completed', 'failed'].includes(String(raw.status))) {
    throw errors.upstreamError('Agnes returned invalid video status metadata.')
  }
  const address = info.videoId ? videoAddress(info.videoId) : undefined
  // 查询完成信封可能只给 task id；必须使用入站 video id，不能改变公开身份。
  const videoId = address?.videoId ?? (typeof raw.video_id === 'string' ? raw.video_id : undefined)
  if (!videoId) throw errors.upstreamError('Agnes video creation did not return video_id.')
  const model = address?.model ?? info.requestModel ?? VIDEO_MODEL
  const url = typeof raw.url === 'string' && raw.url ? raw.url : isRecord(raw.metadata) ? raw.metadata.url : undefined
  return { ...raw, id: `${model}:${videoId}`, model, video_id: videoId, ...(typeof url === 'string' ? { url } : {}) }
}

export const agnes: Provider = {
  id: 'agnes', name: 'Agnes AI', defaultBaseUrl: 'https://apihub.agnes-ai.com/v1', versionPath: '/v1',
  models: [
    { id: 'agnes-3.0-flash', ownedBy: 'agnes' },
    { id: 'agnes-image-2.5-flash', ownedBy: 'agnes' },
    { id: VIDEO_MODEL, ownedBy: 'agnes' },
  ],
  chat: {
    extraParams: ['chat_template_kwargs'],
    transformRequest: chatRequest, transformResponse: chatResponse,
  },
  images: { generations: imageAdapter(false), edits: imageAdapter(true) },
  video: {
    create: {
      path: '/videos', maxRequestBytes: MAX_REQUEST_BYTES,
      extraParams: [...VIDEO_FIELDS], transformRequest: videoRequest,
      transformMultipartRequest: videoFormRequest, transformResponse: videoResponse,
    },
    get: { path: '/agnesapi', transformTaskRequest: videoTaskRequest, transformResponse: videoResponse },
    content: {},
  },
}
