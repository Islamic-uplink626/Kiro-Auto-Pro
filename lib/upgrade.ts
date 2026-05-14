import { launchStealthBrowser, type BrowserEngine } from './browser'
import { hydrateKiroSession, loadKiroSession } from './session-hydrate'
import {
  checkProStatus,
  clickUpgradeToPro,
  dumpPageState,
  type ProStatus,
  type UpgradeClickResult
} from './kiro-pro'
import {
  clearStripeForm,
  fillStripeCheckout,
  submitAndClassify,
  type StripeSubmitOutcome
} from './stripe-checkout'
import { applyStripeStealthContext } from './stripe-stealth'
import { registerViaKiroGoogle } from './google-login'
import type { KiroSession } from './google-login'
import type { VccEntry } from './vcc'
import { VccPool } from './vcc'

type LogCallback = (message: string) => void

export type UpgradeStep =
  | 'launch'
  | 'auth'
  | 'hydrate'
  | 'google_login'
  | 'pro_check_initial'
  | 'upgrade_click'
  | 'stripe_fill_submit'
  | 'threeds_manual'
  | 'pro_check_final'

export type UpgradeReason =
  | 'already_pro'
  | 'hydrate_failed'
  | 'google_login_failed'
  | 'no_auth_available'
  | 'pro_status_indeterminate'
  | 'upgrade_button_not_found'
  | 'upgrade_redirect_failed'
  | 'stripe_declined'
  | 'stripe_validation'
  | 'stripe_timeout'
  | 'stripe_error'
  | 'threeds_required_headless'
  | 'threeds_manual_timeout'
  | 'pro_verification_failed'
  | 'no_vcc_available'
  | 'fatal'

export type UpgradeOutcomePerVcc =
  | { vccId: string; last4: string; outcome: StripeSubmitOutcome }
  | { vccId: string; last4: string; outcome: { kind: 'skipped'; reason: string } }

export type UpgradeResult =
  | {
      success: true
      email: string
      engine: BrowserEngine
      usedVcc: { id: string; last4: string }
      attempts: UpgradeOutcomePerVcc[]
      finalProStatus: ProStatus
    }
  | {
      success: false
      email: string
      engine: BrowserEngine
      step: UpgradeStep
      reason: UpgradeReason
      error: string
      attempts: UpgradeOutcomePerVcc[]
      usedVcc?: { id: string; last4: string }
      /** Pro status observed at the end, if we got that far. */
      finalProStatus?: ProStatus
    }

export type UpgradeOptions = {
  /** Parsed session JSON (loaded from show/sessions/<email>.<ts>.json).
   *  Only required when `authMode` is `hydrate` or `hydrate_or_login`. */
  session?: KiroSession
  /** Email to upgrade — required for `google_login` mode, inferred from session otherwise. */
  email?: string
  /** Google password for `google_login` / `hydrate_or_login` fallback. */
  password?: string
  /** Auth strategy:
   *   - `hydrate`            → use captured cookies+storage only. Fast but fragile (session may be expired).
   *   - `google_login`       → fresh Google OAuth every run. Robust, slower, re-triggers Google risk checks.
   *   - `hydrate_or_login`   → hydrate first; if Pro check comes back indeterminate OR we detect a /signin
   *                            redirect, fall back to google_login. Default. */
  authMode?: 'hydrate' | 'google_login' | 'hydrate_or_login'
  /** VCC pool — `claimNext()` is called once per attempt. */
  vccPool: VccPool
  log: LogCallback
  engine?: BrowserEngine
  headless?: boolean
  proxyUrl?: string
  useFingerprint?: boolean
  humanize?: boolean | number
  geoip?: string | boolean
  /** Up to how many VCCs to try on declines / validation errors. Default 1. */
  maxVccAttempts?: number
  /** When the Stripe submit hits 3DS in headless mode:
   *    - "auto_flip" (default) → close, relaunch headed, retry the whole flow.
   *    - "pause"               → keep the browser open for the current flow to complete 3DS.
   *    - "fail"                → return threeds_required_headless and stop. */
  on3ds?: 'auto_flip' | 'pause' | 'fail'
  /** Max time to wait for a human to finish 3DS when we've paused. Default 5 min. */
  threeDsManualTimeoutMs?: number
}

const DEFAULT_MAX_VCC_ATTEMPTS = 1
const DEFAULT_3DS_TIMEOUT_MS = 5 * 60 * 1000

function last4(pan: string): string {
  return pan.replace(/\D+/g, '').slice(-4)
}

/**
 * Clear the Kiro-origin auth state before re-running a Google login.
 *
 * Kiro's SPA short-circuits /signin → /account/usage when a RefreshToken
 * cookie is already present. Re-running `registerViaKiroGoogle()` after a
 * dead hydrate lands on /account/usage instead of /signin, so the Google
 * button never renders and we get `google_button_not_found`.
 *
 * We clear:
 *   - app.kiro.dev cookies (auth + visitor id)
 *   - Cognito auth cookies (brokered IdP state)
 *   - localStorage / sessionStorage on app.kiro.dev
 *
 * We do NOT touch Google / YouTube cookies — keeping the Google session lets
 * us skip the password prompt if the account is already signed in at Google.
 */
async function prepareForFreshLogin(
  page: import('playwright').Page,
  context: import('playwright').BrowserContext,
  log: LogCallback
): Promise<void> {
  try {
    const allCookies = await context.cookies()
    const survivors = allCookies.filter((c) => {
      const d = c.domain.replace(/^\./, '').toLowerCase()
      if (d === 'app.kiro.dev' || d === 'kiro.dev' || d.endsWith('.kiro.dev')) {
        return false
      }
      if (d.endsWith('amazoncognito.com')) return false
      return true
    })
    await context.clearCookies()
    if (survivors.length > 0) {
      await context.addCookies(
        survivors.map((c) => ({
          name: c.name,
          value: c.value,
          domain: c.domain,
          path: c.path,
          expires: c.expires === -1 ? undefined : c.expires,
          httpOnly: c.httpOnly,
          secure: c.secure,
          sameSite: c.sameSite
        }))
      )
    }
    log(
      `[upgrade] cleared Kiro+Cognito cookies before Google login (kept ${survivors.length} non-Kiro cookies)`
    )
  } catch (e) {
    log(`[upgrade] cookie pruning failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`)
  }

  // Best-effort storage clear on the Kiro origin.
  try {
    if (/app\.kiro\.dev/.test(page.url())) {
      await page.evaluate(() => {
        try {
          window.localStorage.clear()
        } catch {}
        try {
          window.sessionStorage.clear()
        } catch {}
      })
    }
  } catch {
    // ignore — blank/about:blank pages throw on evaluate
  }
}

/** Wait for the 3DS flow to clear: either the challenge iframe disappears
 *  AND the URL moves to kiro.dev / Stripe success, or we time out. */
async function waitForThreeDsCompletion(
  page: import('playwright').Page,
  log: LogCallback,
  timeoutMs: number
): Promise<'completed' | 'declined' | 'timeout'> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (page.isClosed()) {
      log('[upgrade] 3DS page closed before completion')
      return 'timeout'
    }

    const url = page.url()
    try {
      const host = new URL(url).hostname
      if (host.endsWith('kiro.dev')) {
        log(`[upgrade] 3DS completed → back on Kiro (${url})`)
        return 'completed'
      }
      if (/[?&](?:redirect_status|payment_intent_status)=succeeded/i.test(url)) {
        log(`[upgrade] 3DS completed via redirect_status=succeeded (${url})`)
        return 'completed'
      }
      if (/[?&](?:redirect_status|payment_intent_status)=failed/i.test(url)) {
        log(`[upgrade] 3DS failed (${url})`)
        return 'declined'
      }
    } catch {}

    await page.waitForTimeout(1500)
  }
  return 'timeout'
}

/**
 * Run a single upgrade session end-to-end for one Kiro account.
 *
 * The method is designed to be safe to call from the CLI runner in a loop
 * over show/sessions/*.json. All browser lifecycle is owned by this function:
 * on every exit path — success, retry, error, panic — we call `close()`.
 */
export async function upgradeKiroAccount(
  options: UpgradeOptions
): Promise<UpgradeResult> {
  const {
    session,
    vccPool,
    log,
    engine = 'camoufox',
    headless = true,
    proxyUrl,
    useFingerprint = true,
    humanize = true,
    geoip = !!proxyUrl,
    maxVccAttempts = DEFAULT_MAX_VCC_ATTEMPTS,
    on3ds = 'auto_flip',
    threeDsManualTimeoutMs = DEFAULT_3DS_TIMEOUT_MS
  } = options

  // Resolve the account identity and auth policy.
  const email = options.email ?? session?.email
  if (!email) {
    return {
      success: false,
      email: '(unknown)',
      engine,
      step: 'auth',
      reason: 'no_auth_available',
      error: 'upgradeKiroAccount requires either session or email',
      attempts: []
    }
  }
  const password = options.password
  // Default policy: try hydrate first, fall back to fresh Google login. If
  // only one of (session, password) is supplied, collapse to that mode so
  // the intent is unambiguous.
  const authMode: UpgradeOptions['authMode'] =
    options.authMode ??
    (session && password
      ? 'hydrate_or_login'
      : session
        ? 'hydrate'
        : password
          ? 'google_login'
          : 'hydrate')
  if (authMode !== 'hydrate' && !password) {
    return {
      success: false,
      email,
      engine,
      step: 'auth',
      reason: 'no_auth_available',
      error: `authMode=${authMode} requires a Google password — pass options.password (usually loaded from accounts/gsuite.txt)`,
      attempts: []
    }
  }
  if (authMode === 'hydrate' && !session) {
    return {
      success: false,
      email,
      engine,
      step: 'auth',
      reason: 'no_auth_available',
      error: 'authMode=hydrate requires options.session',
      attempts: []
    }
  }

  log(`========== Kiro upgrade-to-Pro ==========`)
  log(`account: ${email}`)
  log(
    `engine: ${engine} | headless: ${headless} | proxy: ${proxyUrl ?? '(none)'} | authMode: ${authMode} | on3ds: ${on3ds}`
  )

  const attempts: UpgradeOutcomePerVcc[] = []
  let headlessForThisRun = headless
  let allowRelaunchHeaded = headless && on3ds === 'auto_flip'

  // Outer loop: may restart from scratch when we flip headless→headed on 3DS.
  for (let relaunch = 0; relaunch < 2; relaunch++) {
    let browserSession: Awaited<ReturnType<typeof launchStealthBrowser>> | null = null

    try {
      browserSession = await launchStealthBrowser({
        engine,
        headless: headlessForThisRun,
        proxyUrl,
        useFingerprint,
        humanize,
        geoip,
        log
      })
      // Wire extra-stealth init scripts onto the BrowserContext before any
      // navigation lands on Stripe — the script self-gates on the host so
      // it's a no-op on Kiro / Google / Cognito and fires only on
      // checkout.stripe.com.
      try {
        await applyStripeStealthContext(browserSession.context, engine, log)
      } catch (e) {
        log(
          `[upgrade] WARN: failed to install Stripe stealth init script: ${
            e instanceof Error ? e.message : String(e)
          } — continuing`
        )
      }
    } catch (e) {
      return {
        success: false,
        email,
        engine,
        step: 'launch',
        reason: 'fatal',
        error: `browser launch failed: ${e instanceof Error ? e.message : String(e)}`,
        attempts
      }
    }

    try {
      // Step 1 — authenticate. hydrate / google_login / hydrate_or_login.
      let authUsed: 'hydrate' | 'google_login' = 'hydrate'
      let hydrateErr: Error | null = null
      if (authMode === 'hydrate' || authMode === 'hydrate_or_login') {
        try {
          await hydrateKiroSession(
            browserSession.page,
            browserSession.context,
            session!,
            log
          )
          authUsed = 'hydrate'
        } catch (e) {
          hydrateErr = e instanceof Error ? e : new Error(String(e))
          if (authMode === 'hydrate') {
            return {
              success: false,
              email,
              engine,
              step: 'hydrate',
              reason: 'hydrate_failed',
              error: hydrateErr.message,
              attempts
            }
          }
          log(`[upgrade] hydrate failed (${hydrateErr.message}) — falling back to Google login`)
        }
      }

      // Decide whether we need a Google login. Triggers:
      //   - authMode === 'google_login'   → always
      //   - hydrate threw                 → yes (only reachable in hydrate_or_login)
      //   - hydrate looks dead (landed on /signin or /signin/oauth)     → yes
      let needLogin = authMode === 'google_login' || hydrateErr !== null
      if (!needLogin && authMode === 'hydrate_or_login') {
        const url = browserSession.page.url()
        if (/\/signin(?:[/?#]|$)/i.test(url)) {
          log(`[upgrade] hydrate landed on ${url} — session expired, doing Google login`)
          needLogin = true
        }
      }

      if (needLogin) {
        await prepareForFreshLogin(browserSession.page, browserSession.context, log)
        const result = await registerViaKiroGoogle(
          browserSession.page,
          browserSession.context,
          email,
          password!,
          log
        )
        if (!result.success) {
          return {
            success: false,
            email,
            engine,
            step: 'google_login',
            reason: 'google_login_failed',
            error: `google login: ${result.reason}${result.detail ? ` (${result.detail})` : ''}`,
            attempts
          }
        }
        authUsed = 'google_login'
        log(`[upgrade] Google login OK — landed on ${new URL(result.finalUrl).host}`)
        // Land on the usage page so Pro check has a consistent starting point.
        try {
          await browserSession.page.goto('https://app.kiro.dev/account/usage', {
            waitUntil: 'domcontentloaded',
            timeout: 30000
          })
        } catch {}
      }

      // Step 2 — is this account already Pro?
      const initialStatus = await checkProStatus(browserSession.page, log)
      if (initialStatus.isPro) {
        log(`[upgrade] ${email} is already on Pro — skipping`)
        return {
          success: true,
          email,
          engine,
          usedVcc: { id: 'none', last4: '----' },
          attempts: [
            {
              vccId: 'none',
              last4: '----',
              outcome: { kind: 'skipped', reason: 'already_pro' }
            }
          ],
          finalProStatus: initialStatus
        }
      }

      // Indeterminate on hydrate-only auth often means the cookies are stale
      // but the server hasn't redirected to /signin yet. If we haven't tried
      // google_login yet AND we have a password, escalate.
      let currentStatus: ProStatus = initialStatus
      if (
        initialStatus.signal === 'indeterminate' &&
        authUsed === 'hydrate' &&
        authMode === 'hydrate_or_login' &&
        password
      ) {
        log(
          '[upgrade] Pro check indeterminate after hydrate — escalating to Google login'
        )
        await prepareForFreshLogin(browserSession.page, browserSession.context, log)
        const result = await registerViaKiroGoogle(
          browserSession.page,
          browserSession.context,
          email,
          password,
          log
        )
        if (!result.success) {
          return {
            success: false,
            email,
            engine,
            step: 'google_login',
            reason: 'google_login_failed',
            error: `google login (escalated): ${result.reason}${
              result.detail ? ` (${result.detail})` : ''
            }`,
            attempts
          }
        }
        try {
          await browserSession.page.goto('https://app.kiro.dev/account/usage', {
            waitUntil: 'domcontentloaded',
            timeout: 30000
          })
        } catch {}
        const retryStatus = await checkProStatus(browserSession.page, log)
        currentStatus = retryStatus
        if (retryStatus.isPro) {
          return {
            success: true,
            email,
            engine,
            usedVcc: { id: 'none', last4: '----' },
            attempts: [
              {
                vccId: 'none',
                last4: '----',
                outcome: { kind: 'skipped', reason: 'already_pro' }
              }
            ],
            finalProStatus: retryStatus
          }
        }
      }

      if (!currentStatus.isPro && currentStatus.signal !== 'upgrade_present') {
        await dumpPageState(
          browserSession.page,
          `${email}.pro_check_${currentStatus.signal}`,
          log
        )
        return {
          success: false,
          email,
          engine,
          step: 'pro_check_initial',
          reason: 'pro_status_indeterminate',
          error: `could not confirm Free tier before clicking Upgrade to Pro${
            currentStatus.detail ? ` (${currentStatus.detail})` : ''
          }`,
          attempts,
          finalProStatus: currentStatus
        }
      }

      // Step 3 — click Upgrade to Pro → Stripe checkout.
      const upgradeClick: UpgradeClickResult = await clickUpgradeToPro(
        browserSession.page,
        log
      )
      if (!upgradeClick.success) {
        // Diagnostics: dump screenshot + HTML + button inventory so the user
        // can inspect exactly what was on screen when we failed.
        await dumpPageState(
          browserSession.page,
          `${email}.upgrade_click_${upgradeClick.reason}`,
          log
        )
        return {
          success: false,
          email: email,
          engine,
          step: 'upgrade_click',
          reason:
            upgradeClick.reason === 'button_not_found'
              ? 'upgrade_button_not_found'
              : 'upgrade_redirect_failed',
          error: `upgrade click: ${upgradeClick.reason}${
            upgradeClick.detail ? ` (${upgradeClick.detail})` : ''
          }`,
          attempts
        }
      }

      const stripePage = upgradeClick.page
      log(
        `[upgrade] at Stripe checkout (${upgradeClick.mode}): ${new URL(upgradeClick.url).host}`
      )

      // Inner loop: try up to `maxVccAttempts` cards. A decline/validation
      // consumes a card and re-requests the form; a 3DS escalates out.
      let lastOutcome: StripeSubmitOutcome | null = null
      let consumedVcc: { id: string; last4: string } | null = null
      // Track whether the form has been filled at least once so we know
      // whether to clear+refill or fill fresh on the next attempt.
      let formFilledOnce = false

      for (let attempt = 0; attempt < maxVccAttempts; attempt++) {
        const claim = await vccPool.claimNext()
        if (!claim) {
          if (attempt === 0) {
            return {
              success: false,
              email: email,
              engine,
              step: 'stripe_fill_submit',
              reason: 'no_vcc_available',
              error: 'no unused VCC in pool',
              attempts
            }
          }
          log(`[upgrade] VCC pool exhausted after ${attempt} attempts — giving up`)
          break
        }

        const vcc = claim.vcc
        const l4 = last4(vcc.number)
        log(
          `[upgrade] attempt #${attempt + 1}/${maxVccAttempts} with VCC id=${vcc.id} last4=${l4}`
        )

        let outcome: StripeSubmitOutcome
        try {
          if (formFilledOnce) {
            // Reset card fields between attempts so we don't lose the Stripe
            // session. Billing fields persist (Stripe keeps them) — fill is
            // idempotent and re-types only the card columns.
            await clearStripeForm(stripePage, log)
          }
          await fillStripeCheckout(stripePage, vcc, log, {
            // Skip prewarm on retry — already warmed once.
            skipPrewarm: formFilledOnce
          })
          formFilledOnce = true
          outcome = await submitAndClassify(stripePage, log)
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e)
          // fillStripeCheckout throws on definitive typing failures
          // (cardNumber / cardExpiry / cardCvc could not be typed cleanly).
          // Map those to `validation` so the VCC is marked invalid and the
          // outer loop can advance to the next card if maxVccAttempts > 1.
          // Anything else is a generic error and aborts.
          if (/(card number|expiry|cvc) could not be typed/i.test(msg)) {
            outcome = { kind: 'validation', message: msg }
          } else {
            outcome = { kind: 'error', message: msg }
          }
        }

        lastOutcome = outcome
        attempts.push({ vccId: vcc.id, last4: l4, outcome })

        if (outcome.kind === 'success') {
          consumedVcc = { id: vcc.id, last4: l4 }
          await claim.release({ status: 'success', usedBy: email })
          break
        }

        if (outcome.kind === '3ds') {
          // Decide policy BEFORE persisting state, so we can retry with the
          // same VCC when we relaunch headed.
          if (headlessForThisRun && on3ds === 'auto_flip') {
            log('[upgrade] 3DS required in headless mode — flipping to headed and retrying')
            await claim.abandon()
            headlessForThisRun = false
            allowRelaunchHeaded = false // one-shot flip
            // Break out of the VCC loop; outer loop will relaunch.
            consumedVcc = { id: vcc.id, last4: l4 }
            break
          }
          if (on3ds === 'fail') {
            await claim.release({
              status: 'challenge',
              reason: '3ds_required',
              usedBy: email
            })
            return {
              success: false,
              email: email,
              engine,
              step: 'stripe_fill_submit',
              reason: 'threeds_required_headless',
              error: '3DS challenge required — set --headed or on3ds="auto_flip"/"pause"',
              attempts,
              usedVcc: { id: vcc.id, last4: l4 }
            }
          }
          // on3ds === 'pause' — we keep the page open and wait for completion.
          log(
            `[upgrade] 3DS challenge in progress — waiting up to ${Math.round(
              threeDsManualTimeoutMs / 1000
            )}s for manual completion`
          )
          const resolution = await waitForThreeDsCompletion(
            stripePage,
            log,
            threeDsManualTimeoutMs
          )
          if (resolution === 'completed') {
            consumedVcc = { id: vcc.id, last4: l4 }
            await claim.release({ status: 'success', usedBy: email })
            lastOutcome = { kind: 'success', finalUrl: stripePage.url() }
            attempts[attempts.length - 1] = {
              vccId: vcc.id,
              last4: l4,
              outcome: lastOutcome
            }
            break
          }
          if (resolution === 'declined') {
            await claim.release({
              status: 'declined',
              reason: '3ds_failed',
              usedBy: email
            })
            // fall through to next attempt (if any)
            continue
          }
          await claim.release({
            status: 'challenge',
            reason: '3ds_manual_timeout',
            usedBy: email
          })
          return {
            success: false,
            email: email,
            engine,
            step: 'threeds_manual',
            reason: 'threeds_manual_timeout',
            error: `manual 3DS did not complete within ${Math.round(
              threeDsManualTimeoutMs / 1000
            )}s`,
            attempts,
            usedVcc: { id: vcc.id, last4: l4 }
          }
        }

        if (outcome.kind === 'declined') {
          log(
            `[upgrade] card declined (${outcome.code ?? 'unknown'}: ${outcome.message}) — trying next VCC if available`
          )
          await claim.release({
            status: 'declined',
            reason: `${outcome.code ?? 'declined'}: ${outcome.message}`,
            usedBy: email
          })
          continue
        }

        if (outcome.kind === 'unsupported') {
          // Functionally a decline (issuer/scheme rejection) but tag it
          // distinctly so a future BIN filter can avoid the same scheme.
          log(`[upgrade] payment not supported — marking VCC and trying next: ${outcome.message}`)
          await claim.release({
            status: 'invalid',
            reason: `unsupported: ${outcome.message}`,
            usedBy: email
          })
          continue
        }

        if (outcome.kind === 'validation') {
          log(`[upgrade] VCC failed Stripe validation (${outcome.message}) — marking invalid`)
          await claim.release({
            status: 'invalid',
            reason: outcome.message,
            usedBy: email
          })
          continue
        }

        if (outcome.kind === 'timeout') {
          log(`[upgrade] Stripe submit timed out — aborting this account`)
          // Diagnostic dump for offline analysis.
          await dumpPageState(
            stripePage,
            `${email}.stripe_timeout`,
            log
          ).catch(() => null)
          await claim.release({
            status: 'failed',
            reason: outcome.detail ?? 'timeout',
            usedBy: email
          })
          return {
            success: false,
            email: email,
            engine,
            step: 'stripe_fill_submit',
            reason: 'stripe_timeout',
            error: outcome.detail ?? 'Stripe submit timed out',
            attempts,
            usedVcc: { id: vcc.id, last4: l4 }
          }
        }

        // outcome.kind === 'error'
        log(`[upgrade] Stripe error: ${outcome.message}`)
        await dumpPageState(
          stripePage,
          `${email}.stripe_error`,
          log
        ).catch(() => null)
        await claim.release({
          status: 'failed',
          reason: outcome.message,
          usedBy: email
        })
        return {
          success: false,
          email: email,
          engine,
          step: 'stripe_fill_submit',
          reason: 'stripe_error',
          error: outcome.message,
          attempts,
          usedVcc: { id: vcc.id, last4: l4 }
        }
      }

      // Ended the VCC loop. What happened?
      if (!lastOutcome || lastOutcome.kind !== 'success') {
        // If we broke out due to an auto-flip, the outer loop will retry.
        if (!headlessForThisRun && !allowRelaunchHeaded && lastOutcome?.kind === '3ds') {
          log('[upgrade] relaunching browser in headed mode for 3DS retry')
          await browserSession.close()
          browserSession = null
          continue // outer relaunch
        }

        // Otherwise we're out of cards and the last outcome was non-success.
        const lastAttempt = attempts[attempts.length - 1]
        const reason: UpgradeReason =
          lastOutcome?.kind === 'declined'
            ? 'stripe_declined'
            : lastOutcome?.kind === 'unsupported'
              ? 'stripe_declined'
              : lastOutcome?.kind === 'validation'
                ? 'stripe_validation'
                : lastOutcome?.kind === '3ds'
                  ? 'threeds_required_headless'
                  : 'stripe_error'
        return {
          success: false,
          email: email,
          engine,
          step: 'stripe_fill_submit',
          reason,
          error: `exhausted ${attempts.length} VCC attempts: ${
            lastOutcome ? JSON.stringify(lastOutcome) : 'no attempts'
          }`,
          attempts,
          usedVcc:
            lastAttempt && 'vccId' in lastAttempt
              ? { id: lastAttempt.vccId, last4: lastAttempt.last4 }
              : undefined
        }
      }

      // Success — go verify in Kiro. Stripe should have redirected back to
      // app.kiro.dev already; if not, nav there explicitly.
      const verifyPage = stripePage
      if (!/app\.kiro\.dev/i.test(verifyPage.url())) {
        log('[upgrade] nav back to app.kiro.dev to verify Pro status')
        try {
          await verifyPage.goto('https://app.kiro.dev/account/usage', {
            waitUntil: 'domcontentloaded',
            timeout: 30000
          })
        } catch {}
      }

      const finalStatus = await checkProStatus(verifyPage, log)
      if (!finalStatus.isPro) {
        return {
          success: false,
          email: email,
          engine,
          step: 'pro_check_final',
          reason: 'pro_verification_failed',
          error: `Stripe reported success but Kiro still shows ${finalStatus.signal}`,
          attempts,
          usedVcc: consumedVcc ?? undefined,
          finalProStatus: finalStatus
        }
      }

      log(`[upgrade] ✅ ${email} is now on Pro (${finalStatus.detail ?? 'badge'})`)
      return {
        success: true,
        email: email,
        engine,
        usedVcc: consumedVcc!,
        attempts,
        finalProStatus: finalStatus
      }
    } catch (e) {
      return {
        success: false,
        email: email,
        engine,
        step: 'launch',
        reason: 'fatal',
        error: e instanceof Error ? e.message : String(e),
        attempts
      }
    } finally {
      if (browserSession) {
        await browserSession.close().catch(() => {})
      }
    }
  }

  // Outer loop fell through without returning — shouldn't happen, but be safe.
  return {
    success: false,
    email: email,
    engine,
    step: 'launch',
    reason: 'fatal',
    error: 'upgrade loop exhausted without a terminal result',
    attempts
  }
}

export type UpgradeOneOptions = Omit<UpgradeOptions, 'session'> & {
  sessionPath: string
}

/** Convenience: load a session JSON from disk and run the upgrade flow. */
export async function upgradeFromSessionFile(
  options: UpgradeOneOptions
): Promise<UpgradeResult> {
  const session = await loadKiroSession(options.sessionPath)
  return upgradeKiroAccount({ ...options, session })
}

export type { VccEntry }
