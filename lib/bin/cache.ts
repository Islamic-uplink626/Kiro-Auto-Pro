import { mkdir, readFile, writeFile, rename } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import type { BinInfo } from './types'

/**
 * Disk-cached BIN lookup results, keyed by `<source>:<bin>`.
 *
 * Schema is forward-compatible: we only read keys we recognize, and write
 * the entire dict atomically (tmp + rename). TTL is per-entry, with a
 * default of 30 days (BIN data changes rarely; the cache reduces both
 * outbound traffic and rate-limit pressure on free APIs).
 */

type CacheEntry = {
  /** Cached payload (already normalized to BinInfo). */
  info: BinInfo
  /** Unix ms when the entry was written. */
  cachedAt: number
  /** Unix ms when the entry expires; consumer is free to extend on hit. */
  expiresAt: number
}

type CacheFile = {
  version: 1
  entries: Record<string, CacheEntry>
}

const DEFAULT_CACHE_PATH = 'show/bin-cache.json'
const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000 // 30 days

function cacheKey(source: string, bin: string): string {
  return `${source.toLowerCase()}:${bin}`
}

async function loadCacheFile(path: string): Promise<CacheFile> {
  const abs = resolve(path)
  try {
    const raw = await readFile(abs, 'utf-8')
    const parsed = JSON.parse(raw) as CacheFile
    if (parsed.version !== 1 || typeof parsed.entries !== 'object') {
      return { version: 1, entries: {} }
    }
    return parsed
  } catch {
    return { version: 1, entries: {} }
  }
}

async function writeCacheFileAtomic(path: string, file: CacheFile): Promise<void> {
  const abs = resolve(path)
  await mkdir(dirname(abs), { recursive: true })
  const tmp = `${abs}.tmp.${process.pid}.${Date.now()}`
  await writeFile(tmp, JSON.stringify(file, null, 2), 'utf-8')
  try {
    await rename(tmp, abs)
  } catch {
    await writeFile(abs, JSON.stringify(file, null, 2), 'utf-8')
  }
}

export class BinCache {
  private file: CacheFile = { version: 1, entries: {} }
  private path: string
  private ttlMs: number
  private dirty = false

  private constructor(path: string, ttlMs: number) {
    this.path = path
    this.ttlMs = ttlMs
  }

  static async open(
    path: string = DEFAULT_CACHE_PATH,
    ttlMs: number = DEFAULT_TTL_MS
  ): Promise<BinCache> {
    const cache = new BinCache(path, ttlMs)
    cache.file = await loadCacheFile(path)
    return cache
  }

  get(source: string, bin: string): BinInfo | null {
    const entry = this.file.entries[cacheKey(source, bin)]
    if (!entry) return null
    if (entry.expiresAt > 0 && entry.expiresAt < Date.now()) return null
    return entry.info
  }

  set(info: BinInfo): void {
    const key = cacheKey(info.source, info.bin)
    const cachedAt = info.fetchedAt || Date.now()
    const expiresAt = cachedAt + this.ttlMs
    this.file.entries[key] = { info, cachedAt, expiresAt }
    this.dirty = true
  }

  /** Persist if anything changed. Safe to call after every batch. */
  async flush(): Promise<void> {
    if (!this.dirty) return
    await writeCacheFileAtomic(this.path, this.file)
    this.dirty = false
  }

  /** Drop expired entries. Returns the number removed. */
  prune(): number {
    const now = Date.now()
    let removed = 0
    for (const [k, v] of Object.entries(this.file.entries)) {
      if (v.expiresAt > 0 && v.expiresAt < now) {
        delete this.file.entries[k]
        removed++
      }
    }
    if (removed > 0) this.dirty = true
    return removed
  }

  size(): number {
    return Object.keys(this.file.entries).length
  }

  /** All cached BinInfo rows for one BIN (any source) — expired entries skipped. */
  forBin(bin: string): BinInfo[] {
    const now = Date.now()
    return Object.values(this.file.entries)
      .filter((e) => e.info.bin === bin && (e.expiresAt <= 0 || e.expiresAt >= now))
      .map((e) => e.info)
  }
}
