import { describe, expect, test } from 'bun:test'
import {
  createLoadWatch,
  ModelDownloadError,
  ModelStartTimeoutError,
  type Timers,
} from './download'

function fakeTimers() {
  let now = 0
  let nextId = 0
  const pending = new Map<number, { at: number; callback: () => void }>()
  const timers: Timers = {
    now: () => now,
    setTimeout: (callback, ms) => {
      nextId += 1
      pending.set(nextId, { at: now + ms, callback })
      return nextId
    },
    clearTimeout: (handle) => {
      pending.delete(handle as number)
    },
  }
  const advance = async (ms: number) => {
    const target = now + ms
    while (true) {
      const due = [...pending.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((a, b) => a[1].at - b[1].at)[0]
      if (!due) break
      pending.delete(due[0])
      now = due[1].at
      due[1].callback()
      await Promise.resolve()
    }
    now = target
    await Promise.resolve()
  }
  return { timers, advance, pending }
}

function streamResponse(
  chunks: Uint8Array[],
  options: { end?: boolean; headers?: HeadersInit; status?: number } = {},
) {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk)
      if (options.end !== false) controller.close()
    },
  })
  return new Response(body, {
    status: options.status ?? 200,
    headers: options.headers,
  })
}

const settledReason = async (promise: Promise<unknown>) =>
  promise.then(
    () => undefined,
    (error: unknown) => error,
  )

describe('model download watchdog', () => {
  test('aborts an attempt when an open download stops delivering bytes', async () => {
    const { timers, advance } = fakeTimers()
    let requestSignal: AbortSignal | undefined
    const watch = createLoadWatch(
      async (_input, init) => {
        requestSignal = init?.signal ?? undefined
        return streamResponse([new Uint8Array(8)], { end: false })
      },
      { stallMs: 1000, startMs: 5000, timers },
    )
    const response = await watch.fetch('https://huggingface.co/a/model.onnx')
    const body = response.arrayBuffer()
    // Let the reader take the first chunk before the clock moves.
    await new Promise((resolve) => setTimeout(resolve, 0))
    await advance(999)
    expect(watch.signal.aborted).toBe(false)
    await advance(1)
    const error = await settledReason(watch.failed)
    expect(error).toBeInstanceOf(ModelDownloadError)
    expect((error as ModelDownloadError).reason).toBe('stalled')
    expect(requestSignal?.aborted).toBe(true)
    expect(await settledReason(body)).toBe(error)
    expect(watch.downloadFailure).toBe(error as ModelDownloadError)
  })

  test('steady chunks keep a slow download alive', async () => {
    const { timers, advance } = fakeTimers()
    let push: ((chunk: Uint8Array | null) => void) | undefined
    const watch = createLoadWatch(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              push = (chunk) =>
                chunk ? controller.enqueue(chunk) : controller.close()
            },
          }),
        ),
      { stallMs: 1000, startMs: 5000, timers },
    )
    const response = await watch.fetch('https://huggingface.co/a/model.onnx')
    const body = response.arrayBuffer()
    for (let index = 0; index < 5; index += 1) {
      await advance(900)
      push?.(new Uint8Array(4))
      await Promise.resolve()
      await Promise.resolve()
    }
    push?.(null)
    expect((await body).byteLength).toBe(20)
    expect(watch.signal.aborted).toBe(false)
    watch.dispose()
  })

  test('rejects a body shorter than its declared length', async () => {
    const watch = createLoadWatch(
      async () =>
        streamResponse([new Uint8Array(4)], {
          headers: { 'content-length': '10' },
        }),
      { stallMs: 1000, startMs: 5000, timers: fakeTimers().timers },
    )
    const response = await watch.fetch('https://huggingface.co/a/config.json')
    const error = await settledReason(response.arrayBuffer())
    expect(error).toBeInstanceOf(ModelDownloadError)
    expect((error as ModelDownloadError).reason).toBe('incomplete')
    expect(watch.downloadFailure?.reason).toBe('incomplete')
    watch.dispose()
  })

  test('checks the model file against its known size even without a length header', async () => {
    const url = 'https://huggingface.co/a/onnx/model_fp16.onnx'
    const watch = createLoadWatch(
      async () => streamResponse([new Uint8Array(6)]),
      {
        stallMs: 1000,
        startMs: 5000,
        timers: fakeTimers().timers,
        expectedBytes: (candidate) => (candidate === url ? 12 : undefined),
      },
    )
    const error = await settledReason((await watch.fetch(url)).arrayBuffer())
    expect((error as ModelDownloadError).reason).toBe('incomplete')
    watch.dispose()
  })

  test('accepts complete bodies and compressed bodies without a length check', async () => {
    const watch = createLoadWatch(
      async (input) =>
        String(input).endsWith('gz')
          ? streamResponse([new Uint8Array(3)], {
              headers: { 'content-encoding': 'gzip', 'content-length': '9' },
            })
          : streamResponse([new Uint8Array(5)], {
              headers: { 'content-length': '5' },
            }),
      { stallMs: 1000, startMs: 5000, timers: fakeTimers().timers },
    )
    expect(
      (await (await watch.fetch('https://x.test/a')).arrayBuffer()).byteLength,
    ).toBe(5)
    expect(
      (await (await watch.fetch('https://x.test/gz')).arrayBuffer()).byteLength,
    ).toBe(3)
    expect(watch.downloadFailure).toBeUndefined()
    watch.dispose()
  })

  test('classifies a failed request as a network failure', async () => {
    const watch = createLoadWatch(
      async () => {
        throw new TypeError('Failed to fetch')
      },
      { stallMs: 1000, startMs: 5000, timers: fakeTimers().timers },
    )
    const error = await settledReason(watch.fetch('https://x.test/a'))
    expect(error).toBeInstanceOf(ModelDownloadError)
    expect((error as ModelDownloadError).reason).toBe('network')
    expect((error as Error).cause).toBeInstanceOf(TypeError)
    watch.dispose()
  })

  test('tags each failure with the kind of file that failed', async () => {
    const { timers, advance } = fakeTimers()
    const assetOf = (url: string) =>
      url.includes('/models/') ? ('model' as const) : ('runtime' as const)
    const offline = createLoadWatch(
      async () => {
        throw new TypeError('Failed to fetch')
      },
      { stallMs: 1000, startMs: 5000, assetOf, timers },
    )
    const runtime = await settledReason(
      offline.fetch('https://cdn.test/ort.wasm'),
    )
    expect((runtime as ModelDownloadError).asset).toBe('runtime')
    const model = await settledReason(
      offline.fetch('https://x.test/models/a.onnx'),
    )
    expect((model as ModelDownloadError).asset).toBe('model')
    offline.dispose()

    const stalled = createLoadWatch(
      async () => streamResponse([new Uint8Array(8)], { end: false }),
      { stallMs: 1000, startMs: 5000, assetOf, timers },
    )
    const body = (
      await stalled.fetch('https://cdn.test/ort.wasm')
    ).arrayBuffer()
    await new Promise((resolve) => setTimeout(resolve, 0))
    await advance(1000)
    const error = await settledReason(stalled.failed)
    expect((error as ModelDownloadError).reason).toBe('stalled')
    expect((error as ModelDownloadError).asset).toBe('runtime')
    await settledReason(body)
    stalled.dispose()
  })

  test('a stalled file cannot hide behind another that keeps downloading', async () => {
    const { timers, advance } = fakeTimers()
    let push: ((chunk: Uint8Array) => void) | undefined
    const watch = createLoadWatch(
      async (input) =>
        String(input).endsWith('.wasm')
          ? streamResponse([new Uint8Array(8)], { end: false })
          : new Response(
              new ReadableStream<Uint8Array>({
                start(controller) {
                  push = (chunk) => controller.enqueue(chunk)
                },
              }),
            ),
      {
        stallMs: 1000,
        startMs: 5000,
        assetOf: (url) => (url.endsWith('.wasm') ? 'runtime' : 'model'),
        timers,
      },
    )
    const model = (
      await watch.fetch('https://huggingface.co/a/model.onnx')
    ).arrayBuffer()
    const runtime = (
      await watch.fetch('https://cdn.test/ort.wasm')
    ).arrayBuffer()
    await new Promise((resolve) => setTimeout(resolve, 0))
    for (let index = 0; index < 3; index += 1) {
      await advance(300)
      push?.(new Uint8Array(4))
      await Promise.resolve()
      await Promise.resolve()
    }
    expect(watch.signal.aborted).toBe(false)
    await advance(100)
    const error = await settledReason(watch.failed)
    expect((error as ModelDownloadError).reason).toBe('stalled')
    expect((error as ModelDownloadError).asset).toBe('runtime')
    await settledReason(model)
    await settledReason(runtime)
    watch.dispose()
  })

  test('unread error responses do not count as stalled downloads', async () => {
    const { timers, advance } = fakeTimers()
    const watch = createLoadWatch(
      async () => streamResponse([new Uint8Array(1)], { status: 404 }),
      { stallMs: 1000, startMs: 5000, timers },
    )
    expect((await watch.fetch('https://x.test/missing')).status).toBe(404)
    await advance(4000)
    expect(watch.signal.aborted).toBe(false)
    watch.dispose()
  })

  test('bounds initialization when nothing is downloading', async () => {
    const { timers, advance } = fakeTimers()
    const watch = createLoadWatch(async () => streamResponse([]), {
      stallMs: 1000,
      startMs: 5000,
      timers,
    })
    await advance(4000)
    watch.touch()
    await advance(4999)
    expect(watch.signal.aborted).toBe(false)
    await advance(1)
    expect(await settledReason(watch.failed)).toBeInstanceOf(
      ModelStartTimeoutError,
    )
    expect(watch.downloadFailure).toBeUndefined()
  })

  test('dispose stops the watchdog', async () => {
    const { timers, advance, pending } = fakeTimers()
    const watch = createLoadWatch(async () => streamResponse([]), {
      stallMs: 1000,
      startMs: 5000,
      timers,
    })
    watch.dispose()
    expect(pending.size).toBe(0)
    await advance(10_000)
    expect(watch.signal.aborted).toBe(false)
  })
})
