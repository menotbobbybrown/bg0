/**
 * Share one eviction per failed load.
 *
 * Every caller that shared a load reports the same load. A caller that
 * handles its failure after the first eviction finished must not evict
 * again: by then the retry may be writing a fresh download, and a second
 * eviction would delete it. A retry is a new load and gets its own eviction,
 * even when it rejects with the same error object. A load that is not an
 * object cannot be tracked, so it always evicts.
 */
export function createFailureEvictions<T>(
  evict: (target: T) => Promise<void>,
): (target: T, load: unknown) => Promise<void> {
  const evictions = new WeakMap<object, Promise<void>>()
  return (target, load) => {
    if (typeof load !== 'object' || load === null) return evict(target)
    let evicted = evictions.get(load)
    if (!evicted) {
      evicted = evict(target)
      evictions.set(load, evicted)
    }
    return evicted
  }
}
