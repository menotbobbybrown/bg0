/**
 * Remember when the full model is too heavy for this device.
 *
 * A browser tab that runs out of memory while the 473 MB model initializes or
 * runs is killed without any JavaScript error, so the normal fallback never
 * sees a failure. A marker in sessionStorage is set while the full model is
 * starting or running and cleared when that work settles. sessionStorage
 * survives a crash-and-reload of the same tab but not other tabs, so a marker
 * found on the next detection means this tab died during full-model work. The
 * device then uses the lite model for a week.
 *
 * Reloading or leaving the page also ends the document before work settles,
 * so `pagehide` clears the marker and `pageshow` sets it again if the page
 * comes back from the back/forward cache with work still running. This is
 * done whether or not the event is `persisted`: a frozen page that is later
 * dropped from that cache was not killed by the model. A tab killed for
 * memory gets no `pagehide`, so its marker survives. The trade-off is iOS
 * Safari, which can fire `pagehide` when the user switches away and later
 * discard the hidden tab silently. That kill is not counted, which only
 * means the full model is tried again; a crash in the foreground still is.
 *
 * Duplicating a tab copies its sessionStorage, marker included. Each marker
 * therefore carries a random id, and the tab doing the work holds a Web Lock
 * named after it. A marker whose lock is still held belongs to a live tab and
 * is dropped instead of counted. A tab duplicated mid-run and used only after
 * the original finished still reads as a crash; the cost is a week of the
 * lite model.
 */

const RUNNING_KEY = 'bg0:full-model-running:v1'
const BLOCKED_KEY = 'bg0:full-model-blocked:v1'
const BLOCK_MS = 7 * 24 * 60 * 60 * 1000

type GuardLocks = Pick<LockManager, 'request' | 'query'>

let running = 0
let markerId = ''
let releaseLock: (() => void) | undefined
let markerCheck: Promise<boolean> | undefined
let stopWatchingPage: (() => void) | undefined

function session(): Storage | undefined {
  try {
    return typeof sessionStorage === 'undefined' ? undefined : sessionStorage
  } catch {
    return undefined
  }
}

function local(): Storage | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage
  } catch {
    return undefined
  }
}

function webLocks(): GuardLocks | undefined {
  try {
    return globalThis.navigator?.locks ?? undefined
  } catch {
    return undefined
  }
}

function lockName(id: string): string {
  return `${RUNNING_KEY}:${id}`
}

function randomId(): string {
  try {
    return crypto.randomUUID()
  } catch {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  }
}

async function lockIsHeld(
  locks: GuardLocks | undefined,
  id: string,
): Promise<boolean> {
  if (!locks) return false
  try {
    const name = lockName(id)
    const { held = [], pending = [] } = await locks.query()
    return [...held, ...pending].some((lock) => lock.name === name)
  } catch {
    return false
  }
}

function holdLock(locks: GuardLocks | undefined, id: string): void {
  if (!locks) return
  try {
    const held = new Promise<void>((resolve) => {
      releaseLock = resolve
    })
    locks.request(lockName(id), () => held).catch(() => undefined)
  } catch {
    // Without the lock, a duplicated tab's marker reads as a crash.
  }
}

/**
 * Decide whether a marker was left by a crash. Concurrent callers share one
 * decision, and the marker stays in place until it is made, so no caller can
 * miss it while the lock query is pending.
 */
function checkMarker(
  marker: string,
  now: number,
  locks: GuardLocks | undefined,
): Promise<boolean> {
  const check = (async () => {
    const crashed = !(await lockIsHeld(locks, marker))
    try {
      session()?.removeItem(RUNNING_KEY)
    } catch {
      // The block below still applies.
    }
    if (crashed) blockFullModel(now)
    return crashed
  })().finally(() => {
    markerCheck = undefined
  })
  markerCheck = check
  return check
}

/** Skip the full model on this device for a week. */
export function blockFullModel(now = Date.now()): void {
  try {
    local()?.setItem(BLOCKED_KEY, String(now))
  } catch {
    // Storage may be full or disabled. The in-session fallback still applies.
  }
}

/**
 * Whether the full model should be skipped. Also converts a marker left by a
 * tab that died during full-model work into a block.
 */
export async function isFullModelBlocked(
  now = Date.now(),
  locks = webLocks(),
): Promise<boolean> {
  try {
    if (markerCheck) {
      if (await markerCheck) return true
    } else {
      const marker =
        running === 0 ? session()?.getItem(RUNNING_KEY) : undefined
      if (marker && (await checkMarker(marker, now, locks))) return true
    }
    const stored = local()?.getItem(BLOCKED_KEY)
    if (stored === null || stored === undefined) return false
    const blockedAt = Number(stored)
    if (blockedAt <= now && now - blockedAt < BLOCK_MS) return true
    local()?.removeItem(BLOCKED_KEY)
  } catch {
    // Without storage, only in-session failures are remembered.
  }
  return false
}

function setMarker(): void {
  try {
    if (markerId) session()?.setItem(RUNNING_KEY, markerId)
  } catch {
    // Crash detection is best effort.
  }
}

function clearMarker(): void {
  try {
    session()?.removeItem(RUNNING_KEY)
  } catch {
    // Crash detection is best effort.
  }
}

function watchPage(): (() => void) | undefined {
  if (typeof window === 'undefined') return undefined
  const page = window
  page.addEventListener('pagehide', clearMarker)
  page.addEventListener('pageshow', setMarker)
  return () => {
    page.removeEventListener('pagehide', clearMarker)
    page.removeEventListener('pageshow', setMarker)
  }
}

/** Mark full-model work as in progress. Call the returned function once when it settles. */
export function markFullModelRunning(locks = webLocks()): () => void {
  running += 1
  if (running === 1) {
    markerId = randomId()
    holdLock(locks, markerId)
    setMarker()
    stopWatchingPage = watchPage()
  }
  let done = false
  return () => {
    if (done) return
    done = true
    running -= 1
    if (running === 0) {
      stopWatchingPage?.()
      stopWatchingPage = undefined
      clearMarker()
      releaseLock?.()
      releaseLock = undefined
      markerId = ''
    }
  }
}

export function clearFullModelGuard(): void {
  try {
    local()?.removeItem(BLOCKED_KEY)
    if (running === 0) session()?.removeItem(RUNNING_KEY)
  } catch {
    // Nothing to clear when storage is unavailable.
  }
}
