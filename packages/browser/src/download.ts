/**
 * Download supervision for model and runtime files.
 *
 * Transformers.js fetches model weights and the ONNX Runtime binary with
 * plain `fetch` and waits on the body with no timeout. A connection that stops
 * delivering bytes therefore leaves the caller waiting forever. This module
 * wraps `fetch` so each model-load attempt can watch its own requests, abort
 * them when they stop making progress, and report why an attempt failed.
 *
 * Only asset URLs and byte counts pass through here. Image data never does.
 */

export type DownloadFailureReason = 'network' | 'stalled' | 'incomplete'

/**
 * What failed to download. Model files are shared by every runtime, while
 * runtime files, such as the ONNX Runtime binary, differ per provider.
 */
export type DownloadAsset = 'model' | 'runtime'

export class ModelDownloadError extends Error {
  readonly reason: DownloadFailureReason
  readonly asset: DownloadAsset

  constructor(
    reason: DownloadFailureReason,
    message: string,
    options?: ErrorOptions & { asset?: DownloadAsset },
  ) {
    super(message, options)
    this.name = 'ModelDownloadError'
    this.reason = reason
    this.asset = options?.asset ?? 'model'
  }
}

export class ModelStartTimeoutError extends Error {
  constructor() {
    super('The model did not finish initializing in time')
    this.name = 'ModelStartTimeoutError'
  }
}

export interface Timers {
  now: () => number
  setTimeout: (callback: () => void, ms: number) => unknown
  clearTimeout: (handle: unknown) => void
}

export const defaultTimers: Timers = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
  clearTimeout: (handle) =>
    globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
}

/**
 * Limits for one model-load attempt. A healthy connection delivers a chunk
 * every few hundred milliseconds, so 30 seconds without one means the
 * download is stuck. Starting the full model on a slow CPU can take a minute,
 * so initialization gets a wider limit. Mutable so tests can shorten them.
 */
export const modelLoadTimings = {
  stallMs: 30_000,
  startMs: 150_000,
}

export interface LoadWatchOptions {
  /** Abort when requests are open but no bytes arrive for this long. */
  stallMs: number
  /** Give up when this long passes with no request open and no progress. */
  startMs: number
  /** Expected byte size for exact URLs; a shorter body is rejected. */
  expectedBytes?: (url: string) => number | undefined
  /** Classify a request URL. Unclassified requests count as model files. */
  assetOf?: (url: string) => DownloadAsset
  timers?: Timers
}

export interface LoadWatch {
  readonly signal: AbortSignal
  /** Resolves never; rejects when the attempt stalls or times out. */
  readonly failed: Promise<never>
  /** The first download failure seen by this attempt, if any. */
  readonly downloadFailure: ModelDownloadError | undefined
  /** Record progress from any source, such as a library progress event. */
  touch: () => void
  fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
  dispose: () => void
}

type OpenRequest = {
  asset: DownloadAsset
  /** Set while the request waits on the network for headers or a chunk. */
  waitingSince: number | undefined
}

type Fetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.href
  return input.url
}

function combineSignals(signals: AbortSignal[]): AbortSignal {
  if (signals.length === 1) return signals[0]
  if (typeof AbortSignal.any === 'function') return AbortSignal.any(signals)
  const controller = new AbortController()
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort(signal.reason)
      break
    }
    signal.addEventListener('abort', () => controller.abort(signal.reason), {
      once: true,
    })
  }
  return controller.signal
}

/**
 * Supervise one model-load attempt. Requests made through `watch.fetch` feed
 * a watchdog. Each open request keeps its own clock, so a file that stops
 * delivering bytes aborts the attempt after `stallMs` even while another
 * file is still downloading. A request is only owed bytes while it waits for
 * headers or for a chunk the reader asked for. With nothing downloading, `startMs` bounds the
 * wait for cache reads and runtime initialization, so the caller can always
 * surface an error instead of waiting indefinitely.
 */
export function createLoadWatch(
  baseFetch: Fetch,
  options: LoadWatchOptions,
): LoadWatch {
  const timers = options.timers ?? defaultTimers
  const controller = new AbortController()
  const requests = new Set<OpenRequest>()
  let lastActivity = timers.now()
  let timer: unknown
  let disposed = false
  let downloadFailure: ModelDownloadError | undefined
  let rejectFailed: (error: Error) => void = () => undefined
  const failed = new Promise<never>((_resolve, reject) => {
    rejectFailed = reject
  })
  // Callers race this promise; an unobserved rejection must not be reported.
  failed.catch(() => undefined)

  const fail = (error: Error) => {
    if (disposed || controller.signal.aborted) return
    if (error instanceof ModelDownloadError) downloadFailure ??= error
    controller.abort(error)
    rejectFailed(error)
    stop()
  }

  const stop = () => {
    if (timer !== undefined) timers.clearTimeout(timer)
    timer = undefined
  }

  /** The earliest deadline, and the asset that stalls if it passes. */
  const nextDeadline = (): { at: number; asset?: DownloadAsset } => {
    if (requests.size === 0) return { at: lastActivity + options.startMs }
    let waiting: { at: number; asset: DownloadAsset } | undefined
    for (const request of requests) {
      if (request.waitingSince === undefined) continue
      const at = request.waitingSince + options.stallMs
      if (!waiting || at < waiting.at) waiting = { at, asset: request.asset }
    }
    if (waiting) return waiting
    // Open bodies nobody is reading still count as an attempt in progress.
    const model = [...requests].some((request) => request.asset === 'model')
    return {
      at: lastActivity + options.stallMs,
      asset: model ? 'model' : 'runtime',
    }
  }

  const schedule = () => {
    stop()
    if (disposed || controller.signal.aborted) return
    const remaining = nextDeadline().at - timers.now()
    timer = timers.setTimeout(check, Math.max(0, remaining))
  }

  const check = () => {
    timer = undefined
    const deadline = nextDeadline()
    if (timers.now() < deadline.at) {
      schedule()
      return
    }
    if (deadline.asset) {
      fail(
        new ModelDownloadError(
          'stalled',
          'The model download stopped making progress',
          { asset: deadline.asset },
        ),
      )
    } else {
      fail(new ModelStartTimeoutError())
    }
  }

  const touch = () => {
    lastActivity = timers.now()
  }

  const recordFailure = (error: ModelDownloadError) => {
    downloadFailure ??= error
    return error
  }

  const watchedFetch: Fetch = async (input, init) => {
    if (controller.signal.aborted) throw controller.signal.reason
    const url = urlOf(input)
    const asset = options.assetOf?.(url) ?? 'model'
    const request: OpenRequest = { asset, waitingSince: timers.now() }
    requests.add(request)
    touch()
    schedule()
    let response: Response
    try {
      const signals = [controller.signal]
      if (init?.signal) signals.push(init.signal)
      response = await baseFetch(input, {
        ...init,
        signal: combineSignals(signals),
      })
    } catch (error) {
      requests.delete(request)
      touch()
      schedule()
      if (controller.signal.aborted) throw controller.signal.reason
      throw recordFailure(
        new ModelDownloadError('network', 'A model file could not be fetched', {
          cause: error,
          asset,
        }),
      )
    }
    request.waitingSince = undefined
    touch()
    if (response.status >= 500 || response.status === 408) {
      recordFailure(
        new ModelDownloadError(
          'network',
          `The model host responded with ${response.status}`,
          { asset },
        ),
      )
    }
    // Only full-body downloads are supervised. Error pages, range probes and
    // opaque responses may legitimately go unread.
    if (
      !response.body ||
      response.status !== 200 ||
      response.type === 'opaque'
    ) {
      requests.delete(request)
      schedule()
      return response
    }

    const reader = response.body.getReader()
    const declared = Number(response.headers.get('content-length'))
    const expected =
      options.expectedBytes?.(response.url || url) ??
      options.expectedBytes?.(url) ??
      (response.headers.has('content-encoding') ||
      !Number.isFinite(declared) ||
      declared <= 0
        ? undefined
        : declared)
    let received = 0
    let open = true
    const finish = () => {
      if (!open) return
      open = false
      controller.signal.removeEventListener('abort', cancelOnAbort)
      requests.delete(request)
      touch()
      schedule()
    }

    // Some transports ignore the abort signal once headers arrive. Cancel the
    // reader directly so a stalled body always settles.
    const cancelOnAbort = () => {
      reader.cancel(controller.signal.reason).catch(() => undefined)
    }
    controller.signal.addEventListener('abort', cancelOnAbort, { once: true })

    const body = new ReadableStream<Uint8Array>({
      async pull(stream) {
        // The pending timer is never later than this new deadline.
        request.waitingSince = timers.now()
        try {
          const { done, value } = await reader.read()
          request.waitingSince = undefined
          if (controller.signal.aborted) {
            finish()
            stream.error(controller.signal.reason)
            return
          }
          if (done) {
            finish()
            if (expected !== undefined && received < expected) {
              const error = recordFailure(
                new ModelDownloadError(
                  'incomplete',
                  'The model download ended early',
                  { asset },
                ),
              )
              stream.error(error)
              return
            }
            stream.close()
            return
          }
          received += value.byteLength
          touch()
          stream.enqueue(value)
        } catch (error) {
          finish()
          if (controller.signal.aborted) {
            stream.error(controller.signal.reason)
            return
          }
          stream.error(
            recordFailure(
              new ModelDownloadError(
                'network',
                'The model download was interrupted',
                { cause: error, asset },
              ),
            ),
          )
        }
      },
      cancel(reason) {
        finish()
        return reader.cancel(reason)
      },
    })

    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    })
  }

  schedule()

  return {
    signal: controller.signal,
    failed,
    get downloadFailure() {
      return downloadFailure
    },
    touch,
    fetch: watchedFetch,
    dispose() {
      disposed = true
      stop()
    },
  }
}
