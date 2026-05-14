/**
 * Standardized BIN (Bank Identification Number) lookup result.
 *
 * Different sources expose different fields and use different vocabularies
 * (e.g. "scheme" vs "network", "type" vs "category"). We normalize them all
 * into a single shape so the aggregator + CLI can treat them uniformly.
 *
 * Every field except `bin`, `source`, and `fetchedAt` is optional — sources
 * may return only a subset (binlist.net frequently omits `bank.phone`,
 * scrapers may produce only `scheme` + `country`, etc.).
 */
export type BinInfo = {
  /** 6–8 digit BIN that was looked up (digits only). */
  bin: string

  /** Card network: visa, mastercard, amex, jcb, discover, diners, unionpay, … */
  scheme?: string

  /** Funding type: credit, debit, charge, prepaid. */
  type?: string

  /** Marketing brand line (e.g. "Visa Platinum", "Mastercard World Elite"). */
  brand?: string

  /** Whether the card is prepaid. Sources may signal this via boolean OR via type === "prepaid". */
  prepaid?: boolean

  /** Card length (12–19) when known. */
  length?: number

  /** Whether Luhn passes for the BIN's number space. */
  luhn?: boolean

  country?: {
    /** ISO-3166 alpha-2 (e.g. "US"). */
    alpha2?: string
    /** ISO-3166 alpha-3 (e.g. "USA"). */
    alpha3?: string
    /** ISO-3166 numeric (e.g. "840"). */
    numeric?: string
    /** English name. */
    name?: string
    /** Flag emoji. */
    emoji?: string
    /** ISO-4217 currency. */
    currency?: string
    latitude?: number
    longitude?: number
  }

  bank?: {
    name?: string
    /** Hostname only, no scheme — caller is expected to prepend https:// when rendering. */
    url?: string
    phone?: string
    city?: string
  }

  /** Provenance — which source produced this row. Slug, lowercase, no spaces. */
  source: string

  /** Fetched-at unix milliseconds. */
  fetchedAt: number

  /** Optional source-specific raw payload — kept for debugging only. */
  raw?: unknown
}

/**
 * Filters applied to BIN search results — typically used after aggregation.
 *
 * All filters are inclusive AND (every supplied filter must match). Empty
 * filters mean "no filter on that field".
 */
export type BinFilter = {
  /** ISO-3166 alpha-2. Comma-separated ("US,GB,ID") accepted by the CLI. */
  country?: string | string[]
  /** Card scheme: visa, mastercard, etc. Case-insensitive. */
  scheme?: string | string[]
  /** Funding type: credit, debit, prepaid, charge. Case-insensitive. */
  type?: string | string[]
  /** Free-form substring against the marketing brand (e.g. "platinum"). */
  brand?: string
  /** Free-form substring against the bank name (e.g. "chase"). */
  bank?: string
  /** Only return prepaid (true), only non-prepaid (false), or any (undefined). */
  prepaid?: boolean
}

export function applyFilter(rows: BinInfo[], filter: BinFilter | undefined): BinInfo[] {
  if (!filter) return rows
  const norm = (v?: string | string[]): string[] | undefined => {
    if (v === undefined) return undefined
    const arr = Array.isArray(v) ? v : v.split(/[,\s]+/).filter(Boolean)
    return arr.map((x) => x.trim().toLowerCase())
  }
  const country = norm(filter.country)
  const scheme = norm(filter.scheme)
  const type = norm(filter.type)
  const brand = filter.brand?.toLowerCase().trim()
  const bank = filter.bank?.toLowerCase().trim()
  const prepaidFilter = filter.prepaid

  return rows.filter((r) => {
    if (country && country.length > 0) {
      const a2 = r.country?.alpha2?.toLowerCase()
      if (!a2 || !country.includes(a2)) return false
    }
    if (scheme && scheme.length > 0) {
      const s = r.scheme?.toLowerCase()
      if (!s || !scheme.includes(s)) return false
    }
    if (type && type.length > 0) {
      const t = r.type?.toLowerCase()
      if (!t || !type.includes(t)) return false
    }
    if (brand && !(r.brand ?? '').toLowerCase().includes(brand)) return false
    if (bank && !(r.bank?.name ?? '').toLowerCase().includes(bank)) return false
    if (prepaidFilter !== undefined && r.prepaid !== prepaidFilter) return false
    return true
  })
}

const BANK_SOURCE_CONFIDENCE: Record<string, number> = {
  vccgenerator: 100,
  'bincheck-details': 90,
  handyapi: 85,
  binlist: 80,
  bincheck: 70,
  bincodes: 65,
  'local-db': 40,
  cache: 20
}

function primarySource(source: string): string {
  return source.split('+')[0]?.trim().toLowerCase() || source.toLowerCase()
}

function sourceConfidence(source: string): number {
  return BANK_SOURCE_CONFIDENCE[primarySource(source)] ?? 50
}

function bankKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/\bp\.?\s*t\.?\b/g, ' ')
    .replace(
      /\b(?:pt|bank|tbk|persero|indonesia|n\.?\s*a\.?|s\.?\s*a\.?|ltd|limited|corp|corporation|co)\b/g,
      ' '
    )
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

function chooseConsensusBank(rows: BinInfo[]): BinInfo['bank'] | undefined {
  const groups = new Map<
    string,
    {
      rows: BinInfo[]
      sourceSeen: Set<string>
      score: number
    }
  >()

  for (const row of rows) {
    const name = row.bank?.name?.trim()
    if (!name) continue
    const key = bankKey(name)
    if (!key) continue

    const group = groups.get(key) ?? { rows: [], sourceSeen: new Set<string>(), score: 0 }
    group.rows.push(row)

    const source = primarySource(row.source)
    if (!group.sourceSeen.has(source)) {
      group.sourceSeen.add(source)
      group.score += sourceConfidence(row.source)
    }
    groups.set(key, group)
  }

  if (groups.size === 0) return undefined

  const best = [...groups.values()].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    return b.sourceSeen.size - a.sourceSeen.size
  })[0]

  const orderedRows = [...best.rows].sort((a, b) => sourceConfidence(b.source) - sourceConfidence(a.source))
  const out: NonNullable<BinInfo['bank']> = {}
  for (const row of orderedRows) {
    if (!row.bank) continue
    out.name ??= row.bank.name
    out.url ??= row.bank.url
    out.phone ??= row.bank.phone
    out.city ??= row.bank.city
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/** Merge multiple BinInfo rows for the same BIN into a single row.
 *  Earlier entries (higher priority sources) win on simple scalar conflicts.
 *  Issuer/bank conflicts are resolved by source consensus so stale offline
 *  datasets do not override multiple live sources that agree. */
export function mergeBinInfo(rows: BinInfo[]): BinInfo | null {
  if (rows.length === 0) return null
  const out: BinInfo = {
    bin: rows[0].bin,
    source: rows.map((r) => r.source).join('+'),
    fetchedAt: Math.max(...rows.map((r) => r.fetchedAt))
  }
  // Earlier rows win for scalars.
  for (const r of rows) {
    out.scheme ??= r.scheme
    out.type ??= r.type
    out.brand ??= r.brand
    out.prepaid ??= r.prepaid
    out.length ??= r.length
    out.luhn ??= r.luhn
    if (r.country) {
      out.country ??= {}
      out.country.alpha2 ??= r.country.alpha2
      out.country.alpha3 ??= r.country.alpha3
      out.country.numeric ??= r.country.numeric
      out.country.name ??= r.country.name
      out.country.emoji ??= r.country.emoji
      out.country.currency ??= r.country.currency
      out.country.latitude ??= r.country.latitude
      out.country.longitude ??= r.country.longitude
    }
    if (r.bank) {
      out.bank ??= {}
      out.bank.name ??= r.bank.name
      out.bank.url ??= r.bank.url
      out.bank.phone ??= r.bank.phone
      out.bank.city ??= r.bank.city
    }
  }
  const consensusBank = chooseConsensusBank(rows)
  if (consensusBank) out.bank = consensusBank
  return out
}
