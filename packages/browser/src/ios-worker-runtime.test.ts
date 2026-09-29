import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

// Exercise the shipped worker handler with deterministic runtime tensors.
const source = readFileSync(
  new URL('../vendor/ios/worker.mjs', import.meta.url),
  'utf8',
)
  .replaceAll(
    'import.meta.url',
    JSON.stringify('https://example.test/worker.mjs'),
  )
  .replace('await import(/* @vite-ignore */ runtimeUrl)', 'await loadRuntime()')

test.each([-100, 100, 0, NaN])(
  'worker handles uniform logits %s without confusing valid masks with corruption',
  async (logit) => {
    const messages: { id?: number; error?: string; alpha?: ArrayBuffer }[] = []
    let released = 0
    const scope = {
      onmessage: undefined as unknown as (event: {
        data: object
      }) => Promise<void>,
      postMessage: (data: (typeof messages)[number]) => messages.push(data),
    }
    const runtime = {
      env: { wasm: {} },
      Tensor: class {
        dispose() {
          released++
        }
      },
      InferenceSession: {
        create: async () => ({
          inputNames: ['input'],
          outputNames: ['output'],
          run: async () => ({
            output: {
              data: new Float32Array(512 * 512).fill(logit),
              dispose() {
                released++
              },
            },
          }),
        }),
      },
    }
    runInNewContext(source, {
      URL,
      self: scope,
      loadRuntime: async () => runtime,
      fetch: async () => ({
        ok: true,
        arrayBuffer: async () => new ArrayBuffer(1),
      }),
    })
    await scope.onmessage({ data: { id: 1, type: 'load' } })
    await scope.onmessage({
      data: { id: 2, type: 'run', buffer: new ArrayBuffer(512 * 512 * 3 * 4) },
    })
    const result = messages.find((m) => m.id === 2)!
    if (Number.isFinite(logit)) {
      expect(result.error).toBeUndefined()
      expect(new Float32Array(result.alpha!)[0]).toBeCloseTo(
        1 / (1 + Math.exp(-logit)),
      )
    } else expect(result.error).toBe('inference-failed')
    expect(released).toBe(2)
  },
)

const MODEL_BYTES = 55563408

function loadWorker(
  body: Uint8Array[] | undefined,
  create: () => Promise<object> = async () => ({}),
  now?: () => number,
) {
  const messages: {
    id?: number
    error?: string
    stage?: string
    progress?: number
    ready?: boolean
  }[] = []
  let received = 0
  const scope = {
    onmessage: undefined as unknown as (event: {
      data: object
    }) => Promise<void>,
    postMessage: (data: (typeof messages)[number]) => messages.push(data),
  }
  runInNewContext(source, {
    ...(now ? { Date: { now } } : {}),
    URL,
    Uint8Array,
    RangeError,
    self: scope,
    loadRuntime: async () => ({
      env: { wasm: {} },
      InferenceSession: {
        create: async (bytes: Uint8Array) => {
          received = bytes.byteLength
          return create()
        },
      },
    }),
    fetch: async () => ({
      ok: true,
      body: body && {
        getReader: () => {
          const chunks = [...body]
          return {
            read: async () =>
              chunks.length
                ? { done: false, value: chunks.shift() }
                : { done: true },
          }
        },
      },
      arrayBuffer: async () => new ArrayBuffer(1),
    }),
  })
  return {
    messages,
    received: () => received,
    load: () => scope.onmessage({ data: { id: 1, type: 'load' } }),
  }
}

test('worker model size matches the pinned manifest', () => {
  const manifest = JSON.parse(
    readFileSync(
      new URL('../vendor/ios/manifest.json', import.meta.url),
      'utf8',
    ),
  )
  expect(manifest.files['int8-full-512.ort'].bytes).toBe(MODEL_BYTES)
  expect(source).toContain(`const MODEL_BYTES = ${MODEL_BYTES};`)
})

test('worker streams the model into one exact buffer and reports progress', async () => {
  const chunk = new Uint8Array(MODEL_BYTES / 4)
  const worker = loadWorker([chunk, chunk, chunk, chunk])
  await worker.load()
  expect(worker.received()).toBe(MODEL_BYTES)
  const progress = worker.messages
    .filter((m) => m.stage === 'loading' && m.progress !== undefined)
    .map((m) => m.progress)
  expect(progress).toEqual([0.25, 0.5, 0.75, 1])
  expect(worker.messages.at(-1)).toEqual({ id: 1, ready: true })
})

test('a slow download still reports every few seconds', async () => {
  // Chunks far below the 2% step, arriving 6 seconds apart.
  const small = new Uint8Array(1024)
  const rest = new Uint8Array(MODEL_BYTES - 3 * 1024)
  let clock = 0
  const worker = loadWorker([small, small, small, rest], undefined, () => {
    clock += 6000
    return clock
  })
  await worker.load()
  const progress = worker.messages.filter(
    (m) => m.stage === 'loading' && m.progress !== undefined,
  )
  expect(progress.length).toBe(4)
})

test.each([
  ['short', [new Uint8Array(10)]],
  ['oversized', [new Uint8Array(MODEL_BYTES), new Uint8Array(1)]],
])('worker rejects a %s model download', async (_, chunks) => {
  const worker = loadWorker(chunks)
  await worker.load()
  expect(worker.messages.at(-1)).toEqual({ id: 1, error: 'model-load-failed' })
})

test.each([
  ['RangeError', () => new RangeError('Array buffer allocation failed')],
  ['WASM abort', () => new Error('Aborted(OOM)')],
  ['allocation text', () => new Error('failed to allocate a buffer')],
])('worker reports %s as out of memory', async (_, error) => {
  const worker = loadWorker(undefined, async () => {
    throw error()
  })
  await worker.load()
  expect(worker.messages.at(-1)).toEqual({ id: 1, error: 'out-of-memory' })
})
