import { describe, expect, mock, test } from 'bun:test'
import { createSafeCache, type ModelCache } from './cache'

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
})
