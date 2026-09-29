/**
 * Evict a damaged cached file once per copy that failed.
 *
 * Every load records which copy of its file it reads with `begin`. Loads of
 * one file on different providers, and every caller that shared a load, may
 * all fail on the same damaged copy. The first failure evicts it; the rest
 * share that eviction instead of evicting again, because by then a retry may
 * be writing a fresh download and a second eviction would delete it. A load
 * that began after the eviction read a newer copy, so its failure evicts
 * again. A failure without a recorded copy always evicts.
 */
export function createFailureEvictions<T>(
  evict: (target: T) => Promise<void>,
  keyOf: (target: T) => string,
) {
  const copies = new Map<string, number>()
  const evictions = new Map<string, Promise<void>>()
  return {
    begin(target: T): number {
      return copies.get(keyOf(target)) ?? 0
    },
    fail(target: T, copy: number | undefined): Promise<void> {
      const key = keyOf(target)
      const current = copies.get(key) ?? 0
      const earlier = evictions.get(key)
      if (copy !== undefined && copy !== current && earlier) return earlier
      copies.set(key, current + 1)
      const evicted = evict(target)
      evictions.set(key, evicted)
      return evicted
    },
  }
}
