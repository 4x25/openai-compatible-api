import { describe, expect, it } from 'vitest'
import { listProviders } from '../app/api/providers/registry'

describe('内置供应商注册', () => {
  it('注册当前接入的供应商', () => {
    expect(listProviders().map((provider) => provider.id).sort()).toEqual([
      '_',
      'agnes',
      'ifm',
      'inception',
    ])
  })

  it('调试透传供应商固定置顶', () => {
    expect(listProviders()[0].id).toBe('_')
    expect(listProviders()[0].passthrough).toBe(true)
  })
})
