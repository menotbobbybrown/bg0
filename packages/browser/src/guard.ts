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
 */

const RUNNING_KEY = 'bg0:full-model-running:v1'
const BLOCKED_KEY = 'bg0:full-model-blocked:v1'
const BLOCK_MS = 7 * 24 * 60 * 60 * 1000

let running = 0
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
export function isFullModelBlocked(now = Date.now()): boolean {
  try {
    if (running === 0 && session()?.getItem(RUNNING_KEY)) {
      session()?.removeItem(RUNNING_KEY)
      blockFullModel(now)
      return true
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
    session()?.setItem(RUNNING_KEY, '1')
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
export function markFullModelRunning(): () => void {
  running += 1
  if (running === 1) {
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
