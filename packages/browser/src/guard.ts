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
 */

const RUNNING_KEY = 'bg0:full-model-running:v1'
const BLOCKED_KEY = 'bg0:full-model-blocked:v1'
const BLOCK_MS = 7 * 24 * 60 * 60 * 1000

let running = 0

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

/** Mark full-model work as in progress. Call the returned function once when it settles. */
export function markFullModelRunning(): () => void {
  running += 1
  if (running === 1) {
    try {
      session()?.setItem(RUNNING_KEY, '1')
    } catch {
      // Crash detection is best effort.
    }
  }
  let done = false
  return () => {
    if (done) return
    done = true
    running -= 1
    if (running === 0) {
      try {
        session()?.removeItem(RUNNING_KEY)
      } catch {
        // Crash detection is best effort.
      }
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
