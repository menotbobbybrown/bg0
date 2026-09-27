import type { RemovalProgress } from '@bg0/browser'

// When Safari runs out of memory it kills the tab's process and reloads the
// page, so no failure event is ever sent. A marker in sessionStorage survives
// that reload and lets the next page load explain what happened.
//
// Browsers copy sessionStorage into tabs opened from this one and into
// duplicated tabs, so a marker alone can belong to a run that is still going
// in another tab. Each run therefore holds a Web Lock named after the marker's
// random id. Locks are released when a page dies, so a marker whose lock is
// still held belongs to a live run and is left alone.
//
// Privacy: the marker holds only the stage, the provider, the start time, and
// a random id. Never add image data, filenames, dimensions, or URLs.
export const RUN_MARKER_KEY = 'bg0:active-removal'
// A marker older than this is from an earlier visit, not this reload.
export const RUN_MARKER_MAX_AGE_MS = 10 * 60_000
// With no progress for this long, a run is treated as hung.
export const RUN_STALL_MS = 5 * 60_000

export type RunStage = RemovalProgress['stage']
// 'unknown' until the browser package reports the provider it actually chose.
export type RunProvider = 'wasm' | 'webgpu' | 'unknown'

interface RunMarker {
  stage: RunStage
  provider: RunProvider
  startedAt: number
  // Missing on markers written before run locks existed.
  id?: string
}

/** The part of the Web Locks API the marker uses. */
export type RunLocks = Pick<LockManager, 'request' | 'query'>

const STAGES: readonly RunStage[] = [
  'preparing',
  'downloading',
  'processing',
  'finishing',
]
const PROVIDERS: readonly RunProvider[] = ['wasm', 'webgpu', 'unknown']

export function runLockName(id: string) {
  return `${RUN_MARKER_KEY}:${id}`
}

function sessionStore(): Storage | undefined {
  try {
    return window.sessionStorage
  } catch {
    return undefined
  }
}

function webLocks(): RunLocks | undefined {
  try {
    return globalThis.navigator?.locks ?? undefined
  } catch {
    return undefined
  }
}

function randomId() {
  try {
    return crypto.randomUUID()
  } catch {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  }
}

function read(storage: Storage | undefined): RunMarker | undefined {
  try {
    const raw = storage?.getItem(RUN_MARKER_KEY)
    if (!raw) return undefined
    const value = JSON.parse(raw) as Partial<RunMarker>
    if (
      !STAGES.includes(value.stage as RunStage) ||
      !PROVIDERS.includes(value.provider as RunProvider) ||
      typeof value.startedAt !== 'number' ||
      (value.id !== undefined && typeof value.id !== 'string')
    )
      return undefined
    return {
      stage: value.stage as RunStage,
      provider: value.provider as RunProvider,
      startedAt: value.startedAt,
      id: value.id,
    }
  } catch {
    return undefined
  }
}

function write(storage: Storage | undefined, marker: Required<RunMarker>) {
  try {
    storage?.setItem(
      RUN_MARKER_KEY,
      JSON.stringify({
        stage: marker.stage,
        provider: marker.provider,
        startedAt: marker.startedAt,
        id: marker.id,
      }),
    )
  } catch {
    // Storage can be full or disabled. Losing the marker only loses the notice.
  }
}

function sameMarker(a: RunMarker | undefined, b: RunMarker) {
  return a?.id === b.id && a?.startedAt === b.startedAt
}

export interface RunMarkerHandle {
  update(stage: RunStage, provider?: RunProvider): void
  clear(): void
}

/** Record that a removal is in progress. Clearing only removes this run's marker. */
export function startRunMarker(
  storage = sessionStore(),
  now = Date.now(),
  locks = webLocks(),
): RunMarkerHandle {
  const id = randomId()
  const startedAt = now
  let stage: RunStage = 'preparing'
  let provider: RunProvider = 'unknown'
  let active = true
  let release = () => {}
  if (locks) {
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    try {
      locks.request(runLockName(id), () => held).catch(() => {})
    } catch {
      // Without the lock, other tabs fall back to reporting a copied marker.
    }
  }
  write(storage, { stage, provider, startedAt, id })
  const owned = () => read(storage)?.id === id
  return {
    update(next, nextProvider = provider) {
      if (!active || (next === stage && nextProvider === provider)) return
      stage = next
      provider = nextProvider
      if (owned()) write(storage, { stage, provider, startedAt, id })
    },
    clear() {
      if (!active) return
      active = false
      release()
      try {
        if (owned()) storage?.removeItem(RUN_MARKER_KEY)
      } catch {
        // Nothing else to clean up.
      }
    },
  }
}

/** Remove any marker without reporting it, for example when the page is left on purpose. */
export function clearRunMarker(storage = sessionStore()) {
  try {
    storage?.removeItem(RUN_MARKER_KEY)
  } catch {
    // Nothing else to clean up.
  }
}

async function runIsAlive(locks: RunLocks | undefined, id: string | undefined) {
  if (!locks || !id) return false
  try {
    const name = runLockName(id)
    const { held = [], pending = [] } = await locks.query()
    return [...held, ...pending].some((lock) => lock.name === name)
  } catch {
    return false
  }
}

/**
 * Return and remove a marker left by a page that died mid-run. Call this once
 * when the remover mounts. A marker whose run still holds its lock in another
 * tab is kept and not reported. Missing or stale markers are dropped before
 * the returned promise first yields.
 */
export async function takeInterruptedRun(
  storage = sessionStore(),
  now = Date.now(),
  locks = webLocks(),
): Promise<{ stage: RunStage; provider: RunProvider } | undefined> {
  const marker = read(storage)
  const age = marker ? now - marker.startedAt : -1
  if (!marker || age < 0 || age > RUN_MARKER_MAX_AGE_MS) {
    clearRunMarker(storage)
    return undefined
  }
  if (await runIsAlive(locks, marker.id)) return undefined
  // A new run in this tab, or another call, may have replaced or taken the
  // marker while the lock query was pending.
  if (!sameMarker(read(storage), marker)) return undefined
  clearRunMarker(storage)
  return { stage: marker.stage, provider: marker.provider }
}

export const INTERRUPTED_RUN_MESSAGE =
  'The page reloaded before your last image finished, usually because the browser ran out of memory. Try a smaller image or a desktop browser.'

export const STALLED_RUN_MESSAGE =
  'Processing stopped responding. Try again, or try a smaller image or a desktop browser.'

/**
 * Call onStall if no progress arrives for `ms`. Every call to `touch` restarts
 * the timer, so long downloads that keep reporting progress never trip it.
 */
export function createStallGuard(onStall: () => void, ms = RUN_STALL_MS) {
  let timer: ReturnType<typeof setTimeout> | undefined
  const arm = () => {
    clearTimeout(timer)
    timer = setTimeout(onStall, ms)
  }
  arm()
  return {
    touch: arm,
    stop() {
      clearTimeout(timer)
      timer = undefined
    },
  }
}
