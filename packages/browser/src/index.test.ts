import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from 'bun:test'
import {
  AutoModel,
  AutoProcessor,
  env,
  Tensor,
} from '@huggingface/transformers'
import { modelLoadTimings } from './download'
import * as image from './image'
import {
  clearModelCache,
  prepareBackgroundRemoval,
  removeBackground,
} from './index'
import { FULL_MODEL, LITE_MODEL } from './models'
import * as refinement from './refinement'

const navigatorDescriptor = Object.getOwnPropertyDescriptor(
  globalThis,
  'navigator',
)
const storageDescriptor = Object.getOwnPropertyDescriptor(
  globalThis,
  'localStorage',
)
const storage = new Map<string, string>()
const png = new Blob(['png'], { type: 'image/png' })

beforeEach(() => {
  storage.clear()
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      userAgent: 'Chrome/150.0.0.0',
      gpu: {
        requestAdapter: async () => ({
          features: new Set(['shader-f16']),
          limits: {
            maxBufferSize: 1024 ** 3,
            maxStorageBufferBindingSize: 1024 ** 3,
          },
        }),
      },
    },
  })
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    },
  })
  clearModelCache()
  spyOn(AutoProcessor, 'from_pretrained').mockResolvedValue((async () => ({
    pixel_values: 'pixels',
  })) as never)
  spyOn(image, 'prepareImageForInference').mockResolvedValue({
    data: new Uint8ClampedArray(512 * 512 * 4),
    width: 512,
    height: 512,
    sourceWidth: 800,
    sourceHeight: 600,
  })
  spyOn(image, 'decodeImage').mockResolvedValue({
    width: 800,
    height: 600,
    close: () => undefined,
  } as ImageBitmap)
  spyOn(image, 'maskToPng').mockResolvedValue(png)
})

afterEach(async () => {
  clearModelCache()
  await Promise.resolve()
  mock.restore()
  for (const [key, descriptor] of [
    ['navigator', navigatorDescriptor],
    ['localStorage', storageDescriptor],
  ] as const) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor)
    else Reflect.deleteProperty(globalThis, key)
  }
})

function model(output = 'output_image') {
  return Object.assign(
    mock(async () => ({
      [output]: new Tensor('float32', new Float32Array([-4, 4]), [1, 1, 1, 2]),
    })),
    { dispose: mock(async () => undefined) },
  )
}

describe('automatic model lifecycle', () => {
  test('warm-up and removal share the full engine and apply sigmoid to output_image', async () => {
    const full = model()
    const load = spyOn(AutoModel, 'from_pretrained').mockResolvedValue(
      full as never,
    )
    await Promise.all([prepareBackgroundRemoval(), prepareBackgroundRemoval()])
    const result = await removeBackground(png)
    expect(load).toHaveBeenCalledTimes(1)
    expect(load.mock.calls[0][0]).toBe(FULL_MODEL.id)
    expect(load.mock.calls[0][1]).toMatchObject({
      revision: FULL_MODEL.revision,
      device: 'webgpu',
      dtype: 'fp16',
    })
    expect(result).toMatchObject({
      model: 'birefnet',
      provider: 'webgpu',
      width: 800,
      height: 600,
    })
    const alpha = (image.maskToPng as ReturnType<typeof spyOn>).mock
      .calls[0][1] as Float32Array
    expect(alpha[0]).toBeCloseTo(0.017986, 5)
    expect(alpha[1]).toBeCloseTo(0.982014, 5)
  })

  test('a full-model load failure falls back to lite GPU and stays downgraded for the session', async () => {
    const load = spyOn(AutoModel, 'from_pretrained').mockImplementation(
      async (id) => {
        if (id === FULL_MODEL.id) throw new Error('allocation failed')
        return model('logits') as never
      },
    )
    expect(await prepareBackgroundRemoval()).toBe('webgpu')
    expect((await removeBackground(png)).model).toBe('birefnet-lite')
    expect(load.mock.calls.map((call) => call[0])).toEqual([
      FULL_MODEL.id,
      LITE_MODEL.id,
    ])
    expect(storage.size).toBe(0)
  })

  test.each(['exception', 'invalid', 'empty'])(
    'recovers from a full-model %s during inference and disposes it',
    async (failure) => {
      const full = Object.assign(
        mock(async () => {
          if (failure === 'exception') throw new Error('device lost')
          return {
            output_image: new Tensor(
              'float32',
              new Float32Array(
                failure === 'invalid' ? [NaN, NaN] : [-100, -100],
              ),
              [1, 1, 1, 2],
            ),
          }
        }),
        { dispose: mock(async () => undefined) },
      )
      const load = spyOn(AutoModel, 'from_pretrained').mockImplementation(
        async (id) => (id === FULL_MODEL.id ? full : model('logits')) as never,
      )
      const result = await removeBackground(png)
      expect(result).toMatchObject({
        model: 'birefnet-lite',
        provider: 'webgpu',
      })
      expect(full.dispose).toHaveBeenCalledTimes(1)
      await removeBackground(png)
      expect(load).toHaveBeenCalledTimes(2)
      expect(storage.size).toBe(0)
    },
  )

  test('falls back through both GPU models to WASM and remembers only lite GPU failure', async () => {
    const load = spyOn(AutoModel, 'from_pretrained').mockImplementation(
      async (_id, options) => {
        if (options?.device === 'webgpu') throw new Error('unsupported GPU')
        return model('logits') as never
      },
    )
    const reported: (string | undefined)[] = []
    const result = await removeBackground(png, {
      onProgress: ({ provider }) => reported.push(provider),
    })
    expect(result.provider).toBe('wasm')
    // Progress names the provider actually chosen, not the one tried first.
    expect(reported).toContain('wasm')
    expect(reported).not.toContain('webgpu')
    expect(load.mock.calls.map((call) => [call[0], call[1]?.device])).toEqual([
      [FULL_MODEL.id, 'webgpu'],
      [LITE_MODEL.id, 'webgpu'],
      [LITE_MODEL.id, 'wasm'],
    ])
    expect(storage.size).toBe(1)
  })

  test('cancellation during failed inference does not start a fallback', async () => {
    const controller = new AbortController()
    const full = Object.assign(
      async () => {
        controller.abort()
        throw new Error('device lost')
      },
      { dispose: async () => undefined },
    )
    const load = spyOn(AutoModel, 'from_pretrained').mockResolvedValue(
      full as never,
    )
    await expect(
      removeBackground(png, { signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'cancelled' })
    expect(load).toHaveBeenCalledTimes(1)
  })

  test('cancellation during loading does not download another model', async () => {
    const controller = new AbortController()
    const load = spyOn(AutoModel, 'from_pretrained').mockImplementation(
      async () => {
        controller.abort()
        throw new Error('allocation failed')
      },
    )
    await expect(
      removeBackground(png, { signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'cancelled' })
    expect(load).toHaveBeenCalledTimes(1)
  })

  test('download progress stays monotonic when switching models', async () => {
    spyOn(AutoModel, 'from_pretrained').mockImplementation(
      async (id, options) => {
        options?.progress_callback?.({
          status: 'progress',
          name: id,
          file: 'onnx/model_fp16.onnx',
          progress: 90,
          loaded: 90,
          total: 100,
        })
        if (id === FULL_MODEL.id) throw new Error('allocation failed')
        return model('logits') as never
      },
    )
    const progress: number[] = []
    await removeBackground(png, {
      onProgress: (event) => progress.push(event.progress),
    })
    expect(progress.length).toBeGreaterThan(3)
    expect(progress).toEqual([...progress].sort((a, b) => a - b))
    expect(progress.at(-1)).toBe(1)
  })

  test('cache reset releases engines and allows the full model to be tried again', async () => {
    const load = spyOn(AutoModel, 'from_pretrained')
      .mockRejectedValueOnce(new Error('temporary'))
      .mockResolvedValue(model() as never)
    await prepareBackgroundRemoval()
    clearModelCache()
    expect((await removeBackground(png)).model).toBe('birefnet')
    expect(load.mock.calls.map((call) => call[0])).toEqual([
      FULL_MODEL.id,
      LITE_MODEL.id,
      FULL_MODEL.id,
    ])
  })

  test('cache reset after acquisition keeps the selected engine alive until removal finishes', async () => {
    const full = model()
    const load = spyOn(AutoModel, 'from_pretrained').mockResolvedValue(
      full as never,
    )
    const result = await removeBackground(png, {
      onProgress: ({ stage }) => {
        if (stage === 'processing') clearModelCache()
      },
    })
    expect(result.model).toBe('birefnet')
    expect(load).toHaveBeenCalledTimes(1)
    expect(full).toHaveBeenCalledTimes(1)
    expect(full.dispose).toHaveBeenCalledTimes(1)
  })

  test('cache reset during loading preserves the reservation for the pending removal', async () => {
    const full = model()
    let reset = false
    const load = spyOn(AutoModel, 'from_pretrained').mockImplementation(
      async () => {
        if (!reset) {
          reset = true
          clearModelCache()
        }
        await Promise.resolve()
        return full as never
      },
    )
    expect((await removeBackground(png)).model).toBe('birefnet')
    expect(load).toHaveBeenCalledTimes(1)
    expect(full).toHaveBeenCalledTimes(1)
    expect(full.dispose).toHaveBeenCalledTimes(1)
  })

  test('cache reset between base inference and refinement does not release the model', async () => {
    const full = model()
    spyOn(AutoModel, 'from_pretrained').mockResolvedValue(full as never)
    spyOn(refinement, 'createMaskRefinement').mockImplementation(
      async ({ infer, source }) => {
        clearModelCache()
        await Promise.resolve()
        expect(full.dispose).not.toHaveBeenCalled()
        await infer(source)
        return undefined
      },
    )
    expect((await removeBackground(png, { quality: 'quality' })).model).toBe(
      'birefnet',
    )
    expect(full).toHaveBeenCalledTimes(2)
    expect(full.dispose).toHaveBeenCalledTimes(1)
  })

  test('cache reset waits for every concurrent removal before disposal', async () => {
    const full = model()
    spyOn(AutoModel, 'from_pretrained').mockResolvedValue(full as never)
    const reachedFinishing = Promise.withResolvers<void>()
    const finishSecond = Promise.withResolvers<void>()
    let finishing = 0
    spyOn(image, 'maskToPng').mockImplementation(async () => {
      finishing++
      if (finishing === 2) {
        clearModelCache()
        reachedFinishing.resolve()
        await finishSecond.promise
      } else {
        await reachedFinishing.promise
      }
      return png
    })
    const first = removeBackground(png)
    const second = removeBackground(png)
    await reachedFinishing.promise
    try {
      expect((await first).model).toBe('birefnet')
      expect(full.dispose).not.toHaveBeenCalled()
    } finally {
      finishSecond.resolve()
      await second
    }
    expect(full.dispose).toHaveBeenCalledTimes(1)
  })

  test('cancellation after cache reset releases the acquired model without inference', async () => {
    const controller = new AbortController()
    const full = model()
    const load = spyOn(AutoModel, 'from_pretrained').mockResolvedValue(
      full as never,
    )
    await expect(
      removeBackground(png, {
        signal: controller.signal,
        onProgress: ({ stage }) => {
          if (stage === 'processing') {
            clearModelCache()
            controller.abort()
          }
        },
      }),
    ).rejects.toMatchObject({ code: 'cancelled' })
    expect(load).toHaveBeenCalledTimes(1)
    expect(full).not.toHaveBeenCalled()
    expect(full.dispose).toHaveBeenCalledTimes(1)
  })

  test('all load failures remain useful and WASM can be retried', async () => {
    const load = spyOn(AutoModel, 'from_pretrained').mockRejectedValue(
      new Error('offline'),
    )
    await expect(removeBackground(png)).rejects.toMatchObject({
      code: 'model-load-failed',
    })
    load.mockResolvedValue(model('logits') as never)
    expect((await removeBackground(png)).provider).toBe('wasm')
  })

  test.each(['load', 'inference'])(
    'full WASM %s failure falls back to lite WASM without disabling GPUs',
    async (failure) => {
      Object.defineProperty(globalThis, 'navigator', {
        configurable: true,
        value: { userAgent: 'Firefox/150.0', hardwareConcurrency: 8 },
      })
      const full = Object.assign(
        async () => {
          throw new Error('allocation failed')
        },
        { dispose: mock(async () => undefined) },
      )
      const load = spyOn(AutoModel, 'from_pretrained').mockImplementation(
        async (id) => {
          if (id === FULL_MODEL.id) {
            if (failure === 'load') throw new Error('allocation failed')
            return full as never
          }
          return model('logits') as never
        },
      )
      const result = await removeBackground(png)
      expect(result).toMatchObject({ model: 'birefnet-lite', provider: 'wasm' })
      expect(load.mock.calls.map((call) => [call[0], call[1]?.device])).toEqual(
        [
          [FULL_MODEL.id, 'wasm'],
          [LITE_MODEL.id, 'wasm'],
        ],
      )
      if (failure === 'inference') expect(full.dispose).toHaveBeenCalledTimes(1)
      expect(storage.size).toBe(0)
      await removeBackground(png)
      expect(load).toHaveBeenCalledTimes(2)
    },
  )
})

describe('model load recovery', () => {
  const originalFetch = env.fetch
  const timings = { ...modelLoadTimings }
  const cachesDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'caches')
  const sessionDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    'sessionStorage',
  )
  const modelFile = (definition: typeof FULL_MODEL) =>
    `https://huggingface.co/${definition.id}/resolve/${definition.revision}/onnx/model_fp16.onnx`

  afterEach(() => {
    env.fetch = originalFetch
    Object.assign(modelLoadTimings, timings)
    for (const [key, descriptor] of [
      ['caches', cachesDescriptor],
      ['sessionStorage', sessionDescriptor],
    ] as const) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
  })

  function installCaches(put: (key: string, response: Response) => unknown) {
    const entries = new Map<string, Response>()
    Object.defineProperty(globalThis, 'caches', {
      configurable: true,
      value: {
        open: async () => ({
          match: async (key: string) => entries.get(key)?.clone(),
          put: async (key: string, response: Response) => {
            await put(key, response)
            entries.set(key, response)
          },
          delete: async (key: string) => entries.delete(key),
        }),
      },
    })
    return entries
  }

  test('a corrupt cached model is evicted and the lite model still loads', async () => {
    const entries = installCaches(() => undefined)
    entries.set(
      modelFile(FULL_MODEL),
      new Response('x', {
        headers: { 'content-length': String(FULL_MODEL.bytes) },
      }),
    )
    const load = spyOn(AutoModel, 'from_pretrained').mockImplementation(
      async (id) => {
        if (id === FULL_MODEL.id) {
          throw new Error(
            "Can't create a session. ERROR_CODE: 7, ERROR_MESSAGE: Failed to load model because protobuf parsing failed.",
          )
        }
        return model('logits') as never
      },
    )
    expect(await removeBackground(png)).toMatchObject({
      model: 'birefnet-lite',
      provider: 'webgpu',
    })
    expect(entries.has(modelFile(FULL_MODEL))).toBe(false)
    // The full model is downloaded again once before falling back.
    expect(load.mock.calls.map((call) => call[0])).toEqual([
      FULL_MODEL.id,
      FULL_MODEL.id,
      LITE_MODEL.id,
    ])
    expect(storage.size).toBe(0)
  })

  test('a corrupt lite WASM model is evicted and downloaded again once', async () => {
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { userAgent: 'Firefox/150.0' },
    })
    const entries = installCaches(() => undefined)
    entries.set(
      modelFile(LITE_MODEL),
      new Response('x', {
        headers: { 'content-length': String(LITE_MODEL.bytes) },
      }),
    )
    const corrupt = new Error(
      "Can't create a session. ERROR_CODE: 7, ERROR_MESSAGE: Failed to load model because protobuf parsing failed.",
    )
    let corruptLoads = 1
    const load = spyOn(AutoModel, 'from_pretrained').mockImplementation(
      async () => {
        if (corruptLoads > 0) {
          corruptLoads -= 1
          throw corrupt
        }
        return model('logits') as never
      },
    )
    expect(await removeBackground(png)).toMatchObject({
      model: 'birefnet-lite',
      provider: 'wasm',
    })
    expect(entries.has(modelFile(LITE_MODEL))).toBe(false)
    expect(load).toHaveBeenCalledTimes(2)

    // A download that is corrupt every time is retried once, not forever.
    clearModelCache()
    corruptLoads = Number.POSITIVE_INFINITY
    load.mockClear()
    await expect(removeBackground(png)).rejects.toMatchObject({
      code: 'model-load-failed',
    })
    expect(load).toHaveBeenCalledTimes(2)
    await expect(removeBackground(png)).rejects.toMatchObject({
      code: 'model-load-failed',
    })
    expect(load).toHaveBeenCalledTimes(2)
  })

  test('a cached model with the wrong size is ignored and removed', async () => {
    const entries = installCaches(() => undefined)
    entries.set(
      modelFile(FULL_MODEL),
      new Response('x', { headers: { 'content-length': '4096' } }),
    )
    const events: string[] = []
    spyOn(AutoModel, 'from_pretrained').mockResolvedValue(
      model('logits') as never,
    )
    await removeBackground(png, {
      onProgress: (event) => events.push(event.message),
    })
    expect(entries.has(modelFile(FULL_MODEL))).toBe(false)
    expect(events).not.toContain('Loading cached model…')
  })

  test('a failed cache write does not fail or delay the load', async () => {
    installCaches(async () => {
      throw new DOMException('Quota exceeded', 'QuotaExceededError')
    })
    spyOn(AutoModel, 'from_pretrained').mockImplementation(async () => {
      const cache = env.customCache as {
        put: (key: string, response: Response) => Promise<void>
      }
      await cache.put(modelFile(FULL_MODEL), new Response('model'))
      return model() as never
    })
    expect((await removeBackground(png)).model).toBe('birefnet')
  })

  test('network failures surface a useful error without disabling WebGPU', async () => {
    let online = false
    env.fetch = mock(async () => {
      if (!online) throw new TypeError('Failed to fetch')
      return new Response('ok')
    })
    const load = spyOn(AutoModel, 'from_pretrained').mockImplementation(
      async (id) => {
        await (
          await env.fetch(`https://huggingface.co/${id}/config.json`)
        ).arrayBuffer()
        return model('logits') as never
      },
    )
    await expect(removeBackground(png)).rejects.toMatchObject({
      code: 'model-load-failed',
      message:
        'The local model could not be loaded. Check your connection and try again.',
    })
    // The lite file is shared by both runtimes, so it is not fetched twice,
    // even though the WASM runtime files differ from the WebGPU ones.
    expect(load.mock.calls.map((call) => [call[0], call[1]?.device])).toEqual([
      [FULL_MODEL.id, 'webgpu'],
      [LITE_MODEL.id, 'webgpu'],
    ])
    expect(storage.size).toBe(0)
    online = true
    expect(await removeBackground(png)).toMatchObject({
      model: 'birefnet-lite',
      provider: 'webgpu',
    })
  })

  test('a failed WebGPU runtime file falls back to lite WASM', async () => {
    let online = false
    env.fetch = mock(async (input: RequestInfo | URL) => {
      if (!online && String(input).includes('jsep')) {
        throw new TypeError('Failed to fetch')
      }
      return new Response('ok')
    })
    const load = spyOn(AutoModel, 'from_pretrained').mockImplementation(
      async (id, options) => {
        await (
          await env.fetch(`https://huggingface.co/${id}/config.json`)
        ).arrayBuffer()
        const runtime =
          options?.device === 'webgpu'
            ? 'ort-wasm-simd-threaded.jsep.wasm'
            : 'ort-wasm-simd-threaded.wasm'
        await (
          await env.fetch(`https://cdn.jsdelivr.net/npm/ort/dist/${runtime}`)
        ).arrayBuffer()
        return model('logits') as never
      },
    )
    expect(await removeBackground(png)).toMatchObject({
      model: 'birefnet-lite',
      provider: 'wasm',
    })
    // The model files were reachable, so only the GPU runtime is skipped.
    expect(load.mock.calls.map((call) => [call[0], call[1]?.device])).toEqual([
      [FULL_MODEL.id, 'webgpu'],
      [LITE_MODEL.id, 'wasm'],
    ])
    expect(storage.size).toBe(0)
    online = true
    expect(await removeBackground(png)).toMatchObject({
      model: 'birefnet',
      provider: 'webgpu',
    })
  })

  function stalledResponse() {
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(4))
        },
      }),
    )
  }

  test('a stalled full-model download falls back to the lite model', async () => {
    modelLoadTimings.stallMs = 20
    env.fetch = mock(async () => stalledResponse())
    spyOn(AutoModel, 'from_pretrained').mockImplementation(async (id) => {
      if (id === FULL_MODEL.id) {
        await (await env.fetch(modelFile(FULL_MODEL))).arrayBuffer()
      }
      return model('logits') as never
    })
    expect(await removeBackground(png)).toMatchObject({
      model: 'birefnet-lite',
      provider: 'webgpu',
    })
    expect(storage.size).toBe(0)
  })

  test('a download that stalls on every model ends with a retryable error', async () => {
    modelLoadTimings.stallMs = 20
    env.fetch = mock(async () => stalledResponse())
    spyOn(AutoModel, 'from_pretrained').mockImplementation(async (id) => {
      await (
        await env.fetch(`https://huggingface.co/${id}/x.onnx`)
      ).arrayBuffer()
      return model('logits') as never
    })
    await expect(removeBackground(png)).rejects.toMatchObject({
      code: 'model-load-failed',
      message:
        'The model download stopped responding. Check your connection and try again.',
    })
  })

  test('a model that never finishes starting stops the walk and skips the full model next time', async () => {
    modelLoadTimings.startMs = 20
    const load = spyOn(AutoModel, 'from_pretrained').mockImplementation(
      async (id, options) => {
        if (id !== FULL_MODEL.id) return model('logits') as never
        options?.progress_callback?.({
          status: 'done',
          name: id,
          file: 'onnx/model_fp16.onnx',
        })
        return new Promise(() => undefined)
      },
    )
    await expect(removeBackground(png)).rejects.toMatchObject({
      code: 'model-load-failed',
      message:
        'The local model took too long to start. Reload the page and try again.',
    })
    expect(load).toHaveBeenCalledTimes(1)
    expect(storage.has('bg0:full-model-blocked:v1')).toBe(true)
    expect((await removeBackground(png)).model).toBe('birefnet-lite')
  })

  test('a tab that died during full-model work uses the lite model after reload', async () => {
    const session = new Map([['bg0:full-model-running:v1', '1']])
    Object.defineProperty(globalThis, 'sessionStorage', {
      configurable: true,
      value: {
        getItem: (key: string) => session.get(key) ?? null,
        setItem: (key: string, value: string) => session.set(key, value),
        removeItem: (key: string) => session.delete(key),
      },
    })
    const load = spyOn(AutoModel, 'from_pretrained').mockResolvedValue(
      model('logits') as never,
    )
    expect((await removeBackground(png)).model).toBe('birefnet-lite')
    expect(load.mock.calls[0][0]).toBe(LITE_MODEL.id)
    expect(session.size).toBe(0)
  })

  test('cancelling stops waiting on a model that is still loading', async () => {
    modelLoadTimings.startMs = 200
    spyOn(AutoModel, 'from_pretrained').mockImplementation(
      () => new Promise(() => undefined),
    )
    const controller = new AbortController()
    const pending = removeBackground(png, { signal: controller.signal })
    setTimeout(() => controller.abort(), 10)
    const startedAt = performance.now()
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' })
    expect(performance.now() - startedAt).toBeLessThan(150)
  })

  test('reports downloaded bytes and the runtime while the model downloads', async () => {
    spyOn(AutoModel, 'from_pretrained').mockImplementation(
      async (id, options) => {
        options?.progress_callback?.({
          status: 'progress',
          name: id,
          file: 'onnx/model_fp16.onnx',
          progress: 40,
          loaded: 40_000_000,
          total: 100_000_000,
        })
        return model() as never
      },
    )
    const events: Parameters<
      NonNullable<Parameters<typeof removeBackground>[1]>['onProgress'] & object
    >[0][] = []
    await removeBackground(png, { onProgress: (event) => events.push(event) })
    const downloading = events.find((event) => event.stage === 'downloading')
    expect(downloading).toMatchObject({
      message: 'Downloading local model…',
      provider: 'webgpu',
      download: { loadedBytes: 40_000_000 },
    })
    expect(downloading?.download?.totalBytes).toBeGreaterThanOrEqual(
      100_000_000,
    )
    expect(
      events.filter((event) => event.stage !== 'downloading' && event.download),
    ).toEqual([])
  })
})

describe('HEIC sources', () => {
  // ftyp box: size 16, 'ftyp', major 'heic', minor 0.
  const heic = new Blob(
    [
      new Uint8Array([
        0, 0, 0, 16, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63, 0, 0, 0, 0,
      ]),
    ],
    { type: 'image/heic' },
  )

  test('decodes a HEIC source once and runs the pipeline on the PNG transcode', async () => {
    const heicBitmap = {
      width: 800,
      height: 600,
      close: mock(() => undefined),
    }
    const pngBitmap = {
      width: 800,
      height: 600,
      close: mock(() => undefined),
    }
    const transcoded = new Blob(['transcoded'], { type: 'image/png' })
    const decode = spyOn(image, 'decodeImage').mockImplementation(
      async (_input, format) =>
        (format === 'heic' ? heicBitmap : pngBitmap) as ImageBitmap,
    )
    const toPng = spyOn(image, 'imageToPng').mockResolvedValue(transcoded)
    spyOn(AutoModel, 'from_pretrained').mockResolvedValue(model() as never)

    const result = await removeBackground(heic, { quality: 'quality' })

    expect(decode.mock.calls).toEqual([
      [heic, 'heic'],
      [transcoded, 'png'],
      [transcoded, 'png'],
    ])
    expect(toPng.mock.calls).toEqual([[heicBitmap]])
    expect(image.prepareImageForInference).toHaveBeenCalledWith(
      transcoded,
      expect.any(Number),
      expect.any(Number),
      'png',
    )
    expect((image.maskToPng as ReturnType<typeof spyOn>).mock.calls[0][0]).toBe(
      pngBitmap,
    )
    expect(heicBitmap.close).toHaveBeenCalledTimes(1)
    expect(pngBitmap.close).toHaveBeenCalledTimes(2)
    expect(result.sourceBlob).toBe(transcoded)
  })

  test('cancellation during the HEIC decode skips the PNG transcode', async () => {
    const controller = new AbortController()
    const heicBitmap = {
      width: 800,
      height: 600,
      close: mock(() => undefined),
    }
    const transcoded = new Blob(['transcoded'], { type: 'image/png' })
    spyOn(image, 'decodeImage').mockImplementation(async () => {
      controller.abort()
      return heicBitmap as ImageBitmap
    })
    const toPng = spyOn(image, 'imageToPng').mockResolvedValue(transcoded)
    spyOn(AutoModel, 'from_pretrained').mockResolvedValue(model() as never)

    await expect(
      removeBackground(heic, { signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'cancelled' })
    expect(toPng).not.toHaveBeenCalled()
    expect(heicBitmap.close).toHaveBeenCalledTimes(1)
  })

  test('returns no sourceBlob for natively displayable formats', async () => {
    const toPng = spyOn(image, 'imageToPng')
    spyOn(AutoModel, 'from_pretrained').mockResolvedValue(model() as never)

    const result = await removeBackground(png)

    expect(result.sourceBlob).toBeUndefined()
    expect(toPng).not.toHaveBeenCalled()
  })
})
test.each(['no-context', 'draw', 'pixels'])(
  'failed refinement releases its canvas: %s',
  async (failure) => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'document')
    const canvas = {
      width: 0,
      height: 0,
      getContext: () =>
        failure === 'no-context'
          ? null
          : {
              drawImage() {
                if (failure === 'draw') throw new Error('draw failed')
              },
              getImageData() {
                throw new Error('pixels unavailable')
              },
            },
    }
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: { createElement: () => canvas },
    })
    spyOn(AutoModel, 'from_pretrained').mockResolvedValue(model() as never)
    const closed = mock(() => undefined)
    spyOn(image, 'decodeImage').mockResolvedValue({
      width: 800,
      height: 600,
      close: closed,
    } as unknown as ImageBitmap)
    try {
      expect((await removeBackground(png, { quality: 'quality' })).blob).toBe(
        png,
      )
      expect([canvas.width, canvas.height]).toEqual([0, 0])
      expect(closed).toHaveBeenCalledTimes(2)
    } finally {
      if (descriptor) Object.defineProperty(globalThis, 'document', descriptor)
      else Reflect.deleteProperty(globalThis, 'document')
    }
  },
)
