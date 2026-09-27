import type { RemovalProgress } from '@bg0/browser'

// When Safari runs out of memory it kills the tab's process and reloads the
// page, so no failure event is ever sent. A marker in sessionStorage survives
// that reload and lets the next page load explain what happened.
//
// Privacy: the marker holds only the stage, the provider, and the start
// time. Never add image data, filenames, dimensions, or URLs.
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
}

const STAGES: readonly RunStage[] = [
  'preparing',
  'downloading',
  'processing',
  'finishing',
]
const PROVIDERS: readonly RunProvider[] = ['wasm', 'webgpu', 'unknown']

let lastStartedAt = 0

function sessionStore(): Storage | undefined {
  try {
    return window.sessionStorage
  } catch {
    return undefined
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
      typeof value.startedAt !== 'number'
    )
      return undefined
    return {
      stage: value.stage as RunStage,
      provider: value.provider as RunProvider,
      startedAt: value.startedAt,
    }
  } catch {
    return undefined
  }
}

function write(storage: Storage | undefined, marker: RunMarker) {
  try {
    storage?.setItem(
      RUN_MARKER_KEY,
      JSON.stringify({
        stage: marker.stage,
        provider: marker.provider,
        startedAt: marker.startedAt,
      }),
    )
  } catch {
    // Storage can be full or disabled. Losing the marker only loses the notice.
  }
}

export interface RunMarkerHandle {
  update(stage: RunStage, provider?: RunProvider): void
  clear(): void
}

/** Record that a removal is in progress. Clearing only removes this run's marker. */
export function startRunMarker(
  storage = sessionStore(),
  now = Date.now(),
): RunMarkerHandle {
  // startedAt doubles as the run's identity, so keep it unique within the tab.
  const startedAt = Math.max(now, lastStartedAt + 1)
  lastStartedAt = startedAt
  let stage: RunStage = 'preparing'
  let provider: RunProvider = 'unknown'
  let active = true
  write(storage, { stage, provider, startedAt })
  const owned = () => read(storage)?.startedAt === startedAt
  return {
    update(next, nextProvider = provider) {
      if (!active || (next === stage && nextProvider === provider)) return
      stage = next
      provider = nextProvider
      if (owned()) write(storage, { stage, provider, startedAt })
    },
    clear() {
      if (!active) return
      active = false
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

/**
 * Return and remove a marker left by a page that died mid-run. Call this once
 * when the remover mounts, before any new run can write its own marker.
 */
export function takeInterruptedRun(
  storage = sessionStore(),
  now = Date.now(),
): { stage: RunStage; provider: RunProvider } | undefined {
  const marker = read(storage)
  clearRunMarker(storage)
  if (!marker) return undefined
  const age = now - marker.startedAt
  if (age < 0 || age > RUN_MARKER_MAX_AGE_MS) return undefined
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
