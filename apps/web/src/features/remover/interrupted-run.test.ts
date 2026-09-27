import { describe, expect, test } from 'bun:test'

import {
  createStallGuard,
  RUN_MARKER_KEY,
  RUN_MARKER_MAX_AGE_MS,
  startRunMarker,
  takeInterruptedRun,
} from './interrupted-run'

function memoryStorage(): Storage {
  const values = new Map<string, string>()
  return {
    get length() {
      return values.size
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => {
      values.delete(key)
    },
    setItem: (key, value) => {
      values.set(key, String(value))
    },
  }
}

describe('interrupted run marker', () => {
  test('stores only stage, provider, and start time', () => {
    const storage = memoryStorage()
    const run = startRunMarker('webgpu', storage, 1000)
    run.update('processing')
    expect(JSON.parse(storage.getItem(RUN_MARKER_KEY) ?? '')).toEqual({
      stage: 'processing',
      provider: 'webgpu',
      startedAt: 1000,
    })
    run.clear()
    expect(storage.getItem(RUN_MARKER_KEY)).toBeNull()
  })

  test('an older run never clears or overwrites a newer run', () => {
    const storage = memoryStorage()
    const older = startRunMarker('wasm', storage, 2000)
    const newer = startRunMarker('wasm', storage, 2000)
    older.update('finishing')
    older.clear()
    expect(JSON.parse(storage.getItem(RUN_MARKER_KEY) ?? '')).toMatchObject({
      stage: 'preparing',
    })
    newer.clear()
    expect(storage.getItem(RUN_MARKER_KEY)).toBeNull()
  })

  test('a fresh marker is reported once', () => {
    const storage = memoryStorage()
    startRunMarker('wasm', storage, 5000).update('downloading')
    expect(takeInterruptedRun(storage, 25_000)).toEqual({
      stage: 'downloading',
      provider: 'wasm',
    })
    expect(takeInterruptedRun(storage, 25_000)).toBeUndefined()
  })

  test.each([
    ['stale', JSON.stringify({ stage: 'processing', provider: 'wasm', startedAt: 0 })],
    ['malformed', '{not json'],
    ['unknown stage', JSON.stringify({ stage: 'x', provider: 'wasm', startedAt: 1 })],
    ['unknown provider', JSON.stringify({ stage: 'processing', provider: 'x', startedAt: 1 })],
  ])('a %s marker is dropped without a report', (_, raw) => {
    const storage = memoryStorage()
    storage.setItem(RUN_MARKER_KEY, raw)
    expect(takeInterruptedRun(storage, RUN_MARKER_MAX_AGE_MS + 1)).toBeUndefined()
    expect(storage.getItem(RUN_MARKER_KEY)).toBeNull()
  })

  test('unavailable storage never breaks processing', () => {
    const broken = {
      getItem() {
        throw new Error('denied')
      },
      setItem() {
        throw new Error('quota')
      },
      removeItem() {
        throw new Error('denied')
      },
    } as unknown as Storage
    const run = startRunMarker('wasm', broken)
    expect(() => run.update('processing')).not.toThrow()
    expect(() => run.clear()).not.toThrow()
    expect(takeInterruptedRun(broken)).toBeUndefined()
  })
})

describe('stall guard', () => {
  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

  test('fires only after progress stops', async () => {
    let stalled = 0
    const guard = createStallGuard(() => stalled++, 30)
    for (let i = 0; i < 3; i++) {
      await wait(15)
      guard.touch()
    }
    expect(stalled).toBe(0)
    await wait(50)
    expect(stalled).toBe(1)
  })

  test('stop disarms it', async () => {
    let stalled = 0
    const guard = createStallGuard(() => stalled++, 10)
    guard.stop()
    await wait(30)
    expect(stalled).toBe(0)
  })
})
