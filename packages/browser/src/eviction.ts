/**
 * Evict a damaged cached file once per copy that failed.
 *
 * `copyOf` reports which copy of a file is current. `evict` must change it
 * before returning its promise. Every load records which copy it read. Loads of one file on
 * different providers, and every caller that shared a load, may all fail on
 * the same damaged copy. The first failure evicts it; the rest share that
 * eviction instead of evicting again, because by then a retry may be writing
 * a fresh download and a second eviction would delete it. A load that read
 * the current copy evicts it, even after earlier evictions. A failure without
 * a recorded copy always evicts.
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
      if (copy !== undefined && copy !== copyOf(target)) {
        // The copy this load read has already been evicted.
        return evictions.get(key) ?? Promise.resolve()
      }
      const evicted = evict(target)
      evictions.set(key, evicted)
      return evicted
    },
  }
}
