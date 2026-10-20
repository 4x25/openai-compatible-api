import type { Child } from 'hono/jsx'
import {
  ArrowRightIcon,
  BookOpenIcon,
  CherryStudioIcon,
  ClaudeCodeIcon,
  EllipsisHorizontalIcon,
} from '../components/icons'

type Tone = 'plain' | 'cmd' | 'flag' | 'str' | 'val' | 'key' | 'punct'

type Token = readonly [text: string, tone?: Tone]

const toneClass: Record<Tone, string> = {
  plain: 'text-slate-300',
  cmd: 'text-emerald-400',
  flag: 'text-amber-300',
  str: 'text-emerald-300',
  val: 'text-slate-100',
  key: 'text-sky-300',
  punct: 'text-slate-600',
}

const requestLines: Token[][] = [
  [
    ['curl', 'cmd'],
    [' ', 'plain'],
    ['-X', 'flag'],
    [' ', 'plain'],
    ['POST', 'flag'],
    [' ', 'plain'],
    ['"/v1/chat/completions"', 'str'],
    [' \\', 'punct'],
  ],
  [
    ['  ', 'plain'],
    ['-H', 'flag'],
    [' ', 'plain'],
    ['"Authorization: Bearer sk-••••"', 'str'],
    [' \\', 'punct'],
  ],
  [
    ['  ', 'plain'],
    ['-d', 'flag'],
    [' ', 'plain'],
    ["'{", 'plain'],
  ],
  [
    ['    ', 'plain'],
    ['"model"', 'key'],
    [': ', 'punct'],
    ['"your-model"', 'str'],
    [',', 'punct'],
  ],
  [
    ['    ', 'plain'],
    ['"messages"', 'key'],
    [': ', 'punct'],
    ['[', 'punct'],
  ],
  [
    ['      ', 'plain'],
    ['{ ', 'punct'],
    ['"role"', 'key'],
    [': ', 'punct'],
    ['"user"', 'str'],
    [', ', 'punct'],
    ['"content"', 'key'],
    [': ', 'punct'],
    ['"..."', 'str'],
    [' }', 'punct'],
  ],
  [
    ['    ', 'plain'],
    [']', 'punct'],
  ],
  [
    ['  ', 'plain'],
    ['}', 'plain'],
    ["'", 'plain'],
  ],
]

const responseLines: Token[][] = [
  [['{', 'punct']],
  [
    ['  ', 'plain'],
    ['"choices"', 'key'],
    [': ', 'punct'],
    ['[{ ', 'punct'],
    ['"message"', 'key'],
    [': { ', 'punct'],
    ['"content"', 'key'],
    [': ', 'punct'],
    ['"Chat request routed."', 'val'],
    [' } }],', 'punct'],
  ],
  [
    ['  ', 'plain'],
    ['"usage"', 'key'],
    [': { ', 'punct'],
    ['"total_tokens"', 'key'],
    [': ', 'punct'],
    ['27', 'val'],
    [' }', 'punct'],
  ],
  [['}', 'punct']],
]

const CodeBlock = ({ lines }: { lines: Token[][] }) => (
  <div class="overflow-x-auto font-mono text-[12px] leading-[1.75] sm:text-[13px]">
    {lines.map((line) => (
      <div class="whitespace-pre">
        {line.map(([text, tone]) => (
          <span class={tone ? toneClass[tone] : undefined}>{text}</span>
        ))}
      </div>
    ))}
  </div>
)

const AppBadge = () => (
  <span class="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.035] px-4 py-2 text-[13px] font-medium text-slate-300">
    <span class="h-1.5 w-1.5 rounded-full bg-sky-400 shadow-[0_0_10px_rgba(56,189,248,0.85)]" />
    人工智能应用基座
  </span>
)

const SupportApp = ({ icon, label }: { icon: Child; label: string }) => (
  <button
    type="button"
    class="btn h-14 gap-3 rounded-full border border-white/[0.09] bg-white/[0.025] px-5 text-[15px] font-medium text-slate-200 shadow-none transition hover:border-white/20 hover:bg-white/[0.055]"
  >
    {icon}
    <span>{label}</span>
  </button>
)

const ExampleWindow = () => (
  <div class="relative w-full min-w-0 max-w-[680px] justify-self-end">
    <div class="pointer-events-none absolute -inset-10 -z-10 rounded-[48px] bg-[radial-gradient(ellipse_at_center,rgba(59,130,246,0.16),rgba(139,92,246,0.10)_42%,transparent_70%)] blur-2xl" />

    <figure class="card flex flex-col overflow-hidden rounded-2xl border border-white/[0.09] bg-[#131418] shadow-[0_40px_110px_-30px_rgba(0,0,0,0.95)] ring-1 ring-inset ring-white/[0.025] lg:min-h-[min(820px,calc(100dvh-10rem))]">
      <figcaption class="sr-only">OpenAI 兼容接口调用示例</figcaption>

      {/* 窗口页签 */}
      <div class="flex items-center justify-between gap-4 border-b border-white/[0.07] px-6 pt-4">
        <div class="flex items-end gap-5 text-[15px] sm:gap-7">
          <span class="relative pb-4 font-medium text-emerald-300 after:absolute after:inset-x-0 after:bottom-0 after:h-0.5 after:rounded-full after:bg-emerald-400">
            Chat
          </span>
          <span class="pb-4 text-slate-500">Responses</span>
          <span class="pb-4 text-slate-500">Claude</span>
          <span class="pb-4 text-slate-500">Gemini</span>
        </div>
        <div class="hidden items-center gap-2 pb-4 font-mono text-[11px] tracking-[0.08em] text-emerald-400 sm:flex">
          <span class="h-2 w-2 rounded-full bg-emerald-400 shadow-[0_0_9px_rgba(52,211,153,0.9)]" />
          200 OK
        </div>
      </div>

      {/* 请求地址 */}
      <div class="flex items-center gap-3 border-b border-white/[0.06] px-6 py-4">
        <span class="badge h-6 rounded-md border-emerald-500/20 bg-emerald-500/10 px-2 font-mono text-[10px] font-semibold tracking-[0.08em] text-emerald-400">
          POST
        </span>
        <code class="font-mono text-[13px] text-slate-300">/v1/chat/completions</code>
      </div>

      {/* 请求体 */}
      <section class="px-6 py-5">
        <h2 class="mb-4 font-mono text-[10px] font-medium uppercase tracking-[0.18em] text-slate-500">Request</h2>
        <CodeBlock lines={requestLines} />
      </section>

      {/* 响应体 */}
      <section class="flex-1 border-t border-white/[0.06] px-6 py-5">
        <h2 class="mb-4 font-mono text-[10px] font-medium uppercase tracking-[0.18em] text-slate-500">Response</h2>
        <CodeBlock lines={responseLines} />
      </section>

      {/* 状态栏 */}
      <div class="flex flex-wrap items-center justify-between gap-3 border-t border-white/[0.06] px-6 py-4 font-mono text-[10px] tracking-[0.12em] text-slate-500">
        <div class="flex items-center gap-3">
          <span>142 MS</span>
          <span class="h-1 w-1 rounded-full bg-slate-600" />
          <span>27 TOKENS</span>
          <span class="h-1 w-1 rounded-full bg-slate-600" />
          <span>COST $0.00081</span>
        </div>
        <div class="flex items-center gap-3">
          <span>STREAM</span>
          <span class="h-1 w-1 rounded-full bg-slate-600" />
          <span>SSE</span>
        </div>
      </div>
    </figure>
  </div>
)

export default function App() {
  return (
    <main
      data-theme="dark"
      class="relative isolate min-h-dvh overflow-hidden bg-[#151619] font-sans text-slate-100 antialiased"
    >
      {/* 背景氛围光 */}
      <div class="pointer-events-none absolute -left-48 -top-48 -z-10 h-[560px] w-[560px] rounded-full bg-sky-500/[0.07] blur-[130px]" />
      <div class="pointer-events-none absolute -right-52 top-1/4 -z-10 h-[680px] w-[680px] rounded-full bg-violet-600/[0.11] blur-[150px]" />
      <div class="pointer-events-none absolute -bottom-56 left-1/3 -z-10 h-[460px] w-[680px] rounded-full bg-indigo-500/[0.06] blur-[130px]" />

      <div class="mx-auto grid min-h-dvh w-full max-w-[1500px] items-start gap-14 px-6 py-14 sm:px-10 lg:grid-cols-[minmax(0,0.92fr)_minmax(0,1.08fr)] lg:gap-16 lg:py-20 xl:gap-24">
        {/* 左侧：标题与介绍 */}
        <div class="min-w-0 max-w-[620px]">
          <AppBadge />

          <h1 class="mt-7 text-[clamp(2.7rem,4.4vw,4rem)] font-extrabold leading-[1.12] tracking-[-0.04em] text-slate-50">
            <span class="block lg:whitespace-nowrap">统一 API 网关，<br class="lg:hidden" />服务于</span>
            <span class="mt-1 block bg-gradient-to-r from-[#7fb2ff] via-[#9a94ff] to-[#c75cff] bg-clip-text text-transparent">
              海量 AI 模型
            </span>
          </h1>

          <p class="mt-7 max-w-[560px] text-[15px] leading-8 text-slate-400 sm:text-[17px] sm:leading-8">
            通过统一、标准的接口协议接入海量模型。承载 AI 应用，高效管理数字资产，连接未来。
          </p>

          <div class="mt-9 flex flex-wrap items-center gap-3">
            <a
              href="/dashboard"
              class="btn h-12 rounded-full border-0 bg-[#0c86ff] px-7 text-[15px] font-semibold text-white shadow-[0_12px_32px_-12px_rgba(12,134,255,0.85)] hover:bg-[#2696ff]"
            >
              前往仪表板
              <ArrowRightIcon />
            </a>
            <a
              href="/docs"
              class="btn h-12 rounded-full border border-white/10 bg-white/[0.025] px-7 text-[15px] font-medium text-slate-200 shadow-none hover:border-white/20 hover:bg-white/[0.06]"
            >
              <BookOpenIcon />
              文档
            </a>
          </div>

          <div class="mt-12">
            <p class="text-[13px] font-medium text-slate-300">常用应用支持</p>
            <p class="mt-1.5 text-[14px] text-slate-500">支持一键配置并完美适配 NewAPI 多协议配置</p>

            <div class="mt-5 flex flex-wrap items-center gap-3">
              <SupportApp icon={<CherryStudioIcon />} label="Cherry Studio" />
              <SupportApp icon={<ClaudeCodeIcon />} label="CC Switch" />
              <SupportApp icon={<EllipsisHorizontalIcon />} label="更多" />
            </div>
          </div>
        </div>

        {/* 右侧：调用示例窗口 */}
        <ExampleWindow />
      </div>
    </main>
  )
}
