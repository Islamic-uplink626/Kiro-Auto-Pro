import { mkdir, readFile, writeFile, rename } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import type { GeneratedCard } from './generator'
import type { BinInfo } from './types'
import type { VccBillingAddress, VccEntry } from '../vcc'
import { detectBrand, loadVccFile, luhnValid } from '../vcc'
import { fakeBilling } from './billing-faker'

/**
 * Bridge — turns a `GeneratedCard` (BIN-search/generator output) into the
 * `VccEntry` shape the upgrade flow consumes. The Stripe checkout step
 * needs a billing address; the BIN sources don't carry one. Callers
 * supply a billing template (or a per-country defaults table) and the
 * bridge fills in the rest.
 *
 * The bridge intentionally does NOT mutate the existing VCC pool file.
 * Callers that want the cards available to the upgrade flow either:
 *
 *   1. write a fresh JSON file (pass `--vcc <path>` to `npm run upgrade`), or
 *   2. append to `accounts/vcc.json` via `appendVccFile()` here, with
 *      atomic write + duplicate detection.
 *
 * `appendVccFile` is the supported integration point for the CLI:
 * `bin generate --bin <bin> --count N --append accounts/vcc.json`.
 */

export type BillingTemplate = Omit<VccBillingAddress, 'name'> & {
  /** Cardholder name. Optional — falls back to `template.name` then "Generated User". */
  name?: string
}

export type GeneratedToVccOptions = {
  /**
   * Optional billing template applied to every produced VccEntry.
   *
   * If omitted, each card is given an independent randomly-generated
   * billing block from the country preset table (`fakeBilling`). The
   * country preset is derived from `binInfo.country.alpha2` so the
   * billing matches the issuer locale, falling back to US when the
   * source data didn't surface a country.
   *
   * Set this only when the caller has a single real billing address it
   * wants every card to share.
   */
  billing?: BillingTemplate
  /** Static label prefix (suffixed with last4 + index). */
  labelPrefix?: string
  /** Override the entry id derivation. Default: deterministic last4+exp+name hash. */
  idStrategy?: 'auto' | 'random'
}

/**
 * Map a free-form scheme slug ("visa", "american-express", "china-union-pay",
 * "diners-club") to one of the canonical VccEntry brand values. Unknown
 * schemes return undefined so callers can fall back to PAN-based detection.
 */
function mapSchemeToBrand(scheme?: string): VccEntry['brand'] | undefined {
  if (!scheme) return undefined
  const n = scheme.toLowerCase().trim().replace(/[\s_]+/g, '-')
  if (!n) return undefined
  if (n === 'visa') return 'visa'
  if (n === 'mastercard' || n === 'master-card' || n === 'mc') return 'mastercard'
  if (n === 'amex' || n === 'american-express' || n === 'americanexpress') return 'amex'
  if (n === 'jcb') return 'jcb'
  if (n === 'discover') return 'discover'
  if (n === 'diners' || n === 'diners-club' || n === 'diners-club-international') return 'diners'
  return 'other'
}

export function generatedToVcc(
  cards: GeneratedCard[],
  opts: GeneratedToVccOptions,
  binInfo?: BinInfo
): VccEntry[] {
  // When a single billing template is supplied it must specify country.
  // When omitted, each card gets a per-card faked billing keyed off the
  // BIN's issuer country (fallback US).
  const sharedBilling = opts.billing
  if (sharedBilling) {
    if (!sharedBilling.country || !/^[A-Z]{2}$/i.test(sharedBilling.country)) {
      throw new Error(`generatedToVcc: billing.country must be ISO alpha-2`)
    }
  }

  return cards.map((c, idx): VccEntry => {
    if (!luhnValid(c.pan)) {
      throw new Error(`generatedToVcc: PAN at index ${idx} fails Luhn (last4=${c.pan.slice(-4)})`)
    }
    const tmpl: BillingTemplate =
      sharedBilling ?? fakeBilling(binInfo?.country?.alpha2)
    const country = tmpl.country.toUpperCase()
    const billing: VccBillingAddress = {
      name: tmpl.name ?? 'Generated User',
      country,
      line1: tmpl.line1,
      city: tmpl.city,
      postalCode: tmpl.postalCode
    }
    if (tmpl.line2) billing.line2 = tmpl.line2
    if (tmpl.state) billing.state = tmpl.state

    const last4 = c.pan.slice(-4)
    const exp = `${String(c.expMonth).padStart(2, '0')}${String(c.expYear).slice(-2)}`
    const id =
      opts.idStrategy === 'random'
        ? `gen-${last4}-${exp}-${Math.random().toString(36).slice(2, 8)}`
        : `${last4}-${exp}-gen${idx + 1}`
    const brand = mapSchemeToBrand(c.scheme) ?? detectBrand(c.pan)
    const label = opts.labelPrefix
      ? `${opts.labelPrefix} ${last4} #${idx + 1}`
      : `Generated card ${last4} #${idx + 1}${binInfo?.bank?.name ? ` (${binInfo.bank.name})` : ''}`

    return {
      id,
      number: c.pan,
      expMonth: c.expMonth,
      expYear: c.expYear,
      cvc: c.cvc,
      billing,
      label,
      brand
    }
  })
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await readFile(path, 'utf-8')
    return true
  } catch {
    return false
  }
}

async function writeJsonAtomic(absPath: string, data: unknown): Promise<void> {
  await mkdir(dirname(absPath), { recursive: true })
  const tmp = `${absPath}.tmp.${process.pid}.${Date.now()}`
  await writeFile(tmp, JSON.stringify(data, null, 2), 'utf-8')
  try {
    await rename(tmp, absPath)
  } catch {
    await writeFile(absPath, JSON.stringify(data, null, 2), 'utf-8')
  }
}

/**
 * Append entries to a JSON VCC pool file. Existing entries are preserved.
 * Duplicates (matching `id` OR identical PAN+expiry) are skipped.
 *
 * The existing pool file is parsed through `loadVccFile`'s tolerant
 * reader, so common hand-edit mistakes (leading zeros on months,
 * trailing commas, JS-style comments) won't block an append. The output
 * is always strict JSON — re-saving normalizes the file in place.
 *
 * Returns the count of entries actually appended after dedupe.
 */
export async function appendVccFile(path: string, entries: VccEntry[]): Promise<number> {
  if (entries.length === 0) return 0
  const abs = resolve(path)
  let existing: VccEntry[] = []
  if (await fileExists(abs)) {
    try {
      existing = await loadVccFile(abs)
    } catch (e) {
      throw new Error(
        `appendVccFile: ${abs} exists but cannot be parsed (${e instanceof Error ? e.message : String(e)}). ` +
          `Fix the JSON manually, or pass --out <new-file> to write a fresh batch instead of appending.`
      )
    }
  }

  const seenIds = new Set(existing.map((e) => e.id).filter(Boolean))
  const seenFingerprints = new Set(
    existing.map((e) => `${e.number}|${e.expMonth}/${e.expYear}`)
  )

  let appended = 0
  for (const e of entries) {
    if (seenIds.has(e.id)) continue
    const fp = `${e.number}|${e.expMonth}/${e.expYear}`
    if (seenFingerprints.has(fp)) continue
    seenIds.add(e.id)
    seenFingerprints.add(fp)
    existing.push(e)
    appended++
  }

  if (appended > 0) await writeJsonAtomic(abs, existing)
  return appended
}
