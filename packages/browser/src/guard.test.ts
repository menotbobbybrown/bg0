import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  blockFullModel,
  clearFullModelGuard,
  isFullModelBlocked,
  markFullModelRunning,
} from './guard'

const descriptors = ['localStorage', 'sessionStorage', 'window'].map(
  (key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
)
const local = new Map<string, string>()
const session = new Map<string, string>()

function fakeLocks() {
  const held = new Set<string>()
  return {
    held,
    locks: {
      request: (name: string, callback: () => Promise<void>) => {
        held.add(name)
        return callback().finally(() => held.delete(name))
      },
      query: async () => ({
        held: [...held].map((name) => ({ name })),
        pending: [],
      }),
    } as unknown as Pick<LockManager, 'request' | 'query'>,
  }
}

function storage(map: Map<string, string>) {
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => map.set(key, value),
    removeItem: (key: string) => map.delete(key),
  }
}

beforeEach(() => {
  local.clear()
  session.clear()
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: storage(local),
  })
  Object.defineProperty(globalThis, 'sessionStorage', {
    configurable: true,
    value: storage(session),
  })
})

afterEach(() => {
  clearFullModelGuard()
  for (const [key, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor)
    else Reflect.deleteProperty(globalThis, key)
  }
})

describe('full model guard', () => {
  test('clears the running marker when work settles', async () => {
    const settleLoad = markFullModelRunning()
    const settleRun = markFullModelRunning()
    expect(session.size).toBe(1)
    settleLoad()
    expect(session.size).toBe(1)
    settleRun()
    settleRun()
    expect(session.size).toBe(0)
    expect(await isFullModelBlocked()).toBe(false)
  })

  test('a marker left by a killed tab blocks the full model', async () => {
    session.set('bg0:full-model-running:v1', '1')
    expect(await isFullModelBlocked(1000)).toBe(true)
    expect(session.size).toBe(0)
    expect(await isFullModelBlocked(2000)).toBe(true)
  })

  test('does not treat work still running in this page as a crash', async () => {
    const settle = markFullModelRunning()
    expect(await isFullModelBlocked()).toBe(false)
    settle()
  })

  test('leaving the page is not a crash, but coming back re-arms the marker', () => {
    const page = new EventTarget()
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: page,
    })
    const settle = markFullModelRunning()
    expect(session.size).toBe(1)
    // A reload or navigation ends the document before the work settles.
    page.dispatchEvent(new Event('pagehide'))
    expect(session.size).toBe(0)
    // Restored from the back/forward cache with the work still running.
    page.dispatchEvent(new Event('pageshow'))
    expect(session.size).toBe(1)
    settle()
    expect(session.size).toBe(0)
    // Nothing is running, so later page events leave storage alone.
    page.dispatchEvent(new Event('pageshow'))
    expect(session.size).toBe(0)
  })

  test('a block lasts a week', async () => {
    const week = 7 * 24 * 60 * 60 * 1000
    blockFullModel(0)
    expect(await isFullModelBlocked(week - 1)).toBe(true)
    expect(await isFullModelBlocked(week)).toBe(false)
    expect(local.size).toBe(0)
  })

  test('works without storage', async () => {
    Reflect.deleteProperty(globalThis, 'localStorage')
    Reflect.deleteProperty(globalThis, 'sessionStorage')
    const settle = markFullModelRunning()
    blockFullModel()
    expect(await isFullModelBlocked()).toBe(false)
    settle()
  })

  test('a marker copied from a tab that is still working is not a crash', async () => {
    const { held, locks } = fakeLocks()
    const settle = markFullModelRunning(locks)
    const marker = session.get('bg0:full-model-running:v1')
    expect(marker).toBeTruthy()
    expect(held.size).toBe(1)
    settle()
    await Promise.resolve()
    expect(held.size).toBe(0)

    // A duplicated tab starts with the original's marker while the original
    // still holds the lock for it.
    held.add(`bg0:full-model-running:v1:${marker}`)
    session.set('bg0:full-model-running:v1', String(marker))
    expect(await isFullModelBlocked(1000, locks)).toBe(false)
    expect(session.size).toBe(0)
    expect(local.size).toBe(0)

    // The same marker with nobody holding its lock was left by a crash.
    held.clear()
    session.set('bg0:full-model-running:v1', String(marker))
    expect(await isFullModelBlocked(1000, locks)).toBe(true)
  })

  test('concurrent checks agree while the lock query is pending', async () => {
    const { locks } = fakeLocks()
    let answer: () => void = () => undefined
    const slowLocks = {
      ...locks,
      query: async () => {
        await new Promise<void>((resolve) => {
          answer = resolve
        })
        return locks.query()
      },
    } as typeof locks
    session.set('bg0:full-model-running:v1', 'crashed-run')
    const first = isFullModelBlocked(1000, slowLocks)
    const second = isFullModelBlocked(1000, slowLocks)
    // The marker is kept until the decision is made.
    expect(session.size).toBe(1)
    answer()
    expect(await Promise.all([first, second])).toEqual([true, true])
    expect(session.size).toBe(0)
    expect(await isFullModelBlocked(1000, slowLocks)).toBe(true)
  })

  test('a run that starts during a check keeps its own marker', async () => {
    const { locks } = fakeLocks()
    let answer: () => void = () => undefined
    const slowLocks = {
      ...locks,
      query: async () => {
        await new Promise<void>((resolve) => {
          answer = resolve
        })
        return locks.query()
      },
    } as typeof locks
    session.set('bg0:full-model-running:v1', 'copied-run')
    const check = isFullModelBlocked(1000, slowLocks)
    const settle = markFullModelRunning(locks)
    const current = session.get('bg0:full-model-running:v1')
    expect(current).not.toBe('copied-run')
    answer()
    await check
    expect(session.get('bg0:full-model-running:v1')).toBe(current)
    settle()
  })
})
