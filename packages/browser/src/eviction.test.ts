import { describe, expect, mock, test } from 'bun:test'
import { createFailureEvictions } from './eviction'

function setup() {
  const evict = mock(async (_target: string) => undefined)
  return { evict, evictions: createFailureEvictions(evict, (t) => t) }
}

describe('failure evictions', () => {
  test('failures of one copy evict it once', async () => {
    const { evict, evictions } = setup()
    const copy = evictions.begin('lite')
    await evictions.fail('lite', copy)
    // The retry is now writing a fresh download.
    await evictions.fail('lite', copy)
    expect(evict).toHaveBeenCalledTimes(1)
  })

  test('loads that read the same copy share its eviction', async () => {
    const { evict, evictions } = setup()
    const webgpu = evictions.begin('lite')
    const wasm = evictions.begin('lite')
    const first = evictions.fail('lite', webgpu)
    expect(evictions.fail('lite', wasm)).toBe(first)
    await first
    expect(evict).toHaveBeenCalledTimes(1)
  })

  test('a load that began after an eviction evicts again', async () => {
    const { evict, evictions } = setup()
    await evictions.fail('lite', evictions.begin('lite'))
    await evictions.fail('lite', evictions.begin('lite'))
    expect(evict).toHaveBeenCalledTimes(2)
  })

  test('copies are tracked per file', async () => {
    const { evict, evictions } = setup()
    const lite = evictions.begin('lite')
    const full = evictions.begin('full')
    await evictions.fail('lite', lite)
    await evictions.fail('full', full)
    expect(evict).toHaveBeenCalledTimes(2)
  })

  test('a failure without a recorded copy always evicts', async () => {
    const { evict, evictions } = setup()
    await evictions.fail('lite', undefined)
    await evictions.fail('lite', undefined)
    expect(evict).toHaveBeenCalledTimes(2)
  })
})
