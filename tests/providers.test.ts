import { describe, expect, it } from 'vitest'
import { listProviders } from '../app/api/providers/registry'

describe('内置供应商注册', () => {
  it('注册当前接入的供应商', () => {
    expect(listProviders().map((provider) => provider.id).sort()).toEqual([
      'ifm',
      'inceptionlabs-playground',
    ])
  })
})
