import { randomInt } from 'node:crypto'
import type { BinInfo } from './types'

/**
 * BIN-driven payment-card-number generator.
 *
 * Produces full PANs that:
 *   - start with a chosen BIN prefix (6–8 digits)
 *   - are Luhn-valid (the final check digit is computed, not random)
 *   - have a length appropriate for the network (16 default, 15 for AmEx,
 *     14 for Diners, configurable via `length` or via the BinInfo)
 *
 * Also produces matching expiry + CVC so the output drops straight into
 * the existing VccEntry shape consumed by the upgrade flow.
 *
 * IMPORTANT: this generator does NOT verify a card actually exists with
 * an issuer. It produces *syntactically valid* numbers. They will fail
 * at the issuer auth step on a real Stripe charge unless the BIN truly
 * maps to a card the user controls.
 */

export type GenerateCardOptions = {
  /** 6–19 digit BIN/IIN prefix. Non-digits are stripped. */
  bin: string
  /** Total card length. Auto-derived from scheme/BinInfo if omitted. */
  length?: number
  /** Card scheme — used to pick a default length. Lowercase. */
  scheme?: string
  /** Optional explicit expiry month 1–12. Random forward-month otherwise. */
  expMonth?: number
  /** Optional explicit 4-digit expiry year. Random 2–5 yrs forward otherwise. */
  expYear?: number
  /** CVC length, 3 or 4. Auto: 4 for amex, 3 otherwise. */
  cvcLength?: 3 | 4
  /** Number of unique cards to produce. */
  count?: number
}

export type GeneratedCard = {
  pan: string
  expMonth: number
  expYear: number
  cvc: string
  scheme?: string
  length: number
  bin: string
}

const SCHEME_LENGTHS: Record<string, number[]> = {
  visa: [13, 16, 19],
  mastercard: [16],
  amex: [15],
  'american-express': [15],
  discover: [16, 19],
  jcb: [16, 19],
  diners: [14, 16, 19],
  'diners-club': [14, 16, 19],
  'diners-club-international': [14, 16, 19],
  unionpay: [16, 17, 18, 19],
  'union-pay': [16, 17, 18, 19],
  'china-union-pay': [16, 17, 18, 19],
  'china-unionpay': [16, 17, 18, 19],
  maestro: [12, 13, 14, 15, 16, 17, 18, 19],
  rupay: [16],
  mir: [16],
  elo: [16],
  hipercard: [16, 19]
}

const AMEX_ALIASES = new Set([
  'amex',
  'american-express',
  'americanexpress',
  'american express'
])

function normalizeScheme(scheme?: string): string | undefined {
  if (!scheme) return undefined
  return scheme.toLowerCase().trim().replace(/\s+/g, '-')
}

function isAmex(scheme?: string): boolean {
  const n = normalizeScheme(scheme)
  return n ? AMEX_ALIASES.has(n) : false
}

function defaultLength(scheme?: string): number {
  const n = normalizeScheme(scheme)
  if (!n) return 16
  if (isAmex(n)) return 15
  const ls = SCHEME_LENGTHS[n]
  if (!ls || ls.length === 0) return 16
  // Pick the most common length — first in the list (longest support array
  // would be wrong; standardize on the canonical 16, 15, etc.).
  if (ls.includes(16)) return 16
  if (ls.includes(15)) return 15
  return ls[0]
}

function luhnChecksum(digits: string): number {
  let sum = 0
  let alt = true // start with second-from-right
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = digits.charCodeAt(i) - 48
    if (alt) {
      n *= 2
      if (n > 9) n -= 9
    }
    sum += n
    alt = !alt
  }
  return (10 - (sum % 10)) % 10
}

function randomDigits(n: number): string {
  let s = ''
  for (let i = 0; i < n; i++) s += randomInt(0, 10).toString()
  return s
}

/** Produce one Luhn-valid PAN of `total` digits starting with `prefix`. */
export function generatePan(prefix: string, total: number): string {
  const cleaned = prefix.replace(/\D+/g, '')
  if (cleaned.length === 0) throw new Error('generatePan: empty prefix')
  if (total < cleaned.length + 1) {
    throw new Error(`generatePan: total ${total} < prefix(${cleaned.length})+1`)
  }
  if (total > 19) throw new Error(`generatePan: total ${total} > 19`)
  const fillerLen = total - cleaned.length - 1
  const filler = fillerLen > 0 ? randomDigits(fillerLen) : ''
  const partial = cleaned + filler
  const check = luhnChecksum(partial)
  return partial + String(check)
}

function pickExpiry(now: Date): { expMonth: number; expYear: number } {
  // Random expiry: this month + 6 to 48 months in the future. Clamps to
  // year 2099 to stay within Stripe's allowed window.
  const months = randomInt(6, 49)
  const target = new Date(now.getFullYear(), now.getMonth() + months, 1)
  const expMonth = target.getMonth() + 1
  const expYear = Math.min(target.getFullYear(), 2099)
  return { expMonth, expYear }
}

function pickCvc(scheme?: string, override?: 3 | 4): string {
  const len = override ?? (isAmex(scheme) ? 4 : 3)
  // Avoid CVC 000 / 0000 — issuers commonly reject these test sentinels.
  for (let attempt = 0; attempt < 4; attempt++) {
    const c = randomDigits(len)
    if (Number.parseInt(c, 10) > 0) return c
  }
  return '1' + randomDigits(len - 1)
}

export function generateCards(opts: GenerateCardOptions): GeneratedCard[] {
  const cleanedBin = opts.bin.replace(/\D+/g, '')
  if (cleanedBin.length < 6 || cleanedBin.length > 19) {
    throw new Error(`generateCards: BIN must be 6–19 digits (got ${cleanedBin.length})`)
  }
  const total = opts.length ?? defaultLength(opts.scheme)
  if (total < cleanedBin.length + 1) {
    throw new Error(`generateCards: length ${total} too short for BIN ${cleanedBin}`)
  }
  const count = Math.max(1, opts.count ?? 1)
  const now = new Date()
  const seen = new Set<string>()
  const out: GeneratedCard[] = []
  // Cap retry budget so we cannot infinite-loop on a tiny PAN space (e.g.
  // 6-digit BIN with length=7 gives only 10 possible cards).
  const maxAttempts = Math.max(50, count * 50)
  let attempts = 0
  while (out.length < count && attempts < maxAttempts) {
    attempts++
    const pan = generatePan(cleanedBin, total)
    if (seen.has(pan)) continue
    seen.add(pan)
    const exp =
      opts.expMonth && opts.expYear
        ? { expMonth: opts.expMonth, expYear: opts.expYear }
        : pickExpiry(now)
    out.push({
      pan,
      expMonth: exp.expMonth,
      expYear: exp.expYear,
      cvc: pickCvc(opts.scheme, opts.cvcLength),
      scheme: normalizeScheme(opts.scheme),
      length: total,
      bin: cleanedBin
    })
  }
  return out
}

/** Convenience — derive sensible defaults from a known BinInfo row. */
export function generateFromBinInfo(
  info: BinInfo,
  count: number,
  override: Partial<GenerateCardOptions> = {}
): GeneratedCard[] {
  const opts: GenerateCardOptions = {
    bin: info.bin,
    count,
    scheme: info.scheme,
    length: info.length,
    ...override
  }
  return generateCards(opts)
}
