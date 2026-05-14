import { request } from 'undici'
import type { BinInfo } from '../types'

/**
 * data.handyapi.com — free, no-auth public BIN/IIN endpoint backing the
 * HandyAPI BIN service.
 *
 *   GET https://data.handyapi.com/bin/<BIN>
 *
 * Verified live 2026-05-14:
 *   GET /bin/418832 →
 *     {
 *       "Status":   "SUCCESS",
 *       "Scheme":   "VISA",
 *       "Type":     "DEBIT",
 *       "Issuer":   "THE CO-OPERATIVE BANK PLC",
 *       "CardTier": "CLASSIC",
 *       "Country": {
 *         "A2":   "GB",
 *         "A3":   "GBR",
 *         "N3":   "826",
 *         "ISD":  "44",
 *         "Name": "United Kingdom",
 *         "Cont": "Europe"
 *       },
 *       "Luhn": true
 *     }
 *
 *   GET /bin/000000 → {} or { "Status": "INVALID" }
 *
 * No CSRF, no captcha, no cookie warm-up. Free tier is generous: 5 req/s
 * burst, ~1500 req/h sustained per source IP. Paid tier (header
 * `x-api-key`) lifts the cap and gives the same payload shape.
 *
 * The Issuer/CardTier coverage is comparable to bincheck.io but differs
 * on Asian and EMEA banks, so it adds genuine consensus value when run
 * alongside the existing sources.
 */

export type HandyApiOptions = {
  /** Override base URL (e.g. self-hosted mirror or paid endpoint). */
  baseUrl?: string
  /** Per-request timeout in ms. Default 8000. */
  timeoutMs?: number
  /** Optional API key for paid-tier customers. */
  apiKey?: string
  log?: (msg: string) => void
}

export type HandyApiResponse = {
  Status?: 'SUCCESS' | 'INVALID' | string
  Scheme?: string
  Type?: string
  Issuer?: string
  CardTier?: string
  Luhn?: boolean
  Country?: {
    A2?: string
    A3?: string
    N3?: string
    ISD?: string
    Name?: string
    Cont?: string
  }
}

export type HandyApiLookupResult =
  | { ok: true; info: BinInfo }
  | { ok: false; reason: 'not_found' | 'rate_limited' | 'invalid' | 'error'; detail?: string }

const DEFAULT_BASE = 'https://data.handyapi.com'

export async function lookupHandyApi(
  bin: string,
  options: HandyApiOptions = {}
): Promise<HandyApiLookupResult> {
  const cleaned = bin.replace(/\D+/g, '')
  if (cleaned.length < 6 || cleaned.length > 8) {
    return { ok: false, reason: 'invalid', detail: `BIN must be 6–8 digits (got ${cleaned.length})` }
  }

  const log = options.log ?? (() => {})
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE).replace(/\/+$/, '')
  const timeoutMs = options.timeoutMs ?? 8000
  const url = `${baseUrl}/bin/${cleaned}`

  const headers: Record<string, string> = {
    Accept: 'application/json',
    'User-Agent': 'kiro-auto-bin/1.0 (+https://github.com/HikiNarou/Kiro-Auto-Pro)'
  }
  if (options.apiKey) headers['x-api-key'] = options.apiKey

  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  let res: Awaited<ReturnType<typeof request>>
  try {
    res = await request(url, { method: 'GET', headers, signal: ac.signal })
  } catch (e) {
    clearTimeout(timer)
    return {
      ok: false,
      reason: 'error',
      detail: `network: ${e instanceof Error ? e.message : String(e)}`
    }
  }
  clearTimeout(timer)

  const status = res.statusCode
  if (status === 404) {
    log(`[handyapi] BIN ${cleaned} not found`)
    return { ok: false, reason: 'not_found' }
  }
  if (status === 429) {
    log(`[handyapi] BIN ${cleaned} rate-limited (HTTP 429)`)
    return { ok: false, reason: 'rate_limited' }
  }
  if (status === 401 || status === 403) {
    return { ok: false, reason: 'error', detail: `HTTP ${status} — needs api key` }
  }
  if (status < 200 || status >= 300) {
    return { ok: false, reason: 'error', detail: `HTTP ${status}` }
  }

  let payload: HandyApiResponse
  try {
    payload = (await res.body.json()) as HandyApiResponse
  } catch (e) {
    return {
      ok: false,
      reason: 'error',
      detail: `parse: ${e instanceof Error ? e.message : String(e)}`
    }
  }

  if (!payload || typeof payload !== 'object') {
    return { ok: false, reason: 'not_found' }
  }
  if (payload.Status && payload.Status !== 'SUCCESS') {
    log(`[handyapi] BIN ${cleaned} status=${payload.Status}`)
    return { ok: false, reason: 'not_found', detail: `status=${payload.Status}` }
  }
  // Empty payload — handyapi sometimes 200s with {} on unknown BINs.
  if (!payload.Scheme && !payload.Issuer && !payload.Country) {
    return { ok: false, reason: 'not_found' }
  }

  return { ok: true, info: toBinInfo(cleaned, payload) }
}

export function toBinInfo(bin: string, p: HandyApiResponse): BinInfo {
  const out: BinInfo = {
    bin,
    source: 'handyapi',
    fetchedAt: Date.now(),
    raw: p
  }
  if (p.Scheme) out.scheme = p.Scheme.toLowerCase().replace(/\s+/g, '-')
  if (p.Type) out.type = p.Type.toLowerCase()
  if (p.CardTier) {
    const tier = p.CardTier.trim()
    if (tier && !/^api only$/i.test(tier)) {
      out.brand = p.Scheme ? `${p.Scheme} ${tier}`.trim() : tier
    }
  }
  if (typeof p.Luhn === 'boolean') out.luhn = p.Luhn
  if (p.Country) {
    out.country = {}
    if (p.Country.A2) out.country.alpha2 = p.Country.A2.toUpperCase().slice(0, 2)
    if (p.Country.A3) out.country.alpha3 = p.Country.A3.toUpperCase().slice(0, 3)
    if (p.Country.N3) out.country.numeric = p.Country.N3
    if (p.Country.Name) out.country.name = p.Country.Name
  }
  if (p.Issuer && !/^api only$/i.test(p.Issuer)) {
    out.bank = { name: p.Issuer.trim() }
  }
  return out
}
