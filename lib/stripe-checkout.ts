import type { Page, Frame, Locator } from 'playwright'
import type { VccEntry } from './vcc'
import { humanType, humanClick, prewarmStripePage, sleep } from './stripe-stealth'

type LogCallback = (message: string) => void

export type StripeSubmitOutcome =
  /** Subscription succeeded — either the success page or a Kiro redirect. */
  | { kind: 'success'; finalUrl: string }
  /** Stripe prompted 3DS / OTP / OOB. `frameUrl` is the challenge iframe URL when detected. */
  | { kind: '3ds'; frameUrl?: string }
  /** Card was declined by the issuer (insufficient_funds, do_not_honor, lost_card, …). */
  | { kind: 'declined'; message: string; code?: string }
  /** Stripe refused to submit due to field-level validation (bad card, bad expiry…). */
  | { kind: 'validation'; message: string; field?: string }
  /** Region not supported / country mismatch / bin not in scheme. Functionally
   *  the same as a decline for retry purposes — kept distinct for diagnostics. */
  | { kind: 'unsupported'; message: string }
  /** Nothing observable happened in time — rare; usually a Stripe outage. */
  | { kind: 'timeout'; detail?: string }
  /** Generic Stripe-reported error that isn't a decline (e.g. processing_error). */
  | { kind: 'error'; message: string }

export type FillOptions = {
  /** Abort if the form isn't found / hydrated within this many ms. */
  formTimeoutMs?: number
  /** Timeout after Subscribe click for observable outcome. Default 180s — Stripe
   *  + issuer + 3DS preflight regularly take 60-120s on slow networks. */
  submitTimeoutMs?: number
  /** Skip the prewarm phase (mouse + scroll + dwell). Default false — only set
   *  true when the caller has already prewarmed the page (e.g. on retry). */
  skipPrewarm?: boolean
  /** Per-field humanized typo probability for BILLING fields only. Card / expiry
   *  / CVC are always typed verbatim — typos there get the value rejected by
   *  Stripe's input mask AND trigger "Your card number is invalid" before
   *  Subscribe is even pressed. Default 0.04. */
  mistakes?: number
}

const CARD_NUMBER_SELECTOR = '#cardNumber, input[name="cardNumber"], input[autocomplete="cc-number"]'
const CARD_EXPIRY_SELECTOR = '#cardExpiry, input[name="cardExpiry"], input[autocomplete="cc-exp"]'
const CARD_CVC_SELECTOR = '#cardCvc, input[name="cardCvc"], input[autocomplete="cc-csc"]'
const BILLING_NAME_SELECTOR = '#billingName, input[name="billingName"], input[autocomplete="cc-name"]'
const BILLING_COUNTRY_SELECTOR =
  '#billingCountry, select[name="billingCountry"], select[autocomplete="billing country"]'
const BILLING_LINE1_SELECTOR = '#billingAddressLine1, input[name="billingAddressLine1"]'
const BILLING_LINE2_SELECTOR = '#billingAddressLine2, input[name="billingAddressLine2"]'
const BILLING_CITY_SELECTOR = '#billingLocality, input[name="billingLocality"]'
const BILLING_ADMIN_SELECTOR = '#billingAdministrativeArea, [name="billingAdministrativeArea"]'
const BILLING_POSTAL_SELECTOR = '#billingPostalCode, input[name="billingPostalCode"]'

const SUBMIT_BUTTON_SELECTOR =
  'button[data-testid="hosted-payment-submit-button"], button.SubmitButton[type="submit"], button[type="submit"]:has-text("Subscribe"), button[type="submit"]:has-text("Pay")'

const FIELD_ERROR_SELECTOR = '.FieldError, span.FieldError, [data-testid$="-error"]'
const GLOBAL_ERROR_SELECTOR =
  '[data-testid="payment-form-global-error"], .PaymentForm-error, .PaymentForm-globalError, [role="alert"]:not([aria-hidden="true"]), .ErrorText, [class*="ErrorBanner"]'

/** Stripe sometimes mounts a top-banner error WITHOUT data-testid (older flows
 *  or experiments). The fallback class hash usually contains "error" + a
 *  high-z-index — match generically and read text. */
const FALLBACK_ERROR_SELECTOR = 'div[class*="rror"][role="alert"], div[class*="rror"][class*="anner"]'

/**
 * Type a value into a Stripe-masked field and verify the resulting input
 * value matches what we expected. Stripe formats the card number with spaces
 * ("4242 4242 …") and the expiry with " / " ("01 / 32"), so the comparison is
 * digit-only.
 *
 * If verification fails, the field is cleared and re-typed ONCE with no
 * mistake injection. A second mismatch returns false so the caller can
 * surface a definitive error before wasting a Subscribe click.
 */
async function typeAndVerifyDigits(
  page: Page,
  selector: string,
  expected: string,
  log: LogCallback,
  fieldLabel: string
): Promise<boolean> {
  const expectedDigits = expected.replace(/\D+/g, '')
  const loc = page.locator(selector).first()

  const readDigits = async (): Promise<string> => {
    const v = await loc.inputValue().catch(() => '')
    return v.replace(/\D+/g, '')
  }

  // First pass — verbatim typing, no mistakes for card data.
  await humanType(loc, expected, { mistakes: 0 })
  await sleep(jitter(120, 260))
  let actual = await readDigits()
  if (actual === expectedDigits) return true

  log(
    `[stripe] ${fieldLabel} value mismatch (got ${actual.length} digits, expected ${expectedDigits.length}) — retyping once`
  )

  // Second pass — clear hard, retype.
  try {
    await loc.click({ timeout: 3000 })
    await sleep(jitter(80, 180))
    // Ctrl+A → Backspace clears even masked inputs across all 3 engines.
    await loc.press('Control+a').catch(() => {})
    await loc.press('Backspace').catch(() => {})
    // Repeated backspace as belt-and-braces for masks that swallow Ctrl+A.
    for (let i = 0; i < Math.max(expectedDigits.length + 4, 24); i++) {
      await loc.press('Backspace').catch(() => {})
    }
  } catch {}

  await humanType(loc, expected, { mistakes: 0, clear: false })
  await sleep(jitter(160, 320))
  actual = await readDigits()
  if (actual === expectedDigits) return true

  log(
    `[stripe] ${fieldLabel} still mismatched after retype (got "${actual}" expected "${expectedDigits}")`
  )
  return false
}

function padMonth(m: number): string {
  return String(m).padStart(2, '0')
}

function expiryTyping(expMonth: number, expYear: number): string {
  // Stripe expects "MMYY" — the field auto-formats it into "MM / YY".
  // Typing the slash manually causes it to reject the value.
  const yy = String(expYear).slice(-2).padStart(2, '0')
  return `${padMonth(expMonth)}${yy}`
}

async function setSelectByValueOrLabel(
  page: Page,
  selector: string,
  value: string,
  log: LogCallback
): Promise<boolean> {
  // selectOption falls back to label if value doesn't match, but Stripe's
  // administrativeArea sometimes uses the full country name rather than the
  // code — we try value first, then label, then a case-insensitive label.
  const loc = page.locator(selector).first()
  try {
    await loc.selectOption({ value }, { timeout: 3000 })
    return true
  } catch {}
  try {
    await loc.selectOption({ label: value }, { timeout: 3000 })
    return true
  } catch {}
  try {
    const options = await loc.locator('option').all()
    for (const opt of options) {
      const optValue = (await opt.getAttribute('value')) ?? ''
      const optText = ((await opt.textContent()) ?? '').trim()
      if (
        optValue.toLowerCase() === value.toLowerCase() ||
        optText.toLowerCase() === value.toLowerCase() ||
        optText.toLowerCase().startsWith(`${value.toLowerCase()} `) ||
        optText.toLowerCase().includes(` — ${value.toLowerCase()}`)
      ) {
        await loc.selectOption({ value: optValue }, { timeout: 3000 })
        return true
      }
    }
  } catch (e) {
    log(`[stripe] select "${selector}" match-by-option failed: ${e instanceof Error ? e.message : String(e)}`)
  }
  return false
}

/** Is this field rendered as a <select>? Country-dependent — US/ID use a select
 *  for administrativeArea, FR/DE use a text input. */
async function isSelect(page: Page, selector: string): Promise<boolean> {
  const tag = await page
    .locator(selector)
    .first()
    .evaluate((el) => (el as HTMLElement).tagName.toLowerCase())
    .catch(() => '')
  return tag === 'select'
}

async function waitForField(page: Page, selector: string, timeoutMs: number): Promise<boolean> {
  try {
    await page.locator(selector).first().waitFor({ state: 'visible', timeout: timeoutMs })
    return true
  } catch {
    return false
  }
}

/** Collect any user-facing field error currently visible in the form.
 *  Stripe keeps FieldError spans in the DOM but hides them with opacity:0
 *  when the field is clean, so we filter by rendered visibility. */
async function readFieldErrors(page: Page): Promise<string[]> {
  try {
    const texts = await page
      .locator(FIELD_ERROR_SELECTOR)
      .evaluateAll((els) =>
        els
          .filter((el) => {
            const cs = window.getComputedStyle(el as HTMLElement)
            if (cs.opacity === '0' || cs.visibility === 'hidden' || cs.display === 'none') {
              return false
            }
            const h = (el as HTMLElement).offsetHeight
            return h > 0
          })
          .map((el) => (el.textContent ?? '').trim())
          .filter((t) => t.length > 0)
      )
    return Array.from(new Set(texts))
  } catch {
    return []
  }
}

/** Top-of-form banner / global error. Returns first non-empty visible message. */
async function readGlobalError(page: Page): Promise<string | null> {
  for (const sel of [GLOBAL_ERROR_SELECTOR, FALLBACK_ERROR_SELECTOR]) {
    try {
      const text = await page
        .locator(sel)
        .evaluateAll((els) => {
          for (const el of els) {
            const cs = window.getComputedStyle(el as HTMLElement)
            if (cs.opacity === '0' || cs.visibility === 'hidden' || cs.display === 'none') {
              continue
            }
            const t = (el.textContent ?? '').trim()
            if (t) return t
          }
          return null
        })
        .catch(() => null)
      if (text) return text
    } catch {}
  }
  return null
}

const DECLINE_PATTERNS: Array<{ re: RegExp; code: string }> = [
  { re: /insufficient[_\s-]?funds/i, code: 'insufficient_funds' },
  { re: /(?:lost|stolen|pickup)\s*card/i, code: 'lost_or_stolen' },
  { re: /do[_\s-]?not[_\s-]?honou?r/i, code: 'do_not_honor' },
  { re: /generic[_\s-]?decline|card[_\s-]?declined/i, code: 'generic_decline' },
  { re: /transaction[_\s-]?not[_\s-]?allowed/i, code: 'transaction_not_allowed' },
  { re: /restricted[_\s-]?card|blocked[_\s-]?card/i, code: 'card_restricted' },
  { re: /expired[_\s-]?card/i, code: 'expired_card' },
  { re: /incorrect[_\s-]?cvc|incorrect[_\s-]?security[_\s-]?code/i, code: 'incorrect_cvc' },
  { re: /incorrect[_\s-]?number|invalid[_\s-]?number/i, code: 'incorrect_number' },
  { re: /processing[_\s-]?error/i, code: 'processing_error' },
  { re: /authentication[_\s-]?required/i, code: 'authentication_required' },
  { re: /card[_\s-]?velocity[_\s-]?exceeded/i, code: 'velocity_exceeded' },
  { re: /fraud|suspicious|high[_\s-]?risk/i, code: 'fraudulent' },
  { re: /your\s+card\s+was\s+declined/i, code: 'declined' },
  { re: /your\s+card\s+(?:has\s+been\s+)?declined/i, code: 'declined' },
  { re: /declin/i, code: 'declined' }
]

const UNSUPPORTED_PATTERNS = [
  /not\s+supported\s+(?:in|for)/i,
  /country\s+(?:not|isn'?t)\s+supported/i,
  /this\s+payment\s+method\s+can'?t\s+be\s+used/i,
  /currency\s+not\s+supported/i,
  /unable\s+to\s+process\s+payments\s+(?:in|from)/i
]

const VALIDATION_PATTERNS = [
  /your\s+card\s+number\s+is\s+(?:incomplete|invalid|incorrect)/i,
  /your\s+card'?s?\s+expiration\s+date\s+is\s+(?:incomplete|invalid|in\s+the\s+past)/i,
  /your\s+card'?s?\s+security\s+code\s+is\s+(?:incomplete|invalid)/i,
  /required/i,
  /please\s+(?:enter|provide)/i,
  /invalid\s+(?:zip|postal|state|address)/i
]

function classifyMessage(
  text: string
):
  | { kind: 'declined'; code: string; message: string }
  | { kind: 'unsupported'; message: string }
  | { kind: 'validation'; message: string }
  | null {
  const trimmed = text.trim()
  if (!trimmed) return null

  for (const { re, code } of DECLINE_PATTERNS) {
    if (re.test(trimmed)) {
      return { kind: 'declined', code, message: trimmed }
    }
  }
  for (const re of UNSUPPORTED_PATTERNS) {
    if (re.test(trimmed)) {
      return { kind: 'unsupported', message: trimmed }
    }
  }
  for (const re of VALIDATION_PATTERNS) {
    if (re.test(trimmed)) {
      return { kind: 'validation', message: trimmed }
    }
  }
  return null
}

const THREE_DS_FRAME_PATTERNS = [
  /hooks\.stripe\.com\/(?:3d_secure|redirect)/i,
  /three[-_]?ds[-_]?2?[-_]?frame/i,
  /3d[-_]?secure/i,
  /\/authenticate\b/i,
  /stripe\.network\/authorize/i,
  /m\.stripe\.network\/inner\.html/i,
  /threedsecure/i,
  /acs\b|\bacsurl\b/i
]

function looksLikeThreeDs(frameUrl: string): boolean {
  if (!frameUrl) return false
  return THREE_DS_FRAME_PATTERNS.some((re) => re.test(frameUrl))
}

async function findThreeDsFrame(page: Page): Promise<Frame | null> {
  for (const frame of page.frames()) {
    const url = frame.url()
    if (!url) continue
    if (looksLikeThreeDs(url)) return frame
  }

  // Modal-mounted iframes — Stripe wraps the bank page in a re-skinned modal
  // for some issuers. Match by iframe attributes rather than frame URL.
  try {
    const modal = await page
      .locator(
        [
          'iframe[name*="3ds" i]',
          'iframe[id*="3ds" i]',
          'iframe[title*="3D Secure" i]',
          'iframe[title*="authenticate" i]',
          'iframe[title*="security check" i]',
          'iframe[src*="3d_secure"]',
          'iframe[src*="three-d-secure"]',
          'iframe[src*="hooks.stripe.com"]',
          'iframe[src*="m.stripe.network/inner"]'
        ].join(', ')
      )
      .first()
      .elementHandle({ timeout: 200 })
    if (modal) {
      const frame = await modal.contentFrame()
      if (frame) return frame
    }
  } catch {}
  return null
}

async function fillBillingAddress(
  page: Page,
  vcc: VccEntry,
  log: LogCallback,
  timeoutMs: number,
  mistakes: number
): Promise<void> {
  // Cardholder name.
  if (await waitForField(page, BILLING_NAME_SELECTOR, timeoutMs)) {
    await humanType(page.locator(BILLING_NAME_SELECTOR).first(), vcc.billing.name, {
      mistakes: mistakes * 0.5 // names are short — keep typo rate down
    })
    await sleep(jitter(150, 400))
  }

  // Country. This MUST be set first — Stripe rebuilds the rest of the billing
  // form (admin area select vs input, postal code pattern, etc.) based on it.
  if (await waitForField(page, BILLING_COUNTRY_SELECTOR, timeoutMs)) {
    const ok = await setSelectByValueOrLabel(page, BILLING_COUNTRY_SELECTOR, vcc.billing.country, log)
    if (!ok) {
      throw new Error(
        `stripe: could not select country "${vcc.billing.country}" (must be ISO-3166 alpha-2)`
      )
    }
    // Let Stripe re-render the dependent fields. Real users wait too, since
    // the dropdown closes and the address fields reflow.
    await sleep(jitter(700, 1100))
  }

  // Line 1 / 2.
  if (await waitForField(page, BILLING_LINE1_SELECTOR, timeoutMs)) {
    await humanType(page.locator(BILLING_LINE1_SELECTOR).first(), vcc.billing.line1, {
      mistakes
    })
    await sleep(jitter(120, 300))
  }
  if (vcc.billing.line2) {
    const hasLine2 = await page
      .locator(BILLING_LINE2_SELECTOR)
      .first()
      .isVisible()
      .catch(() => false)
    if (hasLine2) {
      await humanType(page.locator(BILLING_LINE2_SELECTOR).first(), vcc.billing.line2, {
        mistakes
      })
      await sleep(jitter(100, 220))
    }
  }

  // City.
  if (await waitForField(page, BILLING_CITY_SELECTOR, 3000)) {
    await humanType(page.locator(BILLING_CITY_SELECTOR).first(), vcc.billing.city, {
      mistakes
    })
    await sleep(jitter(120, 280))
  }

  // Administrative area — may be <select> or <input> depending on country.
  const adminVisible = await page
    .locator(BILLING_ADMIN_SELECTOR)
    .first()
    .isVisible()
    .catch(() => false)
  if (adminVisible && vcc.billing.state) {
    if (await isSelect(page, BILLING_ADMIN_SELECTOR)) {
      const ok = await setSelectByValueOrLabel(
        page,
        BILLING_ADMIN_SELECTOR,
        vcc.billing.state,
        log
      )
      if (!ok) {
        log(
          `[stripe] WARN: administrative area "${vcc.billing.state}" not found in dropdown — leaving blank`
        )
      }
    } else {
      await humanType(page.locator(BILLING_ADMIN_SELECTOR).first(), vcc.billing.state, {
        mistakes: 0 // state inputs are too short for typo simulation to feel real
      })
    }
    await sleep(jitter(100, 250))
  }

  // Postal code. Stripe validates ZIP/postal format on blur per-country, so
  // a typo+correct on this field reads especially natural to Radar — but
  // disabled here because a wrong ZIP can flip the AVS check and decline.
  if (await waitForField(page, BILLING_POSTAL_SELECTOR, 3000)) {
    await humanType(page.locator(BILLING_POSTAL_SELECTOR).first(), vcc.billing.postalCode, {
      mistakes: 0
    })
    await sleep(jitter(120, 320))
  }
}

/**
 * Fill the Stripe hosted checkout form with a single VCC.
 *
 * Returns after fields are typed + Tab-blurred but BEFORE Subscribe is clicked.
 * Caller invokes `submitAndClassify` separately so it can decide retry policy
 * on top of the classified outcome.
 *
 * Throws if the card / expiry / CVC values cannot be typed cleanly into the
 * masked inputs — that's a definitive failure (the form is broken or the
 * values are unusable) and should never reach Subscribe.
 */
export async function fillStripeCheckout(
  page: Page,
  vcc: VccEntry,
  log: LogCallback,
  options: FillOptions = {}
): Promise<void> {
  const formTimeout = options.formTimeoutMs ?? 30000
  const mistakes = options.mistakes ?? 0.04
  log(`[stripe] waiting for hosted checkout form to hydrate`)

  // Card number is the canonical sentinel — when it's mounted, the form is live.
  if (!(await waitForField(page, CARD_NUMBER_SELECTOR, formTimeout))) {
    throw new Error('stripe: card number field never appeared')
  }

  // Best-effort networkidle so the embedded iframes (link.stripe.com,
  // payment-method tabs) finish loading before we type. Cap short — even on
  // good networks Stripe keeps a long-poll open that never settles.
  await page.waitForLoadState('networkidle', { timeout: 4000 }).catch(() => {})

  // Stealth prewarm: feed Radar realistic mouse + scroll + dwell signals.
  if (!options.skipPrewarm) {
    await prewarmStripePage(page, log)
  }

  log(
    `[stripe] filling card last4=${vcc.number.slice(-4)} exp=${padMonth(vcc.expMonth)}/${String(
      vcc.expYear
    ).slice(-2)} brand=${vcc.brand ?? 'auto'}`
  )

  // Card number — verbatim, verify, retype once on mismatch. NO typo injection
  // here regardless of `mistakes` setting: a single wrong digit poisons the
  // input mask and surfaces as "Your card number is invalid" before Subscribe.
  if (!(await typeAndVerifyDigits(page, CARD_NUMBER_SELECTOR, vcc.number, log, 'cardNumber'))) {
    throw new Error('stripe: card number could not be typed cleanly into the masked input')
  }
  await sleep(jitter(180, 420))

  // Expiry — verbatim (4 digits MMYY), verify.
  const expDigits = expiryTyping(vcc.expMonth, vcc.expYear)
  if (!(await typeAndVerifyDigits(page, CARD_EXPIRY_SELECTOR, expDigits, log, 'cardExpiry'))) {
    throw new Error('stripe: expiry could not be typed cleanly')
  }
  await sleep(jitter(140, 320))

  // CVC — verbatim, verify.
  if (!(await typeAndVerifyDigits(page, CARD_CVC_SELECTOR, vcc.cvc, log, 'cardCvc'))) {
    throw new Error('stripe: cvc could not be typed cleanly')
  }
  await sleep(jitter(180, 400))

  await fillBillingAddress(page, vcc, log, 8000, mistakes)

  // Surface any immediate field-level errors Stripe flagged while typing
  // (bad card number, wrong length CVC, etc.). Non-fatal here — the caller's
  // submit step will re-read the same errors.
  const preErrors = await readFieldErrors(page)
  if (preErrors.length > 0) {
    log(`[stripe] pre-submit field errors: ${preErrors.join(' | ')}`)
  }
}

/**
 * Click Subscribe and classify the outcome. This is deliberately split from
 * the filling step so retry policies can reuse a loaded form with a new VCC
 * if desired (delete fields → re-fill → re-submit).
 *
 * Behaviour:
 *   - Pre-submit short-circuit: if the form already has a definitively-classifiable
 *     field error (validation / decline) BEFORE Subscribe is clicked, return
 *     it directly instead of wasting an issuer round-trip on a doomed form.
 *   - Adaptive deadline: when the Subscribe button enters
 *     `SubmitButton--processing` state, extend the deadline once by
 *     `submitTimeoutMs` so a slow issuer (90-180s on Indonesian banks during
 *     peak hours) is not classified as `timeout`.
 */
export async function submitAndClassify(
  page: Page,
  log: LogCallback,
  options: FillOptions = {}
): Promise<StripeSubmitOutcome> {
  const submitTimeout = options.submitTimeoutMs ?? 180000

  // Pre-submit short-circuit — classify any visible field error so we don't
  // burn the full submitTimeout on a card we already know is broken.
  const preFieldErrs = await readFieldErrors(page)
  for (const msg of preFieldErrs) {
    const c = classifyMessage(msg)
    if (!c) continue
    log(`[stripe] pre-submit classified field error → ${c.kind}: ${msg}`)
    if (c.kind === 'declined') return { kind: 'declined', message: c.message, code: c.code }
    if (c.kind === 'unsupported') return { kind: 'unsupported', message: c.message }
    if (c.kind === 'validation') return { kind: 'validation', message: c.message }
  }

  const submitLoc = page.locator(SUBMIT_BUTTON_SELECTOR).first()
  try {
    await submitLoc.waitFor({ state: 'visible', timeout: 10000 })
  } catch {
    return {
      kind: 'error',
      message: 'Subscribe button never appeared'
    }
  }

  // Submit button can render visible-but-disabled while Stripe runs its own
  // post-blur validation. Wait for it to actually become clickable — capped
  // so we don't hang on a permanently-disabled state.
  const enabledByDeadline = Date.now() + 8000
  while (Date.now() < enabledByDeadline) {
    const disabled = await submitLoc.isDisabled().catch(() => false)
    const ariaDisabled = await submitLoc.getAttribute('aria-disabled').catch(() => null)
    if (!disabled && ariaDisabled !== 'true') break
    await sleep(250)
  }

  log('[stripe] clicking Subscribe')
  try {
    await humanClick(page, submitLoc, { dwellMs: [200, 480] })
  } catch (e) {
    return {
      kind: 'error',
      message: `submit click failed: ${e instanceof Error ? e.message : String(e)}`
    }
  }

  // Poll for any of: success navigation, 3DS frame, decline/validation text.
  let deadline = Date.now() + submitTimeout
  let extendedForProcessing = false
  let lastLoggedState = ''
  let processingLoggedAt = 0
  while (Date.now() < deadline) {
    if (page.isClosed()) {
      return { kind: 'timeout', detail: 'page closed unexpectedly' }
    }

    const currentUrl = page.url()

    // Success — Stripe redirects back to a Kiro / session URL or its own
    // /p/p_… success route, OR appends ?redirect_status=succeeded.
    try {
      const u = new URL(currentUrl)
      const host = u.hostname
      if (
        host.endsWith('kiro.dev') ||
        /\/p\/p_[a-z0-9]+\/?success/i.test(currentUrl) ||
        /[?&](?:redirect_status|payment_intent_status)=succeeded/i.test(currentUrl) ||
        /\/checkout\/success\b/i.test(u.pathname)
      ) {
        log(`[stripe] resolved to success URL ${currentUrl}`)
        return { kind: 'success', finalUrl: currentUrl }
      }
    } catch {}

    // 3DS detection — checked before banner because some 3DS flows briefly
    // flash an "authentication required" banner before the iframe mounts.
    const threeDsFrame = await findThreeDsFrame(page)
    if (threeDsFrame) {
      const frameUrl = threeDsFrame.url()
      log(`[stripe] detected 3DS challenge frame: ${frameUrl}`)
      return { kind: '3ds', frameUrl }
    }

    // Adaptive deadline — Stripe enters `SubmitButton--processing` while the
    // payment intent is in-flight. Indonesian / regional issuers regularly
    // sit in this state for 90-180s before returning. Extend once.
    const isProcessing = await submitLoc
      .evaluate(
        (el) =>
          (el as HTMLElement).className.includes('SubmitButton--processing') ||
          el.getAttribute('aria-busy') === 'true'
      )
      .catch(() => false)
    if (isProcessing) {
      const now = Date.now()
      if (now - processingLoggedAt > 15000) {
        log('[stripe] Subscribe in Processing state — payment intent in-flight')
        processingLoggedAt = now
      }
      if (!extendedForProcessing && deadline - now < submitTimeout / 2) {
        deadline = now + submitTimeout
        extendedForProcessing = true
        log(
          `[stripe] extending submit deadline by ${Math.round(
            submitTimeout / 1000
          )}s — issuer still processing`
        )
      }
    }

    // Field-level errors (non-zero opacity).
    const fieldErrs = await readFieldErrors(page)
    if (fieldErrs.length > 0) {
      const joined = fieldErrs.join(' | ')
      if (joined !== lastLoggedState) {
        log(`[stripe] field errors: ${joined}`)
        lastLoggedState = joined
      }
      // Try to classify any of the field errors.
      for (const msg of fieldErrs) {
        const c = classifyMessage(msg)
        if (!c) continue
        if (c.kind === 'declined') return { kind: 'declined', message: c.message, code: c.code }
        if (c.kind === 'unsupported') return { kind: 'unsupported', message: c.message }
        if (c.kind === 'validation') return { kind: 'validation', message: c.message }
      }
    }

    // Top-of-form banner / global error.
    const banner = await readGlobalError(page)
    if (banner && banner !== lastLoggedState) {
      log(`[stripe] banner: ${banner}`)
      lastLoggedState = banner
    }
    if (banner) {
      const c = classifyMessage(banner)
      if (c?.kind === 'declined') return { kind: 'declined', message: c.message, code: c.code }
      if (c?.kind === 'unsupported') return { kind: 'unsupported', message: c.message }
      if (c?.kind === 'validation') return { kind: 'validation', message: c.message }
    }

    await sleep(750)
  }

  // Final attempt — maybe we're already on a success destination we missed.
  try {
    const host = new URL(page.url()).hostname
    if (host.endsWith('kiro.dev')) {
      return { kind: 'success', finalUrl: page.url() }
    }
  } catch {}
  return { kind: 'timeout', detail: `last url: ${page.url()}` }
}

/**
 * Convenience wrapper: fill + submit + classify in one call.
 */
export async function runStripeCheckout(
  page: Page,
  vcc: VccEntry,
  log: LogCallback,
  options: FillOptions = {}
): Promise<StripeSubmitOutcome> {
  await fillStripeCheckout(page, vcc, log, options)
  return submitAndClassify(page, log, options)
}

/**
 * Clear all card fields on the Stripe form so a different VCC can be retried
 * without reloading the whole page (which would lose the session and require
 * Kiro to re-issue the checkout). Used between attempts on
 * declined / validation / unsupported outcomes.
 *
 * Best-effort — failures here are non-fatal because the caller can also
 * recover by reopening the checkout link.
 */
export async function clearStripeForm(page: Page, log: LogCallback): Promise<boolean> {
  log('[stripe] clearing card fields for retry')

  const targets: Array<{ sel: string; label: string }> = [
    { sel: CARD_NUMBER_SELECTOR, label: 'cardNumber' },
    { sel: CARD_EXPIRY_SELECTOR, label: 'cardExpiry' },
    { sel: CARD_CVC_SELECTOR, label: 'cardCvc' }
    // Billing fields persist across retries — Stripe doesn't clear them and
    // re-typing wastes time AND looks unnatural ("user re-types address?").
    // We only re-type fields if name/country differ between cards (handled
    // in fillStripeCheckout's idempotent retype on focus).
  ]

  for (const { sel, label } of targets) {
    const visible = await page
      .locator(sel)
      .first()
      .isVisible()
      .catch(() => false)
    if (!visible) continue
    try {
      const loc = page.locator(sel).first()
      await loc.click({ timeout: 3000 })
      await sleep(jitter(80, 200))
      // Ctrl+A → Backspace clears even masked inputs across all 3 engines.
      await loc.press('Control+a').catch(() => {})
      await loc.press('Backspace').catch(() => {})
      await loc.click({ clickCount: 3, timeout: 3000 }).catch(() => {})
      await loc.press('Backspace').catch(() => {})
      await loc.press('Delete').catch(() => {})
      // Stripe's mask sometimes leaves a residual character — repeated
      // backspaces clear it without harming an already-empty field.
      for (let i = 0; i < 24; i++) {
        await loc.press('Backspace').catch(() => {})
      }
      await loc.press('Tab').catch(() => {})
    } catch (e) {
      log(`[stripe] field clear "${label}" failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  // Scroll back to the top so the next humanType starts in-view.
  try {
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'smooth' }))
  } catch {}
  await sleep(jitter(300, 700))

  return true
}

/**
 * Fill + submit with built-in retry on outcomes the caller cannot resolve
 * in-place (declines, validation, unsupported). Returns the LAST outcome
 * along with every intermediate attempt so the caller can pick the most
 * informative for diagnostics.
 *
 * Use this when the caller has multiple VCCs and wants to try them serially
 * without losing the Stripe session between cards. For 3DS / timeout /
 * generic error, returns immediately so the caller can decide policy.
 */
export type RetryStripeOptions = FillOptions & {
  /** Generator for the next VCC to try. Return null to stop retrying. */
  nextVcc: (lastOutcome: StripeSubmitOutcome) => Promise<VccEntry | null>
  /** Hard cap on attempts including the first. Default 3. */
  maxAttempts?: number
}

export type RetryStripeResult = {
  attempts: Array<{ vccId: string; last4: string; outcome: StripeSubmitOutcome }>
  lastOutcome: StripeSubmitOutcome
}

export async function runStripeCheckoutWithRetry(
  page: Page,
  firstVcc: VccEntry,
  log: LogCallback,
  options: RetryStripeOptions
): Promise<RetryStripeResult> {
  const max = Math.max(1, options.maxAttempts ?? 3)
  const attempts: RetryStripeResult['attempts'] = []
  let current: VccEntry | null = firstVcc
  let last: StripeSubmitOutcome = { kind: 'error', message: 'no attempts run' }

  for (let i = 0; i < max && current; i++) {
    if (i > 0) {
      // Reset form between cards.
      await clearStripeForm(page, log)
    }
    const out =
      i === 0
        ? await runStripeCheckout(page, current, log, options)
        : await runStripeCheckout(page, current, log, { ...options, skipPrewarm: true })
    attempts.push({
      vccId: current.id,
      last4: current.number.slice(-4),
      outcome: out
    })
    last = out
    if (
      out.kind === 'success' ||
      out.kind === '3ds' ||
      out.kind === 'timeout' ||
      out.kind === 'error'
    ) {
      break
    }
    current = await options.nextVcc(out)
    if (!current) break
  }

  return { attempts, lastOutcome: last }
}

function jitter(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min
}
