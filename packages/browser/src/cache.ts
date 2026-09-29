/**
 * IndexedDB-backed model cache.
 *
 * The Cache API that transformers.js uses by default only exists in secure
 * contexts, so a page served over plain http (a LAN or tailnet address during
 * development) re-downloads the model on every visit. IndexedDB works in both
 * contexts, so this adapter implements the two methods transformers.js needs
 * from a cache, `match` and `put`, on top of it.
 *
 * Files are stored in chunks so a 200 MB model never becomes a single record,
 * and `createSafeCache` runs writes in the background so inference is never
 * held up by disk.
 */

const DB_NAME = 'bg0-model-cache'
const STORE = 'files'
const DB_VERSION = 1
const CHUNK_BYTES = 16 * 1024 * 1024

interface FileMeta {
  headers: [string, string][]
  size: number
  chunks: number
}

export interface ModelCache {
  match(request: RequestInfo | URL): Promise<Response | undefined>
  put(request: RequestInfo | URL, response: Response): Promise<void>
  delete?(request: RequestInfo | URL): Promise<boolean>
}

function keyOf(request: RequestInfo | URL): string {
  if (typeof request === 'string') return request
  if (request instanceof URL) return request.href
  return request.url
}

function metaKey(key: string) {
  return `${key}#meta`
}

function chunkKey(key: string, index: number) {
  return `${key}#${index}`
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(DB_NAME, DB_VERSION)
    open.onupgradeneeded = () => {
      if (!open.result.objectStoreNames.contains(STORE)) {
        open.result.createObjectStore(STORE)
      }
    }
    open.onsuccess = () => resolve(open.result)
    open.onerror = () =>
      reject(open.error ?? new Error('IndexedDB unavailable'))
    open.onblocked = () => reject(new Error('IndexedDB is blocked'))
  })
}

function request<T>(operation: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    operation.onsuccess = () => resolve(operation.result)
    operation.onerror = () =>
      reject(operation.error ?? new Error('IndexedDB request failed'))
  })
}

function settle(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onerror = () =>
      reject(transaction.error ?? new Error('IndexedDB transaction failed'))
    transaction.onabort = () =>
      reject(transaction.error ?? new Error('IndexedDB transaction aborted'))
  })
}

export function isIndexedDbAvailable(): boolean {
  return typeof indexedDB !== 'undefined'
}

export function createIndexedDbCache(): ModelCache {
  let database: Promise<IDBDatabase> | undefined
  const db = () => {
    if (!database) database = openDatabase()
    return database
  }
  const pendingWrites = new Set<string>()

  async function write(
    key: string,
    body: ArrayBuffer,
    headers: [string, string][],
  ) {
    const chunks = Math.max(1, Math.ceil(body.byteLength / CHUNK_BYTES))
    const connection = await db()
    for (let index = 0; index < chunks; index += 1) {
      const transaction = connection.transaction(STORE, 'readwrite')
      const slice = body.slice(index * CHUNK_BYTES, (index + 1) * CHUNK_BYTES)
      transaction.objectStore(STORE).put(slice, chunkKey(key, index))
      await settle(transaction)
    }
    const meta: FileMeta = { headers, size: body.byteLength, chunks }
    const transaction = connection.transaction(STORE, 'readwrite')
    transaction.objectStore(STORE).put(meta, metaKey(key))
    await settle(transaction)
  }

  return {
    async match(input) {
      const key = keyOf(input)
      if (pendingWrites.has(key)) return undefined
      try {
        const connection = await db()
        const store = connection
          .transaction(STORE, 'readonly')
          .objectStore(STORE)
        const meta = await request<FileMeta | undefined>(
          store.get(metaKey(key)),
        )
        if (!meta) return undefined
        const parts: ArrayBuffer[] = []
        for (let index = 0; index < meta.chunks; index += 1) {
          const chunkStore = connection
            .transaction(STORE, 'readonly')
            .objectStore(STORE)
          const chunk = await request<ArrayBuffer | undefined>(
            chunkStore.get(chunkKey(key, index)),
          )
          if (!chunk) return undefined
          parts.push(chunk)
        }
        const headers = new Headers(meta.headers)
        headers.set('content-length', String(meta.size))
        return new Response(new Blob(parts), { headers })
      } catch {
        return undefined
      }
    },
    async delete(input) {
      const key = keyOf(input)
      try {
        const connection = await db()
        const store = connection
          .transaction(STORE, 'readonly')
          .objectStore(STORE)
        const meta = await request<FileMeta | undefined>(
          store.get(metaKey(key)),
        )
        if (!meta) return false
        const transaction = connection.transaction(STORE, 'readwrite')
        const writable = transaction.objectStore(STORE)
        writable.delete(metaKey(key))
        for (let index = 0; index < meta.chunks; index += 1) {
          writable.delete(chunkKey(key, index))
        }
        await settle(transaction)
        return true
      } catch {
        return false
      }
    },
    async put(input, response) {
      const key = keyOf(input)
      const body = await response.arrayBuffer()
      const headers: [string, string][] = []
      for (const [name, value] of response.headers) {
        if (name.toLowerCase() !== 'content-length') headers.push([name, value])
      }
      // Resolve only once the write settles so an eviction can tell when a
      // late write has landed. `createSafeCache` keeps loads from waiting on
      // it. A failed write only means the next visit downloads again.
      pendingWrites.add(key)
      await write(key, body, headers)
        .catch((error) => {
          console.warn('BG0 could not cache the model locally:', error)
        })
        .finally(() => pendingWrites.delete(key))
    },
  }
}

export async function clearIndexedDbCache(): Promise<void> {
  if (!isIndexedDbAvailable()) return
  await new Promise<void>((resolve) => {
    const req = indexedDB.deleteDatabase(DB_NAME)
    req.onsuccess = () => resolve()
    req.onerror = () => resolve()
    req.onblocked = () => resolve()
  })
}

/** How long a write waits behind an eviction before it is dropped. */
const EVICTION_WAIT_MS = 30_000

async function settlesWithin(
  promise: Promise<unknown>,
  ms: number,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms)
  })
  try {
    return await Promise.race([promise.then(() => true), timeout])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Make a cache safe to hand to transformers.js.
 *
 * transformers.js awaits `put` before it reports a file as loaded, and some
 * of its call sites do not catch a rejected write. A full disk, a quota
 * error or a private-mode restriction would then fail or delay the model load
 * even though the bytes are already in memory. Writes here start immediately
 * but are never awaited, and their errors are dropped: a failed write only
 * means the next visit downloads again.
 *
 * Reads that fail count as a miss. A cached entry whose recorded size differs
 * from the expected size is removed instead of being handed to the runtime,
 * because a truncated model fails every later load until it is replaced.
 *
 * Eviction reads the key as a miss until its delete finishes, so a load that
 * starts meanwhile cannot read the rejected file. A model can also be rejected
 * before its own background write lands, so eviction also waits for every
 * write already in flight to settle and then deletes again: a late write
 * cannot restore the evicted file. A write that starts during an eviction is
 * held until the eviction finishes, so its delete cannot remove it. If the
 * eviction does not finish within `evictionWaitMs`, that write is dropped
 * instead.
 */
export function createSafeCache(
  open: () => Promise<ModelCache | undefined>,
  expectedBytes: (url: string) => number | undefined = () => undefined,
  evictionWaitMs = EVICTION_WAIT_MS,
): ModelCache & { delete(request: RequestInfo | URL): Promise<boolean> } {
  let opened: Promise<ModelCache | undefined> | undefined
  const cache = () => {
    opened ??= open().catch(() => undefined)
    return opened
  }
  const writes = new Map<string, Set<Promise<void>>>()
  const evicting = new Map<string, Promise<unknown>>()
  const remove = async (input: RequestInfo | URL) => {
    try {
      return Boolean(await (await cache())?.delete?.(input))
    } catch {
      return false
    }
  }
  const evict = (input: RequestInfo | URL) => {
    const key = keyOf(input)
    const removed = remove(input)
    const pending = writes.get(key)
    const settled = Promise.all([
      evicting.get(key),
      removed,
      pending?.size
        ? Promise.all(pending).then(() => remove(input))
        : undefined,
    ])
    evicting.set(key, settled)
    void settled.finally(() => {
      if (evicting.get(key) === settled) evicting.delete(key)
    })
    return removed
  }

  return {
    async match(input) {
      if (evicting.has(keyOf(input))) return undefined
      let response: Response | undefined
      try {
        response = (await (await cache())?.match(input)) ?? undefined
      } catch {
        return undefined
      }
      if (!response) return undefined
      const expected = expectedBytes(keyOf(input))
      const length = response.headers.get('content-length')
      if (
        expected !== undefined &&
        length !== null &&
        Number(length) !== expected
      ) {
        await evict(input)
        return undefined
      }
      return response
    },
    async put(input, response) {
      const key = keyOf(input)
      // A write that starts during an eviction lands after its delete, so the
      // delete cannot remove this newer copy.
      const blocker = evicting.get(key)
      const write = (async () => {
        try {
          if (blocker && !(await settlesWithin(blocker, evictionWaitMs))) {
            // An earlier write hangs. Drop this one rather than hold a
            // model-sized response for as long as that write never finishes.
            return
          }
          await (await cache())?.put(input, response)
        } catch {
          // Caching is an optimization. The model is already in memory.
        }
      })()
      const pending = writes.get(key) ?? new Set()
      pending.add(write)
      writes.set(key, pending)
      void write.finally(() => {
        pending.delete(write)
        if (pending.size === 0 && writes.get(key) === pending) {
          writes.delete(key)
        }
      })
    },
    delete: evict,
  }
}
