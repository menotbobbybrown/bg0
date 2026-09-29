import { describe, expect, test } from 'bun:test'

import {
  createStallGuard,
  RUN_MARKER_KEY,
  RUN_MARKER_MAX_AGE_MS,
  type RunLocks,
  runLockName,
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

// A lock manager shared by every "tab" in a test. Locks are exclusive and
// never contended here because every run uses a unique name.
function fakeLocks() {
  const held = new Map<string, Promise<unknown>>()
  const locks = {
    request: ((name: string, callback: (lock: Lock) => Promise<unknown>) => {
      const done = Promise.resolve(callback({ name, mode: 'exclusive' }))
      held.set(name, done)
      return done.finally(() => {
        if (held.get(name) === done) held.delete(name)
      })
    }) as unknown as LockManager['request'],
    query: async () => ({
      held: [...held.keys()].map((name) => ({
        name,
        mode: 'exclusive' as const,
        clientId: 'tab',
      })),
      pending: [],
    }),
  } satisfies RunLocks
  return { locks, held }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('interrupted run marker', () => {
  test('stores only stage, provider, start time, and a random id', () => {
    const storage = memoryStorage()
    const run = startRunMarker(storage, 1000)
    run.update('processing', 'webgpu')
    const marker = JSON.parse(storage.getItem(RUN_MARKER_KEY) ?? '')
    expect(marker).toEqual({
      stage: 'processing',
      provider: 'webgpu',
      startedAt: 1000,
      id: expect.any(String),
    })
    run.clear()
    expect(storage.getItem(RUN_MARKER_KEY)).toBeNull()
  })

  test('an older run never clears or overwrites a newer run', () => {
    const storage = memoryStorage()
    const older = startRunMarker(storage, 2000)
    const newer = startRunMarker(storage, 2000)
    older.update('finishing', 'wasm')
    older.clear()
    expect(JSON.parse(storage.getItem(RUN_MARKER_KEY) ?? '')).toMatchObject({
      stage: 'preparing',
    })
    newer.clear()
    expect(storage.getItem(RUN_MARKER_KEY)).toBeNull()
  })

  test('a fresh marker is reported once', async () => {
    const storage = memoryStorage()
    startRunMarker(storage, 5000).update('downloading', 'wasm')
    expect(await takeInterruptedRun(storage, 25_000)).toEqual({
      stage: 'downloading',
      provider: 'wasm',
    })
    expect(await takeInterruptedRun(storage, 25_000)).toBeUndefined()
  })

  test('a marker from before run ids is still reported', async () => {
    const storage = memoryStorage()
    storage.setItem(
      RUN_MARKER_KEY,
      JSON.stringify({ stage: 'processing', provider: 'wasm', startedAt: 1 }),
    )
    const { locks } = fakeLocks()
    expect(await takeInterruptedRun(storage, 2, locks)).toEqual({
      stage: 'processing',
      provider: 'wasm',
    })
  })

  test('a copied marker whose run is live in another tab is dropped unreported', async () => {
    const { locks, held } = fakeLocks()
    const original = memoryStorage()
    const run = startRunMarker(original, 8000, locks)
    run.update('processing', 'wasm')
    const raw = original.getItem(RUN_MARKER_KEY) ?? ''
    const { id } = JSON.parse(raw)
    expect(held.has(runLockName(id))).toBe(true)
    // A duplicated or opened tab starts with a copy of sessionStorage.
    const copy = memoryStorage()
    copy.setItem(RUN_MARKER_KEY, raw)
    expect(await takeInterruptedRun(copy, 9000, locks)).toBeUndefined()
    // The original clears only its own storage, so a kept copy would be
    // reported as interrupted when this tab later reloads.
    expect(copy.getItem(RUN_MARKER_KEY)).toBeNull()
    expect(original.getItem(RUN_MARKER_KEY)).toBe(raw)
    run.clear()
    await settle()
    expect(await takeInterruptedRun(copy, 60_000, locks)).toBeUndefined()
    await settle()
    expect(held.size).toBe(0)
    expect(original.getItem(RUN_MARKER_KEY)).toBeNull()
  })

  test('a run whose lock is no longer held is reported', async () => {
    const { locks, held } = fakeLocks()
    const storage = memoryStorage()
    startRunMarker(storage, 8000, locks).update('processing', 'webgpu')
    // The page died, which releases every lock it held.
    held.clear()
    expect(await takeInterruptedRun(storage, 9000, locks)).toEqual({
      stage: 'processing',
      provider: 'webgpu',
    })
    expect(storage.getItem(RUN_MARKER_KEY)).toBeNull()
  })

  test('a failing lock query falls back to reporting', async () => {
    const storage = memoryStorage()
    startRunMarker(storage, 8000).update('finishing', 'wasm')
    const locks = {
      request: (() =>
        Promise.reject(new Error('x'))) as unknown as LockManager['request'],
      query: () => Promise.reject(new Error('denied')),
    } satisfies RunLocks
    expect(await takeInterruptedRun(storage, 9000, locks)).toEqual({
      stage: 'finishing',
      provider: 'wasm',
    })
  })

  test('a marker replaced during the lock query is left for its new run', async () => {
    const { locks } = fakeLocks()
    const storage = memoryStorage()
    storage.setItem(
      RUN_MARKER_KEY,
      JSON.stringify({
        stage: 'processing',
        provider: 'wasm',
        startedAt: 1,
        id: 'dead',
      }),
    )
    const pending = takeInterruptedRun(storage, 2, locks)
    const run = startRunMarker(storage, 3, locks)
    expect(await pending).toBeUndefined()
    expect(JSON.parse(storage.getItem(RUN_MARKER_KEY) ?? '')).toMatchObject({
      stage: 'preparing',
    })
    run.clear()
  })

  test('the provider stays unknown until the run reports it', async () => {
    const storage = memoryStorage()
    const run = startRunMarker(storage, 6000)
    run.update('downloading')
    expect(await takeInterruptedRun(storage, 6000)).toEqual({
      stage: 'downloading',
      provider: 'unknown',
    })
    const next = startRunMarker(storage, 7000)
    next.update('processing', 'wasm')
    // Later stages keep the reported provider.
    next.update('finishing')
    expect(JSON.parse(storage.getItem(RUN_MARKER_KEY) ?? '')).toMatchObject({
      stage: 'finishing',
      provider: 'wasm',
    })
    next.clear()
  })

  test('a fallback engine load forgets the provider that failed', async () => {
    const storage = memoryStorage()
    const run = startRunMarker(storage, 6000)
    run.update('processing', 'webgpu')
    // The package reports loading the fallback engine without a provider.
    run.update('preparing')
    expect(await takeInterruptedRun(storage, 6000)).toEqual({
      stage: 'preparing',
      provider: 'unknown',
    })
    run.clear()
  })

  test.each([
    [
      'stale',
      JSON.stringify({ stage: 'processing', provider: 'wasm', startedAt: 0 }),
    ],
    ['malformed', '{not json'],
    [
      'unknown stage',
      JSON.stringify({ stage: 'x', provider: 'wasm', startedAt: 1 }),
    ],
    [
      'unknown provider',
      JSON.stringify({ stage: 'processing', provider: 'x', startedAt: 1 }),
    ],
    [
      'non-string id',
      JSON.stringify({
        stage: 'processing',
        provider: 'wasm',
        startedAt: 1,
        id: 4,
      }),
    ],
  ])('a %s marker is dropped without a report', async (_, raw) => {
    const storage = memoryStorage()
    storage.setItem(RUN_MARKER_KEY, raw)
    const taken = takeInterruptedRun(storage, RUN_MARKER_MAX_AGE_MS + 1)
    // Dropped before the first await, so a mount sees a clean slate at once.
    expect(storage.getItem(RUN_MARKER_KEY)).toBeNull()
    expect(await taken).toBeUndefined()
  })

  test('unavailable storage never breaks processing', async () => {
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
    const run = startRunMarker(broken)
    expect(() => run.update('processing')).not.toThrow()
    expect(() => run.clear()).not.toThrow()
    expect(await takeInterruptedRun(broken)).toBeUndefined()
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
