import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { request } from 'undici'
import { gunzipSync } from 'node:zlib'
import type { BinInfo } from '../types'

/**
 * Local BIN database — offline-first lookup against a JSON / CSV / NDJSON
 * dataset stored under `accounts/bin-database.*`. The database is NOT
 * shipped with the repo (it can be tens of MB and licenses vary), and is
 * kept gitignored. A bootstrap helper downloads a free public dataset on
 * first use.
 *
 * Schema flexibility:
 *   - JSON  : array of records, OR { records: [...] }, OR object map keyed by BIN
 *   - NDJSON: one record per line
 *   - CSV   : header row required; fields auto-mapped from common spellings
 *
 * The first matching BIN row wins on lookup. Fields are normalized to
 * BinInfo on the fly — no server, no daemon, no separate index.
 */

export type LocalBinSourceOptions = {
  /** Path to dataset file. Default `accounts/bin-database.json`. */
  path?: string
  /** Where to download the dataset on first use. Default points to the
   *  public iannuttall/binlist-data dataset on GitHub. */
  bootstrapUrl?: string
  /** Auto-download dataset if missing. Default true. */
  autoBootstrap?: boolean
  log?: (msg: string) => void
}

const DEFAULT_PATH = 'accounts/bin-database.json'
// iannuttall/binlist-data — ~270k BIN records, public domain. We use the
// raw JSON which is gzipped on GitHub raw to stay under transfer limits.
const DEFAULT_BOOTSTRAP_URL =
  'https://raw.githubusercontent.com/iannuttall/binlist-data/master/binlist-data.csv'

/** Headers recognized in CSV / JSON object keys, mapped to BinInfo fields. */
const FIELD_ALIASES: Record<string, string> = {
  // BIN
  bin: 'bin',
  iin: 'bin',
  number: 'bin',
  // scheme / brand. NB: many open datasets (iannuttall/binlist-data) put
  // the network in the `brand` column ("VISA", "MASTERCARD"). Map both
  // `scheme` and `brand` to the canonical scheme field, then re-derive a
  // marketing brand from category if available.
  scheme: 'scheme',
  network: 'scheme',
  card_brand: 'scheme',
  cardbrand: 'scheme',
  brand: 'scheme',
  // type
  type: 'type',
  card_type: 'type',
  cardtype: 'type',
  category: 'category',
  card_level: 'category',
  cardlevel: 'category',
  level: 'category',
  // bank
  bank: 'bank.name',
  bank_name: 'bank.name',
  bankname: 'bank.name',
  issuer: 'bank.name',
  issuer_name: 'bank.name',
  bank_url: 'bank.url',
  bank_website: 'bank.url',
  bank_phone: 'bank.phone',
  bank_city: 'bank.city',
  // country
  country: 'country.name',
  country_name: 'country.name',
  country_alpha2: 'country.alpha2',
  country_a2: 'country.alpha2',
  country_iso2: 'country.alpha2',
  alpha2: 'country.alpha2',
  alpha_2: 'country.alpha2',
  iso2: 'country.alpha2',
  country_alpha3: 'country.alpha3',
  alpha3: 'country.alpha3',
  alpha_3: 'country.alpha3',
  iso3: 'country.alpha3',
  country_currency: 'country.currency',
  currency: 'country.currency',
  // misc
  length: 'length',
  luhn: 'luhn',
  prepaid: 'prepaid',
  latitude: 'country.latitude',
  longitude: 'country.longitude'
}

function setNested(obj: any, dottedKey: string, value: unknown): void {
  if (value == null || value === '') return
  const parts = dottedKey.split('.')
  let cur = obj
  for (let i = 0; i < parts.length - 1; i++) {
    cur[parts[i]] ??= {}
    cur = cur[parts[i]]
  }
  cur[parts[parts.length - 1]] = value
}

function rowToBinInfo(row: Record<string, unknown>): BinInfo | null {
  const out: any = { source: 'local-db', fetchedAt: Date.now() }
  for (const [k, v] of Object.entries(row)) {
    const key = k.toLowerCase().trim().replace(/[\s-]+/g, '_')
    const target = FIELD_ALIASES[key]
    if (!target) continue
    setNested(out, target, normalizeValue(target, v))
  }
  if (!out.bin) return null
  out.bin = String(out.bin).replace(/\D+/g, '')
  if (out.bin.length < 6 || out.bin.length > 8) return null
  // Promote raw `category` to `brand` so callers see a meaningful marketing
  // line (e.g. "Visa Platinum") instead of mixing it with `type`. Drop the
  // intermediate field — BinInfo has no `category` slot.
  if (out.category) {
    if (!out.brand && out.scheme) out.brand = `${String(out.scheme).toUpperCase()} ${out.category}`.trim()
    delete out.category
  }
  return out as BinInfo
}

function normalizeValue(target: string, v: unknown): unknown {
  if (v == null) return undefined
  const s = String(v).trim()
  if (!s) return undefined
  if (target === 'prepaid' || target === 'luhn') {
    const lc = s.toLowerCase()
    return ['true', '1', 'y', 'yes'].includes(lc)
      ? true
      : ['false', '0', 'n', 'no'].includes(lc)
        ? false
        : undefined
  }
  if (target === 'length') {
    const n = Number.parseInt(s, 10)
    return Number.isFinite(n) ? n : undefined
  }
  if (target === 'country.latitude' || target === 'country.longitude') {
    const n = Number.parseFloat(s)
    return Number.isFinite(n) ? n : undefined
  }
  if (target === 'country.alpha2') {
    return s.toUpperCase().slice(0, 2)
  }
  if (target === 'country.alpha3') {
    return s.toUpperCase().slice(0, 3)
  }
  if (target === 'scheme' || target === 'type') {
    return s.toLowerCase()
  }
  return s
}

function parseCsv(text: string): Record<string, string>[] {
  // Minimal RFC-4180 CSV parser — handles quoted fields with commas/newlines
  // and "" escapes. The public BIN datasets we target are utf-8 + LF.
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        field += c
      }
      continue
    }
    if (c === '"') {
      inQuotes = true
      continue
    }
    if (c === ',') {
      row.push(field)
      field = ''
      continue
    }
    if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++
      row.push(field)
      rows.push(row)
      row = []
      field = ''
      continue
    }
    field += c
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  if (rows.length === 0) return []
  const header = rows[0].map((h) => h.trim())
  return rows.slice(1).map((r) => {
    const obj: Record<string, string> = {}
    for (let i = 0; i < header.length; i++) obj[header[i]] = r[i] ?? ''
    return obj
  })
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await readFile(path)
    return true
  } catch {
    return false
  }
}

async function downloadDataset(url: string, dest: string, log: (m: string) => void): Promise<void> {
  log(`[bin/local-db] bootstrapping dataset from ${url}`)
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), 60_000)
  try {
    const res = await request(url, { method: 'GET', signal: ac.signal })
    clearTimeout(timer)
    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw new Error(`HTTP ${res.statusCode}`)
    }
    const buf = Buffer.from(await res.body.arrayBuffer())
    const decoded = url.endsWith('.gz') ? gunzipSync(buf) : buf
    await mkdir(dirname(resolve(dest)), { recursive: true })
    await writeFile(dest, decoded)
    log(`[bin/local-db] saved ${(decoded.byteLength / 1024).toFixed(1)} KiB to ${dest}`)
  } finally {
    clearTimeout(timer)
  }
}

export class LocalBinSource {
  private byBin: Map<string, BinInfo> = new Map()
  private loaded = false
  private opts: Required<Pick<LocalBinSourceOptions, 'path' | 'autoBootstrap' | 'bootstrapUrl'>> & {
    log: (m: string) => void
  }

  constructor(opts: LocalBinSourceOptions = {}) {
    this.opts = {
      path: opts.path ?? DEFAULT_PATH,
      autoBootstrap: opts.autoBootstrap ?? true,
      bootstrapUrl: opts.bootstrapUrl ?? DEFAULT_BOOTSTRAP_URL,
      log: opts.log ?? (() => {})
    }
  }

  /** Load (and download if needed) the dataset into memory. Idempotent. */
  async load(): Promise<void> {
    if (this.loaded) return
    const abs = resolve(this.opts.path)
    if (!(await fileExists(abs))) {
      if (!this.opts.autoBootstrap) {
        this.opts.log(`[bin/local-db] no dataset at ${abs} (autoBootstrap disabled)`)
        this.loaded = true
        return
      }
      await downloadDataset(this.opts.bootstrapUrl, abs, this.opts.log)
    }
    const raw = await readFile(abs, 'utf-8')
    const rows = this.parse(raw, abs)
    let kept = 0
    for (const r of rows) {
      const info = rowToBinInfo(r)
      if (!info) continue
      if (!this.byBin.has(info.bin)) {
        this.byBin.set(info.bin, info)
        kept++
      }
    }
    this.opts.log(`[bin/local-db] loaded ${kept} unique BIN entries from ${abs}`)
    this.loaded = true
  }

  private parse(raw: string, abs: string): Record<string, unknown>[] {
    const trimmed = raw.trim()
    if (!trimmed) return []
    if (trimmed.startsWith('[')) {
      try {
        const arr = JSON.parse(trimmed)
        return Array.isArray(arr) ? arr : []
      } catch (e) {
        throw new Error(`local-db: not valid JSON array (${abs}): ${(e as Error).message}`)
      }
    }
    if (trimmed.startsWith('{')) {
      try {
        const obj = JSON.parse(trimmed)
        if (Array.isArray(obj.records)) return obj.records
        if (Array.isArray(obj.entries)) return obj.entries
        return Object.entries(obj).map(([bin, v]) => ({ bin, ...(v as object) }))
      } catch (e) {
        throw new Error(`local-db: not valid JSON object (${abs}): ${(e as Error).message}`)
      }
    }
    // NDJSON
    if (trimmed.includes('\n') && trimmed.split('\n')[0].trim().startsWith('{')) {
      return trimmed
        .split(/\r?\n/)
        .filter((l) => l.trim().startsWith('{'))
        .map((l, idx) => {
          try {
            return JSON.parse(l)
          } catch {
            this.opts.log(`[bin/local-db] skipped malformed NDJSON line ${idx + 1}`)
            return null
          }
        })
        .filter((x): x is Record<string, unknown> => x !== null)
    }
    // CSV fallback
    return parseCsv(raw)
  }

  lookup(bin: string): BinInfo | null {
    if (!this.loaded) {
      throw new Error('LocalBinSource: call load() before lookup()')
    }
    const cleaned = bin.replace(/\D+/g, '')
    // Try 8 → 7 → 6 digits — datasets often store 6-digit BINs only.
    for (let len = Math.min(8, cleaned.length); len >= 6; len--) {
      const hit = this.byBin.get(cleaned.slice(0, len))
      if (hit) return { ...hit, fetchedAt: Date.now() }
    }
    return null
  }

  /** Return up to N rows matching a partial BIN prefix (3+ digits). */
  search(prefix: string, limit = 50): BinInfo[] {
    if (!this.loaded) throw new Error('LocalBinSource: call load() before search()')
    const cleaned = prefix.replace(/\D+/g, '')
    if (cleaned.length < 3) return []
    const out: BinInfo[] = []
    for (const [bin, info] of this.byBin.entries()) {
      if (bin.startsWith(cleaned)) {
        out.push(info)
        if (out.length >= limit) break
      }
    }
    return out
  }

  /**
   * Iterate every loaded row (capped at `limit` to keep memory + caller
   * processing predictable). Used by the aggregator's filter-driven path
   * when no BIN prefix is available — e.g. "list 50 Indonesian Visa BINs".
   * Returns rows in insertion order, which mirrors the dataset's order
   * (typically lowest-BIN-first for the iannuttall set).
   */
  iter(limit = 5000): BinInfo[] {
    if (!this.loaded) throw new Error('LocalBinSource: call load() before iter()')
    const out: BinInfo[] = []
    for (const info of this.byBin.values()) {
      out.push(info)
      if (out.length >= limit) break
    }
    return out
  }

  size(): number {
    return this.byBin.size
  }
}
