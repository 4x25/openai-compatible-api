import type { Provider } from './types'
import type { ModelInfo } from '../types'
import { inception } from './inception'
import { ifm } from './ifm'
import { agnes } from './agnes'
import { passthrough } from './passthrough'

/** 已注册供应商（按 id 小写索引） */
const registry = new Map<string, Provider>()

function register(provider: Provider): void {
  registry.set(provider.id.toLowerCase(), provider)
}

// 调试用透传供应商固定置顶
register(passthrough)
register(inception)
register(ifm)
register(agnes)

/** 注册供应商（插件入口）：新增供应商 = 新建 provider 文件 + 调用本函数 */
export function registerProvider(provider: Provider): void {
  registry.set(provider.id.toLowerCase(), provider)
}

export function getProvider(id: string): Provider | undefined {
  return registry.get(id.toLowerCase())
}

export function listProviders(): Provider[] {
  // 稳定排序：pinned 供应商置顶，其余保持注册顺序。
  return [...registry.values()].sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)))
}

/** provider id -> 环境变量前缀：非字母数字转下划线，全大写 */
export function envPrefix(providerId: string): string {
  return providerId.toUpperCase().replace(/[^A-Z0-9]/g, '_')
}

export type { Provider, ModelInfo }
