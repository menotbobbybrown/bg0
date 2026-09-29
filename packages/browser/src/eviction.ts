/**
 * Share one eviction per failed load.
 *
 * Every caller that shared a load receives the same rejection. A caller that
 * handles it after the first eviction finished must not evict again: by then
 * the retry may be writing a fresh download, and a second eviction would
 * delete it. A rejection that is not an object cannot be tracked, so it
 * always evicts.
 */
export function createFailureEvictions<T>(
  evict: (target: T) => Promise<void>,
): (target: T, failure: unknown) => Promise<void> {
  const evictions = new WeakMap<object, Promise<void>>()
  return (target, failure) => {
    if (typeof failure !== 'object' || failure === null) return evict(target)
    let evicted = evictions.get(failure)
    if (!evicted) {
      evicted = evict(target)
      evictions.set(failure, evicted)
    }
    return evicted
  }
}
