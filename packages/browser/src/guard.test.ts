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
  test('clears the running marker when work settles', () => {
    const settleLoad = markFullModelRunning()
    const settleRun = markFullModelRunning()
    expect(session.size).toBe(1)
    settleLoad()
    expect(session.size).toBe(1)
    settleRun()
    settleRun()
    expect(session.size).toBe(0)
    expect(isFullModelBlocked()).toBe(false)
  })

  test('a marker left by a killed tab blocks the full model', () => {
    session.set('bg0:full-model-running:v1', '1')
    expect(isFullModelBlocked(1000)).toBe(true)
    expect(session.size).toBe(0)
    expect(isFullModelBlocked(2000)).toBe(true)
  })

  test('does not treat work still running in this page as a crash', () => {
    const settle = markFullModelRunning()
    expect(isFullModelBlocked()).toBe(false)
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

  test('a block lasts a week', () => {
    const week = 7 * 24 * 60 * 60 * 1000
    blockFullModel(0)
    expect(isFullModelBlocked(week - 1)).toBe(true)
    expect(isFullModelBlocked(week)).toBe(false)
    expect(local.size).toBe(0)
  })

  test('works without storage', () => {
    Reflect.deleteProperty(globalThis, 'localStorage')
    Reflect.deleteProperty(globalThis, 'sessionStorage')
    const settle = markFullModelRunning()
    blockFullModel()
    expect(isFullModelBlocked()).toBe(false)
    settle()
  })
})
