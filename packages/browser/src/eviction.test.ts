import { describe, expect, mock, test } from 'bun:test'
import { createFailureEvictions } from './eviction'

function setup() {
  const copies = new Map<string, number>()
  const copyOf = (target: string) => copies.get(target) ?? 0
  const evict = mock(async (target: string) => {
    copies.set(target, copyOf(target) + 1)
  })
  return {
    evict,
    copyOf,
    evictions: createFailureEvictions(evict, (t) => t, copyOf),
  }
}

describe('failure evictions', () => {
  test('failures of one copy evict it once', async () => {
    const { evict, evictions, copyOf } = setup()
    const copy = copyOf('lite')
    await evictions.fail('lite', copy)
    // The retry is now writing a fresh download.
    await evictions.fail('lite', copy)
    expect(evict).toHaveBeenCalledTimes(1)
  })

  test('loads that read the same copy share its eviction', async () => {
    const { evict, evictions, copyOf } = setup()
    const webgpu = copyOf('lite')
    const wasm = copyOf('lite')
    const first = evictions.fail('lite', webgpu)
    expect(evictions.fail('lite', wasm)).toBe(first)
    await first
    expect(evict).toHaveBeenCalledTimes(1)
  })

  test('a load that read a copy after an eviction evicts again', async () => {
    const { evict, evictions, copyOf } = setup()
    await evictions.fail('lite', copyOf('lite'))
    await evictions.fail('lite', copyOf('lite'))
    expect(evict).toHaveBeenCalledTimes(2)
  })

  test('a copy evicted for another reason is not evicted again', async () => {
    const { evict, evictions, copyOf } = setup()
    const copy = copyOf('lite')
    // For example, the cache dropped it for having the wrong size.
    await evict('lite')
    await evictions.fail('lite', copy)
    expect(evict).toHaveBeenCalledTimes(1)
  })

  test('copies are tracked per file', async () => {
    const { evict, evictions, copyOf } = setup()
    const lite = copyOf('lite')
    const full = copyOf('full')
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
