import { describe, expect, mock, test } from 'bun:test'
import {
  createIndexedDbCache,
  createSafeCache,
  lastReaderOf,
  type ModelCache,
} from './cache'
import { createFailureEvictions } from './eviction'

const url = 'https://huggingface.co/a/resolve/r/onnx/model_fp16.onnx'

function sized(bytes: number) {
  return new Response(new Uint8Array(bytes), {
    headers: { 'content-length': String(bytes) },
  })
}

describe('safe model cache', () => {
  test('a write that never finishes does not hold up the load', async () => {
    const put = mock(() => new Promise<void>(() => undefined))
    const cache = createSafeCache(async () => ({
      match: async () => undefined,
      put,
    }))
    await cache.put(url, sized(4))
    await Promise.resolve()
    expect(put).toHaveBeenCalledTimes(1)
  })

  test('a rejected write is dropped', async () => {
    const unhandled = mock(() => undefined)
    process.on('unhandledRejection', unhandled)
    try {
      const cache = createSafeCache(async () => ({
        match: async () => undefined,
        put: async () => {
          throw new DOMException('Quota exceeded', 'QuotaExceededError')
        },
      }))
      await expect(cache.put(url, sized(4))).resolves.toBeUndefined()
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(unhandled).not.toHaveBeenCalled()
    } finally {
      process.off('unhandledRejection', unhandled)
    }
  })

  test('a failing or unavailable cache reads as a miss', async () => {
    const broken = createSafeCache(async () => ({
      match: async () => {
        throw new Error('blocked')
      },
      put: async () => undefined,
    }))
    expect(await broken.match(url)).toBeUndefined()
    const unavailable = createSafeCache(async () => {
      throw new Error('SecurityError')
    })
    expect(await unavailable.match(url)).toBeUndefined()
    await expect(unavailable.put(url, sized(1))).resolves.toBeUndefined()
    expect(await unavailable.delete(url)).toBe(false)
  })

  test('removes a cached model whose size does not match', async () => {
    const entries = new Map<string, Response>([[url, sized(4096)]])
    const inner: ModelCache = {
      match: async (key) => entries.get(String(key)),
      put: async () => undefined,
      delete: async (key) => entries.delete(String(key)),
    }
    const cache = createSafeCache(
      async () => inner,
      (key) => (key === url ? 12 : undefined),
    )
    expect(await cache.match(url)).toBeUndefined()
    expect(entries.has(url)).toBe(false)

    entries.set(url, sized(12))
    expect(await cache.match(url)).toBeInstanceOf(Response)
    entries.set('https://x.test/config.json', sized(3))
    expect(await cache.match('https://x.test/config.json')).toBeInstanceOf(
      Response,
    )
  })

  test('a write still in flight cannot restore an evicted model', async () => {
    const entries = new Map<string, Response>()
    let finishWrite: () => void = () => undefined
    const inner: ModelCache = {
      match: async (key) => entries.get(String(key)),
      put: async (key, response) => {
        await new Promise<void>((resolve) => {
          finishWrite = resolve
        })
        entries.set(String(key), response)
      },
      delete: async (key) => entries.delete(String(key)),
    }
    const cache = createSafeCache(async () => inner)
    await cache.put(url, sized(4))
    await new Promise((resolve) => setTimeout(resolve, 0))

    // The runtime rejects the model and it is evicted before its write lands.
    await cache.delete(url)
    finishWrite()
    await Promise.resolve()
    expect(await cache.match(url)).toBeUndefined()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(entries.has(url)).toBe(false)
    expect(await cache.match(url)).toBeUndefined()

    // A fresh download after the eviction is cached normally.
    await cache.put(url, sized(4))
    await new Promise((resolve) => setTimeout(resolve, 0))
    finishWrite()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(await cache.match(url)).toBeInstanceOf(Response)
  })

  test('a write that starts during an eviction survives it', async () => {
    const entries = new Map<string, Response>()
    let finishFirstWrite: () => void = () => undefined
    let writes = 0
    const inner: ModelCache = {
      match: async (key) => entries.get(String(key)),
      put: async (key, response) => {
        writes += 1
        if (writes === 1) {
          await new Promise<void>((resolve) => {
            finishFirstWrite = resolve
          })
        }
        entries.set(String(key), response)
      },
      delete: async (key) => entries.delete(String(key)),
    }
    const cache = createSafeCache(async () => inner)
    await cache.put(url, sized(4))
    await new Promise((resolve) => setTimeout(resolve, 0))

    // The eviction waits for the first write; a fresh download starts meanwhile.
    const evicted = cache.delete(url)
    await cache.put(url, sized(4))
    finishFirstWrite()
    await evicted
    for (let i = 0; i < 5; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    expect(entries.has(url)).toBe(true)
    expect(await cache.match(url)).toBeInstanceOf(Response)
  })

  test('a slow delete hides the evicted model and holds new writes', async () => {
    const entries = new Map<string, Response>([[url, sized(4)]])
    let finishDelete: () => void = () => undefined
    const inner: ModelCache = {
      match: async (key) => entries.get(String(key)),
      put: async (key, response) => {
        entries.set(String(key), response)
      },
      delete: async (key) => {
        await new Promise<void>((resolve) => {
          finishDelete = resolve
        })
        return entries.delete(String(key))
      },
    }
    const cache = createSafeCache(async () => inner)
    const evicted = cache.delete(url)
    await new Promise((resolve) => setTimeout(resolve, 0))

    // A load that starts before the delete finishes must not read the old file.
    expect(await cache.match(url)).toBeUndefined()
    // Its fresh download lands after the delete, so the delete cannot remove it.
    await cache.put(url, sized(4))
    await new Promise((resolve) => setTimeout(resolve, 0))
    finishDelete()
    await evicted
    for (let i = 0; i < 5; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    expect(entries.has(url)).toBe(true)
    expect(await cache.match(url)).toBeInstanceOf(Response)
  })

  test('a read in flight when an eviction starts returns a miss', async () => {
    const entries = new Map<string, Response>([[url, sized(4)]])
    let finishRead: () => void = () => undefined
    const inner: ModelCache = {
      match: async (key) => {
        const response = entries.get(String(key))
        await new Promise<void>((resolve) => {
          finishRead = resolve
        })
        return response
      },
      put: async (key, response) => {
        entries.set(String(key), response)
      },
      delete: async (key) => entries.delete(String(key)),
    }
    const cache = createSafeCache(async () => inner)
    const read = cache.match(url)
    await new Promise((resolve) => setTimeout(resolve, 0))
    await cache.delete(url)
    await new Promise((resolve) => setTimeout(resolve, 0))

    // The read found the evicted file before the delete, so it must not use it.
    finishRead()
    expect(await read).toBeUndefined()
  })

  test('a write stuck behind a slow eviction is dropped', async () => {
    let finishFirst: () => void = () => undefined
    const put = mock(
      (_key: RequestInfo | URL, _response: Response) =>
        new Promise<void>((resolve) => {
          finishFirst = resolve
        }),
    )
    const cache = createSafeCache(
      async () => ({
        match: async () => undefined,
        put,
        delete: async () => true,
      }),
      () => undefined,
      10,
    )
    // The first write outlasts the wait, so its eviction does too.
    await cache.put(url, sized(4))
    await new Promise((resolve) => setTimeout(resolve, 0))
    await cache.delete(url)
    await cache.put(url, sized(4))
    await new Promise((resolve) => setTimeout(resolve, 30))
    finishFirst()
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(put).toHaveBeenCalledTimes(1)
  })

  test('reports which copy each read returned', async () => {
    const entries = new Map<string, Response>([[url, sized(4)]])
    const cache = createSafeCache(async () => ({
      match: async (key) => entries.get(String(key)),
      put: async (key, response) => {
        entries.set(String(key), response)
      },
      delete: async (key) => entries.delete(String(key)),
    }))
    const first = cache.copy(url)
    expect(await cache.match(url)).toBeInstanceOf(Response)
    await cache.delete(url)
    // The read returned the copy that was then evicted.
    const second = cache.copy(url)
    expect(second).not.toBe(first)
    expect(cache.copyLastRead(url)).toBe(first)
    // Checking the cache is not a load's read.
    await cache.has(url)
    expect(cache.copyLastRead(url)).toBe(first)
    // A miss is followed by a download written after every eviction so far.
    expect(await cache.match(url)).toBeUndefined()
    expect(cache.copyLastRead(url)).toBe(second)
  })

  test('a load evicted between its read and its failure keeps the retry', async () => {
    const entries = new Map<string, Response>([[url, sized(4)]])
    const cache = createSafeCache(async () => ({
      match: async (key) => entries.get(String(key)),
      put: async (key, response) => {
        entries.set(String(key), response)
      },
      delete: async (key) => entries.delete(String(key)),
    }))
    const failures = createFailureEvictions(
      async (key: string) => {
        await cache.delete(key)
      },
      (key) => key,
      (key) => cache.copy(key),
    )
    // One load reads the damaged file, but before it records which copy it
    // read, another load that read the same file fails and evicts it.
    const damaged = cache.copy(url)
    await cache.match(url)
    await failures.fail(url, damaged)
    const copy = cache.copyLastRead(url)
    // The retry caches a fresh download, then the first load fails too.
    await cache.put(url, sized(4))
    await new Promise((resolve) => setTimeout(resolve, 0))
    await failures.fail(url, copy)
    expect(entries.has(url)).toBe(true)
  })

  test('a load that joined another read keeps the retry', async () => {
    const entries = new Map<string, Response>([[url, sized(4)]])
    const cache = createSafeCache(async () => ({
      match: async (key) => entries.get(String(key)),
      put: async (key, response) => {
        entries.set(String(key), response)
      },
      delete: async (key) => entries.delete(String(key)),
    }))
    const failures = createFailureEvictions(
      async (key: string) => {
        await cache.delete(key)
      },
      (key) => key,
      (key) => cache.copy(key),
    )
    // The load that read the damaged file fails and evicts it.
    await cache.match(url)
    await failures.fail(url, cache.copyLastRead(url))
    // The retry caches a fresh download, then a load that joined the first
    // read, and so never learned which copy it got, fails too.
    await cache.put(url, sized(4))
    await new Promise((resolve) => setTimeout(resolve, 0))
    await failures.fail(url, undefined)
    expect(entries.has(url)).toBe(true)
  })

  test('copies of a replaced cache never match the new cache', async () => {
    const entries = new Map<string, Response>([[url, sized(4)]])
    const open = async () => ({
      match: async (key: RequestInfo | URL) => entries.get(String(key)),
      put: async (key: RequestInfo | URL, response: Response) => {
        entries.set(String(key), response)
      },
      delete: async (key: RequestInfo | URL) => entries.delete(String(key)),
    })
    const old = createSafeCache(open)
    await old.match(url)
    const copy = old.copyLastRead(url)
    // The model cache is reset, and a new cache serves a healthy file.
    const current = createSafeCache(open)
    const failures = createFailureEvictions(
      async (key: string) => {
        await current.delete(key)
      },
      (key) => key,
      (key) => current.copy(key),
    )
    await current.match(url)
    // A load that read through the old cache fails late.
    await failures.fail(url, copy)
    expect(entries.has(url)).toBe(true)
  })

  test('reports which cache instance served the latest read', async () => {
    const open = async () => ({
      match: async () => sized(4),
      put: async () => undefined,
    })
    const old = createSafeCache(open)
    const current = createSafeCache(open)
    await old.match(url)
    expect(lastReaderOf(url)).toBe(old)
    await current.match(url)
    expect(lastReaderOf(url)).toBe(current)
  })
})

describe('IndexedDB model cache', () => {
  test('closes its connection when a reset deletes the database', async () => {
    const connections: {
      close: ReturnType<typeof mock>
      onversionchange: (() => void) | null
    }[] = []
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB')
    Object.defineProperty(globalThis, 'indexedDB', {
      configurable: true,
      value: {
        open: () => {
          const connection = {
            close: mock(() => undefined),
            onversionchange: null as (() => void) | null,
            objectStoreNames: { contains: () => true },
            transaction: () => ({
              objectStore: () => ({
                get: () => {
                  // Every key reads as missing.
                  const read = {
                    result: undefined,
                    onsuccess: null as (() => void) | null,
                  }
                  setTimeout(() => read.onsuccess?.(), 0)
                  return read
                },
              }),
            }),
          }
          connections.push(connection)
          const open = {
            result: connection,
            onsuccess: null as (() => void) | null,
          }
          setTimeout(() => open.onsuccess?.(), 0)
          return open
        },
      },
    })
    try {
      const cache = createIndexedDbCache()
      expect(await cache.match(url)).toBeUndefined()
      expect(connections).toHaveLength(1)
      connections[0]?.onversionchange?.()
      expect(connections[0]?.close).toHaveBeenCalledTimes(1)
      // The next read opens a new connection.
      expect(await cache.match(url)).toBeUndefined()
      expect(connections).toHaveLength(2)
    } finally {
      if (descriptor) Object.defineProperty(globalThis, 'indexedDB', descriptor)
      else Reflect.deleteProperty(globalThis, 'indexedDB')
    }
  })
})
