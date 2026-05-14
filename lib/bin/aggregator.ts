import { BinCache } from './cache'
import { LocalBinSource } from './sources/local-db'
import { lookupBinlist } from './sources/binlist'
import {
  searchBincheck,
  lookupBincheck as lookupBincheckSearch
} from './sources/bincheck'
import { lookupBincheckDetails } from './sources/bincheck-details'
import { VccGeneratorClient } from './sources/vccgenerator'
import { scrapeBincodes } from './sources/bincodes'
import { lookupHandyApi } from './sources/handyapi'
import { applyFilter, mergeBinInfo, type BinFilter, type BinInfo } from './types'

/**
 * Orchestrator that fans out a single BIN lookup across every available
 * source, deduplicates by `<source>:<bin>`, returns merged + per-source
 * rows, and writes successful rows back to the on-disk cache.
 *
 * Source priority (earlier wins on conflicts in the merged row):
 *
 *   1. cache         (offline, instant)
 *   2. local-db      (offline, ships free dataset)
 *   3. binlist.net   (free public REST, 5/h rate limit)
 *   4. handyapi      (free public REST, generous rate limit, multi-region)
 *   5. bincheck.io   (DataTables JSON, CF challenge possible)
 *   6. bincheck/details   (server-rendered HTML — used when JSON gated)
 *   7. vccgenerator.org   (cascading XHR, gives bank+country exact)
 *   8. bincodes.com  (stealth-browser scrape — last resort, slowest)
 *
 * The orchestrator is concurrency-aware: HTTP sources run in parallel
 * (each is independent), the scraper source runs only if every faster
 * source either failed or returned no info AND the caller opted in via
 * `enableScrapers`.
 */

export type AggregatorOptions = {
  /** Persisted cache path. Default `show/bin-cache.json`. */
  cachePath?: string
  /** Cache TTL in ms. Default 30 days. */
  cacheTtlMs?: number
  /** Local BIN dataset path. */
  localDbPath?: string
  /** Auto-download local dataset on first use. */
  autoBootstrap?: boolean
  /** Per-source request timeout (ms). Default 12_000. */
  timeoutMs?: number
  /** Honor source priority list (override default). */
  sources?: BinSourceName[]
  /** Allow heavy scraper sources (browser launch). Default false. */
  enableScrapers?: boolean
  /** Allow Cloudflare-gated bincc/bincodes via stealth browser. */
  proxyUrl?: string
  log?: (msg: string) => void
}

export type BinSourceName =
  | 'cache'
  | 'local-db'
  | 'binlist'
  | 'handyapi'
  | 'bincheck'
  | 'bincheck-details'
  | 'vccgenerator'
  | 'bincodes'

export const DEFAULT_SOURCE_PRIORITY: BinSourceName[] = [
  'cache',
  'local-db',
  'binlist',
  'handyapi',
  'bincheck',
  'bincheck-details',
  'vccgenerator',
  'bincodes'
]

export type SourceOutcome = {
  source: BinSourceName
  ok: boolean
  info?: BinInfo
  reason?: string
  durationMs: number
}

export type AggregatedLookup = {
  bin: string
  /** Merged BinInfo (earlier sources win on conflicts). null if every source failed. */
  merged: BinInfo | null
  /** Per-source raw rows for traceability / debugging. */
  perSource: BinInfo[]
  /** Per-source result, success or failure, with timing. */
  outcomes: SourceOutcome[]
}

export class BinAggregator {
  private cache: BinCache | null = null
  private localDb: LocalBinSource | null = null
  private vccGen: VccGeneratorClient | null = null
  private opts: Required<
    Pick<
      AggregatorOptions,
      'cachePath' | 'localDbPath' | 'autoBootstrap' | 'timeoutMs' | 'enableScrapers'
    >
  > & {
    cacheTtlMs?: number
    sources: BinSourceName[]
    proxyUrl?: string
    log: (m: string) => void
  }

  private constructor(opts: AggregatorOptions) {
    this.opts = {
      cachePath: opts.cachePath ?? 'show/bin-cache.json',
      cacheTtlMs: opts.cacheTtlMs,
      localDbPath: opts.localDbPath ?? 'accounts/bin-database.json',
      autoBootstrap: opts.autoBootstrap ?? true,
      timeoutMs: opts.timeoutMs ?? 12_000,
      enableScrapers: opts.enableScrapers ?? false,
      sources: opts.sources && opts.sources.length > 0 ? opts.sources : DEFAULT_SOURCE_PRIORITY,
      proxyUrl: opts.proxyUrl,
      log: opts.log ?? (() => {})
    }
  }

  static async open(opts: AggregatorOptions = {}): Promise<BinAggregator> {
    const a = new BinAggregator(opts)
    a.cache = await BinCache.open(a.opts.cachePath, a.opts.cacheTtlMs)
    return a
  }

  /** Pre-load offline sources. Idempotent. */
  async warmOffline(): Promise<void> {
    if (this.opts.sources.includes('local-db') && !this.localDb) {
      this.localDb = new LocalBinSource({
        path: this.opts.localDbPath,
        autoBootstrap: this.opts.autoBootstrap,
        log: this.opts.log
      })
      try {
        await this.localDb.load()
      } catch (e) {
        this.opts.log(
          `[bin/aggregator] local-db unavailable: ${e instanceof Error ? e.message : e}`
        )
        this.localDb = null
      }
    }
  }

  private getVccGen(): VccGeneratorClient {
    if (!this.vccGen) this.vccGen = new VccGeneratorClient({ log: this.opts.log })
    return this.vccGen
  }

  /** Main entry — full multi-source lookup for one BIN. */
  async lookup(rawBin: string): Promise<AggregatedLookup> {
    const bin = rawBin.replace(/\D+/g, '')
    if (bin.length < 6 || bin.length > 8) {
      return {
        bin,
        merged: null,
        perSource: [],
        outcomes: [
          {
            source: 'cache',
            ok: false,
            reason: `invalid: bin must be 6–8 digits (got ${bin.length})`,
            durationMs: 0
          }
        ]
      }
    }

    await this.warmOffline()

    const outcomes: SourceOutcome[] = []
    const perSource: BinInfo[] = []

    // Phase 1: instant offline sources (sequential, cheap).
    if (this.opts.sources.includes('cache') && this.cache) {
      const t0 = Date.now()
      const rows = this.cache.forBin(bin)
      if (rows.length > 0) {
        for (const r of rows) {
          perSource.push(r)
          outcomes.push({
            source: 'cache',
            ok: true,
            info: r,
            durationMs: Date.now() - t0
          })
        }
      } else {
        outcomes.push({ source: 'cache', ok: false, reason: 'miss', durationMs: Date.now() - t0 })
      }
    }

    if (this.opts.sources.includes('local-db') && this.localDb && this.localDb.size() > 0) {
      const t0 = Date.now()
      const hit = this.localDb.lookup(bin)
      if (hit) {
        perSource.push(hit)
        outcomes.push({ source: 'local-db', ok: true, info: hit, durationMs: Date.now() - t0 })
      } else {
        outcomes.push({
          source: 'local-db',
          ok: false,
          reason: 'miss',
          durationMs: Date.now() - t0
        })
      }
    }

    // Phase 2: HTTP sources, in parallel.
    type Job = () => Promise<SourceOutcome>
    const jobs: Job[] = []

    if (this.opts.sources.includes('binlist')) {
      jobs.push(async () => {
        const t0 = Date.now()
        const r = await lookupBinlist(bin, { timeoutMs: this.opts.timeoutMs, log: this.opts.log })
        return r.ok
          ? { source: 'binlist', ok: true, info: r.info, durationMs: Date.now() - t0 }
          : { source: 'binlist', ok: false, reason: r.reason, durationMs: Date.now() - t0 }
      })
    }
    if (this.opts.sources.includes('handyapi')) {
      jobs.push(async () => {
        const t0 = Date.now()
        const r = await lookupHandyApi(bin, {
          timeoutMs: this.opts.timeoutMs,
          log: this.opts.log
        })
        return r.ok
          ? { source: 'handyapi', ok: true, info: r.info, durationMs: Date.now() - t0 }
          : { source: 'handyapi', ok: false, reason: r.reason, durationMs: Date.now() - t0 }
      })
    }
    if (this.opts.sources.includes('bincheck')) {
      jobs.push(async () => {
        const t0 = Date.now()
        const r = await lookupBincheckSearch(bin, {
          timeoutMs: this.opts.timeoutMs,
          log: this.opts.log
        })
        if (r.ok) {
          if (r.rows.length > 0) {
            return {
              source: 'bincheck',
              ok: true,
              info: r.rows[0],
              durationMs: Date.now() - t0
            }
          }
          return {
            source: 'bincheck',
            ok: false,
            reason: 'empty result set',
            durationMs: Date.now() - t0
          }
        }
        return { source: 'bincheck', ok: false, reason: r.reason, durationMs: Date.now() - t0 }
      })
    }
    if (this.opts.sources.includes('bincheck-details')) {
      jobs.push(async () => {
        const t0 = Date.now()
        const r = await lookupBincheckDetails(bin, {
          timeoutMs: this.opts.timeoutMs,
          log: this.opts.log
        })
        return r.ok
          ? {
              source: 'bincheck-details',
              ok: true,
              info: r.info,
              durationMs: Date.now() - t0
            }
          : {
              source: 'bincheck-details',
              ok: false,
              reason: r.reason,
              durationMs: Date.now() - t0
            }
      })
    }
    if (this.opts.sources.includes('vccgenerator')) {
      jobs.push(async () => {
        const t0 = Date.now()
        try {
          const info = await this.getVccGen().lookup(bin)
          return info
            ? { source: 'vccgenerator', ok: true, info, durationMs: Date.now() - t0 }
            : {
                source: 'vccgenerator',
                ok: false,
                reason: 'not_found',
                durationMs: Date.now() - t0
              }
        } catch (e) {
          return {
            source: 'vccgenerator',
            ok: false,
            reason: e instanceof Error ? e.message : String(e),
            durationMs: Date.now() - t0
          }
        }
      })
    }

    if (jobs.length > 0) {
      const settled = await Promise.all(jobs.map((j) => j().catch((e) => safeError(e))))
      for (const o of settled) {
        outcomes.push(o)
        if (o.ok && o.info) perSource.push(o.info)
      }
    }

    // Phase 3: scrapers (heavy) — only when enabled and lighter sources
    // produced no matching scheme/country/bank info.
    const wantScraper =
      this.opts.enableScrapers &&
      this.opts.sources.includes('bincodes') &&
      perSource.length === 0
    if (wantScraper) {
      const t0 = Date.now()
      const r = await scrapeBincodes(bin, {
        proxyUrl: this.opts.proxyUrl,
        log: this.opts.log
      })
      if (r.ok) {
        perSource.push(r.info)
        outcomes.push({
          source: 'bincodes',
          ok: true,
          info: r.info,
          durationMs: Date.now() - t0
        })
      } else {
        outcomes.push({
          source: 'bincodes',
          ok: false,
          reason: r.reason,
          durationMs: Date.now() - t0
        })
      }
    }

    // Persist new entries to cache (only fresh fetches, not the cache hits).
    if (this.cache) {
      let dirty = false
      for (const row of perSource) {
        if (row.source === 'cache') continue
        this.cache.set(row)
        dirty = true
      }
      if (dirty) {
        try {
          await this.cache.flush()
        } catch (e) {
          this.opts.log(
            `[bin/aggregator] cache flush failed: ${e instanceof Error ? e.message : e}`
          )
        }
      }
    }

    // Cache stores rows under their original source name. A lookup can
    // therefore produce both a cached and a freshly-fetched row for the
    // same source in one run; keep the freshest so merge/provenance stays
    // deterministic.
    const uniqueRows = dedupeBySource(perSource)

    // Order rows by configured source priority before merging so the
    // earliest-priority source wins on simple conflicts. mergeBinInfo()
    // still applies issuer/bank consensus when sources disagree.
    const priority = new Map<string, number>(this.opts.sources.map((s, i) => [s, i]))
    const ordered = [...uniqueRows].sort(
      (a, b) =>
        (priority.get(stripCacheSuffix(a.source)) ?? 999) -
        (priority.get(stripCacheSuffix(b.source)) ?? 999)
    )

    return {
      bin,
      merged: mergeBinInfo(ordered),
      perSource: ordered,
      outcomes
    }
  }

  /**
   * Filter-driven discovery — list candidate BINs from sources that
   * support it (vccgenerator cascading + bincheck DataTables search +
   * local-db prefix scan).
   *
   * bincheck's server combines `filter_country + filter_brand + filter_type`
   * poorly (returns zero rows when ≥2 dimensions are set even though each
   * filter individually returns data). To work around that, we ask the
   * API for the largest reasonable page using only the most selective
   * filter, then apply the remaining constraints client-side via
   * `applyFilter`. The local-db is used the same way for partial-prefix
   * BIN searches.
   */
  async findByFilter(
    filter: BinFilter & { search?: string; limit?: number }
  ): Promise<BinInfo[]> {
    await this.warmOffline()
    const limit = Math.max(1, filter.limit ?? 100)
    const out: BinInfo[] = []
    const seen = new Set<string>()

    if (this.opts.sources.includes('bincheck')) {
      const apiPick = pickPrimaryBincheckFilter(filter)
      // Always over-fetch (server max=100) so client-side filtering has
      // enough rows to find matches.
      try {
        const r = await searchBincheck({
          ...apiPick,
          search: filter.search,
          start: 0,
          length: 100,
          timeoutMs: this.opts.timeoutMs,
          log: this.opts.log
        })
        if (r.ok) {
          for (const row of applyFilter(r.rows, filter)) {
            if (seen.has(row.bin)) continue
            seen.add(row.bin)
            out.push(row)
            if (out.length >= limit) break
          }
        }
      } catch (e) {
        this.opts.log(
          `[bin/aggregator] bincheck search failed: ${e instanceof Error ? e.message : e}`
        )
      }
    }

    // local-db prefix scan — only when the search is a partial BIN prefix.
    if (
      this.localDb &&
      out.length < limit &&
      filter.search &&
      /^\d{3,8}$/.test(filter.search)
    ) {
      const prefixHits = this.localDb.search(filter.search, limit * 4)
      for (const r of applyFilter(prefixHits, filter)) {
        if (seen.has(r.bin)) continue
        seen.add(r.bin)
        out.push(r)
        if (out.length >= limit) break
      }
    }

    // local-db country/brand scan — uses the bulk iterator + applyFilter.
    if (this.localDb && out.length < limit && (filter.country || filter.scheme || filter.bank || filter.type)) {
      // Cap the in-memory walk so we don't spin through 343k rows for
      // every search. 8k rows is enough to surface ~50–100 hits across
      // common combos (US Visa Credit etc.) on the iannuttall dataset.
      const sample = this.localDb.iter(8000)
      for (const r of applyFilter(sample, filter)) {
        if (seen.has(r.bin)) continue
        seen.add(r.bin)
        out.push(r)
        if (out.length >= limit) break
      }
    }

    return applyFilter(out, filter).slice(0, limit)
  }

  /** Drain the cascading vccgenerator selectors. Country → brand → bank → BINs. */
  async cascadeVccGenerator(opts: {
    country: string
    brand?: string
    bank?: string
  }): Promise<{
    brands?: string[]
    banks?: string[]
    bins?: string[]
  }> {
    if (!this.opts.sources.includes('vccgenerator')) return {}
    const c = this.getVccGen()
    if (!opts.brand) {
      return { brands: await c.listBrands(opts.country) }
    }
    if (!opts.bank) {
      return { banks: await c.listBanks(opts.country, opts.brand) }
    }
    return { bins: await c.listBins(opts.country, opts.brand, opts.bank) }
  }

  async close(): Promise<void> {
    if (this.cache) {
      try {
        await this.cache.flush()
      } catch {}
    }
  }
}

function pickFirst(v?: string | string[]): string | undefined {
  if (!v) return undefined
  if (Array.isArray(v)) return v[0]?.trim() || undefined
  const s = v.split(/[,\s]+/).filter(Boolean)[0]
  return s?.trim() || undefined
}

/**
 * bincheck's API ANDs filters server-side but only returns matches when
 * the combination is exact (e.g. `filter_country=us & filter_brand=VISA`
 * empirically returns 0 even though each in isolation returns thousands).
 * Pick a single dimension to send and let the caller post-filter the rest.
 *
 * Priority: issuer > free-text search > brand > type > country. Issuer is
 * the narrowest filter and least likely to over-fetch; country is broad
 * and least selective.
 */
function pickPrimaryBincheckFilter(
  f: BinFilter & { search?: string }
): {
  countryAlpha2?: string
  brand?: string
  type?: string
  issuer?: string
} {
  if (f.bank) return { issuer: f.bank }
  const scheme = pickFirst(f.scheme)
  if (scheme) return { brand: scheme.toUpperCase() }
  const type = pickFirst(f.type)
  if (type) return { type: type.toUpperCase() }
  const a2 = pickFirst(f.country)
  if (a2) return { countryAlpha2: a2.toLowerCase() }
  return {}
}

function stripCacheSuffix(s: string): string {
  // Merged source strings carry "+" joining tokens — keep first.
  return s.split('+')[0]
}

function dedupeBySource(rows: BinInfo[]): BinInfo[] {
  const bySource = new Map<string, BinInfo>()
  for (const row of rows) {
    const key = `${stripCacheSuffix(row.source)}:${row.bin}`
    const existing = bySource.get(key)
    if (!existing || row.fetchedAt >= existing.fetchedAt) {
      bySource.set(key, row)
    }
  }
  return [...bySource.values()]
}

function safeError(e: unknown): SourceOutcome {
  return {
    source: 'cache',
    ok: false,
    reason: `unhandled: ${e instanceof Error ? e.message : String(e)}`,
    durationMs: 0
  }
}
