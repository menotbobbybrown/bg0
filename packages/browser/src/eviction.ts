/**
 * Evict a damaged cached file once per copy that failed.
 *
 * `copyOf` reports which copy of a file is current. `evict` must change it
 * before returning its promise. Every load that reads the file records which
 * copy it read. Loads of one file on different providers, and every caller
 * that shared a load, may all fail on the same damaged copy. The first failure
 * evicts it; the rest share that eviction instead of evicting again, because
 * by then a retry may be writing a fresh download and a second eviction would
 * delete it. A load that read the current copy evicts it, even after earlier
 * evictions.
 *
 * A load without a recorded copy joined another load's read of the file, so
 * it cannot tell which copy it got. The load it joined read the same bytes and
 * evicts them if they are damaged, so a load without a copy never evicts and
 * cannot delete a copy that a retry wrote since.
 */
export function createFailureEvictions<T>(
  evict: (target: T) => Promise<void>,
  keyOf: (target: T) => string,
  copyOf: (target: T) => number,
) {
  const evictions = new Map<string, Promise<void>>()
  return {
    fail(target: T, copy: number | undefined): Promise<void> {
      const key = keyOf(target)
      if (copy === undefined || copy !== copyOf(target)) {
        // Another load evicts, or has evicted, the copy this load read.
        return evictions.get(key) ?? Promise.resolve()
      }
      const evicted = evict(target)
      evictions.set(key, evicted)
      return evicted
    },
  }
}
