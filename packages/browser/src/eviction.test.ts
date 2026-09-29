import { describe, expect, mock, test } from 'bun:test'
import { createFailureEvictions } from './eviction'

describe('failure evictions', () => {
  test('a caller that handles the same failure later does not evict again', async () => {
    const evict = mock(async (_target: string) => undefined)
    const evictFor = createFailureEvictions(evict)
    const failure = new Error('corrupt')
    await evictFor('lite', failure)
    // The retry is now writing a fresh download.
    await evictFor('lite', failure)
    expect(evict).toHaveBeenCalledTimes(1)
  })

  test('a new failure evicts again', async () => {
    const evict = mock(async (_target: string) => undefined)
    const evictFor = createFailureEvictions(evict)
    await evictFor('lite', new Error('corrupt'))
    await evictFor('lite', new Error('corrupt again'))
    expect(evict).toHaveBeenCalledTimes(2)
  })

  test('a failure that is not an object always evicts', async () => {
    const evict = mock(async (_target: string) => undefined)
    const evictFor = createFailureEvictions(evict)
    await evictFor('lite', 'corrupt')
    await evictFor('lite', 'corrupt')
    expect(evict).toHaveBeenCalledTimes(2)
  })
})
