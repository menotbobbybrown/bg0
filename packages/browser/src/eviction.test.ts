import { describe, expect, mock, test } from 'bun:test'
import { createFailureEvictions } from './eviction'

describe('failure evictions', () => {
  test('a caller that handles the same load later does not evict again', async () => {
    const evict = mock(async (_target: string) => undefined)
    const evictFor = createFailureEvictions(evict)
    const load = {}
    await evictFor('lite', load)
    // The retry is now writing a fresh download.
    await evictFor('lite', load)
    expect(evict).toHaveBeenCalledTimes(1)
  })

  test('a new load evicts again', async () => {
    const evict = mock(async (_target: string) => undefined)
    const evictFor = createFailureEvictions(evict)
    await evictFor('lite', {})
    await evictFor('lite', {})
    expect(evict).toHaveBeenCalledTimes(2)
  })

  test('a load that is not an object always evicts', async () => {
    const evict = mock(async (_target: string) => undefined)
    const evictFor = createFailureEvictions(evict)
    await evictFor('lite', 'corrupt')
    await evictFor('lite', 'corrupt')
    expect(evict).toHaveBeenCalledTimes(2)
  })
})
