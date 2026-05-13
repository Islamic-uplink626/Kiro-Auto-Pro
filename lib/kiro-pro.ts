import type { Page } from 'playwright'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'

type LogCallback = (message: string) => void

const KIRO_ORIGIN = 'https://app.kiro.dev'
const KIRO_USAGE_URL = `${KIRO_ORIGIN}/account/usage`

/** Upgrade-to-Pro button locators.
 *
 *  The /account/usage page renders FOUR plan cards (Free / Pro / Pro+ / Power).
 *  Free has no upgrade button; the other three each render
 *  `<button class="… _upgradeButton_… …"><span class="acme-Button-label">Upgrade to Pro[|+|Power]</span></button>`.
 *
 *  Matching the generic `_upgradeButton_` class + `.first()` is dangerous —
 *  DOM order is Pro, Pro+, Power, and `:has-text("Upgrade to Pro")` substring-
 *  matches "Upgrade to Pro+" too. We therefore pin the selector to the exact
 *  label via `text-is(...)`, with a secondary fallback that combines the stable
 *  Mantine class prefix with the exact label inside the button's inner span. */
const UPGRADE_BUTTON_LOCATORS = [
  'button[class*="_upgradeButton_"]:has(span.acme-Button-label >> text-is("Upgrade to Pro"))',
  'button:has(span.acme-Button-label >> text-is("Upgrade to Pro"))',
  'button >> text-is("Upgrade to Pro")',
  '[role="button"] >> text-is("Upgrade to Pro")'
]

/** Anchor selector for the plan cards container. When this locator becomes
 *  visible we know the usage page has finished fetching + rendering the plan
 *  table, so button visibility checks thereafter give meaningful answers. */
const PLAN_CARDS_ANCHOR_SELECTORS = [
  '[class*="_planCard_"]',
  'text=/KIRO\\s+FREE/i',
  'text=/KIRO\\s+PRO/i'
]

/** AWS cookie-consent banner (`awsccc-*`) pins itself to the bottom of the
 *  Kiro SPA and intercepts clicks on the plan-card buttons that sit behind
 *  it. It appears on every fresh context / incognito session.
 *
 *  We dismiss by clicking Decline (most conservative) — Accept would opt the
 *  headless session into marketing cookies, which is both unnecessary and
 *  noisier. If Decline isn't rendered (some regions), fall back to Accept
 *  just to clear the overlay. */
const AWS_COOKIE_BANNER_SELECTOR =
  '#awsccc-cb-content, [data-id="awsccc-cb-btn-accept"], [data-id="awsccc-cb-btn-decline"]'

const AWS_COOKIE_BANNER_DISMISS_SELECTORS = [
  'button[data-id="awsccc-cb-btn-decline"]',
  'button[data-id="awsccc-cb-btn-accept"]'
]

async function dismissAwsCookieBanner(page: Page, log: LogCallback): Promise<boolean> {
  const visible = await page
    .locator(AWS_COOKIE_BANNER_SELECTOR)
    .first()
    .isVisible()
    .catch(() => false)
  if (!visible) return false
  for (const sel of AWS_COOKIE_BANNER_DISMISS_SELECTORS) {
    const btn = page.locator(sel).first()
    const btnVisible = await btn.isVisible().catch(() => false)
    if (!btnVisible) continue
    try {
      await btn.click({ timeout: 4000 })
      log(`[pro] dismissed AWS cookie banner via ${sel}`)
      await page.waitForTimeout(500)
      return true
    } catch {
      continue
    }
  }
  log('[pro] WARN: AWS cookie banner present but no dismiss button clickable')
  return false
}

const PRO_BADGE_LOCATORS = [
  // STRONGEST signal — Kiro writes this on the Mantine Badge component on
  // every authenticated page:
  //   <div aria-label="Current plan: KIRO PRO"><span class="acme-Badge-label">kiro pro</span></div>
  // The label text is lowercase via CSS text-transform, but the aria-label
  // keeps the canonical tier name. Match the aria-label first.
  '[aria-label^="Current plan:" i]',
  '[aria-label*="KIRO PRO" i]',
  '[aria-label*="KIRO POWER" i]',

  // Kiro's Mantine Badge element — always present for paid tiers.
  '.acme-Badge-root[aria-label*="Current plan" i]',

  // "Manage plan" button only renders for subscribed tiers. Free tier
  // shows an "Upgrade to Pro" button instead (which is caught above).
  'button:has-text("Manage plan")',

  // Account / usage page typically renders a plan chip. Match generically
  // rather than relying on one Mantine-hashed classname.
  ':is(span,div,p,h1,h2,h3):has-text("Pro Plan")',
  ':is(span,div,p,h1,h2,h3):has-text("Plan: Pro")',
  ':is(span,div,p,h1,h2,h3):text-matches("^\\s*(?:KIRO\\s+)?PRO(?:\\+|\\s+PLUS)?\\s*$", "i")',
  ':is(span,div,p,h1,h2,h3):text-matches("^\\s*KIRO\\s+POWER\\s*$", "i")',
  '[data-plan="pro"]',
  '[data-tier="pro"]'
]

const PRO_EXCLUSION_TEXTS = [
  // False-positive guards — these contain "Pro" but are not the plan label.
  'Upgrade to Pro',
  'Get Pro',
  'Go Pro',
  'Try Pro'
]

export type ProStatus =
  | { isPro: true; signal: 'badge' | 'upgrade_absent'; detail?: string }
  | { isPro: false; signal: 'upgrade_present' | 'indeterminate'; detail?: string }

export type CheckProOptions = {
  /** Overall deadline for the SPA to mount either signal. Default 25s. */
  timeoutMs?: number
  /** How often to poll. Default 750ms. */
  pollMs?: number
}

async function firstVisibleSelector(
  page: Page,
  selectors: string[]
): Promise<string | null> {
  for (const sel of selectors) {
    const visible = await page
      .locator(sel)
      .first()
      .isVisible()
      .catch(() => false)
    if (visible) return sel
  }
  return null
}

async function firstVisibleProBadge(
  page: Page
): Promise<{ selector: string; text: string } | null> {
  for (const sel of PRO_BADGE_LOCATORS) {
    const locator = page.locator(sel).first()
    const visible = await locator.isVisible().catch(() => false)
    if (!visible) continue
    // Pull text from aria-label AND textContent — aria-label carries the
    // canonical tier name ("KIRO PRO") even when the visible label is
    // lowercased or icon-only.
    const aria = (await locator.getAttribute('aria-label').catch(() => null)) ?? ''
    const text = (await locator.textContent().catch(() => '')) ?? ''
    const norm = `${aria} ${text}`.replace(/\s+/g, ' ').trim()
    if (!norm) continue
    if (PRO_EXCLUSION_TEXTS.some((t) => norm.toLowerCase().includes(t.toLowerCase()))) {
      continue
    }
    // "Manage plan" button is itself a Pro-tier signal (Free tier has no
    // such button). It won't necessarily contain the word "Pro", so accept it
    // based on selector provenance.
    const isManagePlanSignal = /Manage plan/i.test(sel)
    if (!isManagePlanSignal) {
      // For all other selectors, require the match text to mention a tier
      // keyword — guards against false positives from generic text selectors.
      if (!/\b(?:pro|power|plus)\b/i.test(norm)) continue
    }
    return { selector: sel, text: norm }
  }
  return null
}

/**
 * Check if the currently-authenticated Kiro account is on the Pro tier.
 *
 * Decision order (strongest signal first):
 *   1. "Upgrade to Pro" button visible → definitely FREE.
 *   2. A Pro plan badge is visible → definitely PRO.
 *   3. Neither → indeterminate (treat as not-pro so the caller retries).
 *
 * Uses deadline polling rather than a single-pass check because the SPA
 * mounts asynchronously after hydrate — a single isVisible() call right
 * after navigation will race the React tree and return false for both
 * signals on a perfectly healthy page.
 *
 * Must be called AFTER session hydration has landed on app.kiro.dev.
 */
export async function checkProStatus(
  page: Page,
  log: LogCallback,
  options: CheckProOptions = {}
): Promise<ProStatus> {
  const timeoutMs = options.timeoutMs ?? 45000
  const pollMs = options.pollMs ?? 750

  // Always FORCE a fresh navigation to the usage page. A post-login callback
  // may have left us on /account/dashboard, /welcome, an onboarding modal,
  // etc., and the plan grid only renders at /account/usage. A conditional
  // `if not on usage, goto` also means we wouldn't re-fetch if the SPA
  // swallowed the token exchange silently — so we always goto, unconditionally.
  //
  // Retry once on NS_BINDING_ABORTED / "navigation aborted": Firefox/camoufox
  // raises that when a previous in-flight navigation (e.g. the SPA's own
  // client-side route change right after auth) is superseded by ours. The
  // page actually loaded — the abort is on the prior request — so a second
  // goto with the same URL succeeds cleanly.
  const navigate = async (attempt: number): Promise<boolean> => {
    try {
      await page.goto(KIRO_USAGE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 })
      return true
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      const isAbort =
        /NS_BINDING_ABORTED|net::ERR_ABORTED|navigation (?:is )?aborted/i.test(msg)
      if (isAbort && attempt < 2) {
        log(`[pro] usage nav aborted (attempt ${attempt}) — retrying: ${msg}`)
        await page.waitForTimeout(500)
        return navigate(attempt + 1)
      }
      log(`[pro] usage page nav failed: ${msg}`)
      return false
    }
  }
  if (!(await navigate(1))) {
    // Final fallback: if we're already on the usage page despite the nav
    // error, proceed with polling — the detection logic is URL-agnostic.
    if (!/\/account\/usage(?:[/?#]|$)/.test(page.url())) {
      return { isPro: false, signal: 'indeterminate', detail: 'nav_failed' }
    }
    log(`[pro] nav reported error but page.url() is already on /account/usage — proceeding`)
  }

  // Let the SPA fetch its plan list. networkidle is a best-effort signal —
  // don't block the whole flow on it.
  try {
    await page.waitForLoadState('networkidle', { timeout: 15000 })
  } catch {
    // Proceed with anchor + poll anyway.
  }

  // Dismiss the AWS cookie-consent banner if present — it overlays the plan
  // cards and intercepts clicks on the upgrade buttons.
  await dismissAwsCookieBanner(page, log)

  // Wait for the plan-cards container to render. This is the authoritative
  // "the SPA is done fetching and painting" signal — any earlier poll is
  // racing react state. If it never mounts, we drop through to the loop
  // which will still try and eventually bail as indeterminate.
  let anchorFound = false
  for (const anchor of PLAN_CARDS_ANCHOR_SELECTORS) {
    try {
      await page.locator(anchor).first().waitFor({ state: 'visible', timeout: 15000 })
      log(`[pro] plan cards anchor rendered (${anchor})`)
      anchorFound = true
      break
    } catch {
      continue
    }
  }
  if (!anchorFound) {
    log('[pro] plan cards anchor never mounted — falling through to best-effort poll')
  }

  // Deadline poll: upgrade-CTA vs Pro-badge. Even after the anchor is in the
  // DOM the specific plan card may hydrate a beat later, so we still poll.
  const deadline = Date.now() + timeoutMs
  let iteration = 0
  while (Date.now() < deadline) {
    iteration++

    const upgradeSel = await firstVisibleSelector(page, UPGRADE_BUTTON_LOCATORS)
    if (upgradeSel) {
      log(`[pro] found upgrade CTA via ${upgradeSel} → account is FREE`)
      return { isPro: false, signal: 'upgrade_present', detail: upgradeSel }
    }

    const badge = await firstVisibleProBadge(page)
    if (badge) {
      log(`[pro] found Pro badge "${badge.text}" → account is PRO`)
      return { isPro: true, signal: 'badge', detail: badge.text }
    }

    // Neither signal visible yet — if the page drifted off /account (e.g.
    // session expired → /signin), bail early instead of spinning the deadline.
    if (iteration > 3) {
      const url = page.url()
      if (!/\/account\b/.test(url)) {
        log(`[pro] landed outside /account (${url}) — treating as indeterminate`)
        return { isPro: false, signal: 'indeterminate', detail: `off-route: ${url}` }
      }
    }

    await page.waitForTimeout(pollMs)
  }

  log('[pro] deadline reached with neither upgrade CTA nor Pro badge — indeterminate')
  return { isPro: false, signal: 'indeterminate' }
}

export type UpgradeClickResult =
  | { success: true; mode: 'same_tab' | 'new_tab'; page: Page; url: string }
  | { success: false; reason: 'button_not_found' | 'no_navigation' | 'wrong_host'; detail?: string }

async function waitForUpgradeButton(
  page: Page,
  timeoutMs: number
): Promise<string | null> {
  // Wait for the plan-cards container first — without it, isVisible() races
  // React and always answers false.
  for (const anchor of PLAN_CARDS_ANCHOR_SELECTORS) {
    try {
      await page.locator(anchor).first().waitFor({ state: 'visible', timeout: 10000 })
      break
    } catch {
      continue
    }
  }

  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const sel = await firstVisibleSelector(page, UPGRADE_BUTTON_LOCATORS)
    if (sel) return sel
    await page.waitForTimeout(500)
  }
  return null
}

/**
 * Dump page state to disk for diagnosis when something failed silently.
 * Writes:
 *   - <dir>/<email>.<ts>.url.txt
 *   - <dir>/<email>.<ts>.html
 *   - <dir>/<email>.<ts>.png (screenshot, full page)
 *   - <dir>/<email>.<ts>.buttons.json (every button's text + class)
 *
 * Failures inside the dump itself are swallowed — diagnostic dumps must
 * never mask the original failure.
 */
export async function dumpPageState(
  page: Page,
  label: string,
  log: LogCallback,
  outDir = 'show/diagnostics'
): Promise<string | null> {
  const ts = Date.now()
  const safe = label.replace(/[^a-zA-Z0-9._-]+/g, '_')
  const base = `${safe}.${ts}`
  const absDir = resolve(outDir)
  try {
    await mkdir(absDir, { recursive: true })
  } catch {
    return null
  }

  try {
    const url = page.url()
    await writeFile(join(absDir, `${base}.url.txt`), url, 'utf-8').catch(() => {})

    // Buttons inventory — most actionable artefact when a click selector fails.
    try {
      const buttons = await page.evaluate(() => {
        const out: Array<{
          tag: string
          text: string
          className: string
          visible: boolean
        }> = []
        const els = Array.from(
          document.querySelectorAll<HTMLElement>('button, a[role="button"], [role="button"]')
        )
        for (const el of els) {
          const rect = el.getBoundingClientRect()
          const cs = window.getComputedStyle(el)
          const visible =
            rect.width > 0 &&
            rect.height > 0 &&
            cs.visibility !== 'hidden' &&
            cs.display !== 'none' &&
            cs.opacity !== '0'
          out.push({
            tag: el.tagName.toLowerCase(),
            text: (el.innerText ?? el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 80),
            className: el.className.toString().slice(0, 200),
            visible
          })
        }
        return out
      })
      await writeFile(
        join(absDir, `${base}.buttons.json`),
        JSON.stringify(buttons, null, 2),
        'utf-8'
      ).catch(() => {})
    } catch {}

    // HTML.
    try {
      const html = await page.content()
      await writeFile(join(absDir, `${base}.html`), html, 'utf-8').catch(() => {})
    } catch {}

    // Screenshot.
    try {
      await page
        .screenshot({ path: join(absDir, `${base}.png`), fullPage: true, timeout: 10000 })
        .catch(() => {})
    } catch {}

    log(`[diag] dumped page state to ${join(absDir, base)}.{html,png,buttons.json,url.txt}`)
    return join(absDir, base)
  } catch (e) {
    log(`[diag] dump failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`)
    return null
  }
}

/**
 * Click the Upgrade-to-Pro button and resolve to whichever Page ends up on
 * `checkout.stripe.com`. Kiro has historically opened Stripe in either:
 *   - the same tab (`window.location = ...`)  → detect via navigation event
 *   - a new tab (`window.open(...)`)          → detect via context `page` event
 *
 * Whichever arrives first wins; the other is ignored.
 */
export async function clickUpgradeToPro(
  page: Page,
  log: LogCallback,
  timeoutMs = 45000
): Promise<UpgradeClickResult> {
  const context = page.context()

  // Make sure the AWS cookie-consent banner isn't occluding the click target.
  // checkProStatus already dismisses it, but clickUpgradeToPro is a public
  // entry point too — so we guard here as well.
  await dismissAwsCookieBanner(page, log)

  // Resolve the upgrade button first so we don't race the click-before-visible.
  // Caller may run us before the SPA has mounted its Account header — poll.
  const chosenSelector = await waitForUpgradeButton(page, 30000)
  if (!chosenSelector) {
    return { success: false, reason: 'button_not_found' }
  }

  log(`[upgrade-click] clicking "${chosenSelector}"`)

  // Arm both navigation listeners BEFORE the click. We resolve as soon as
  // either fires — a `Promise.all` here would block until BOTH settle, so a
  // fast new-tab open would still pay the full same-tab waitForURL timeout.
  type ResolvedNav =
    | { mode: 'new_tab'; page: Page }
    | { mode: 'same_tab' }
    | null
  const newPagePromise: Promise<ResolvedNav> = context
    .waitForEvent('page', { timeout: timeoutMs })
    .then((p) => ({ mode: 'new_tab' as const, page: p }))
    .catch(() => null)
  const sameTabPromise: Promise<ResolvedNav> = page
    .waitForURL(/checkout\.stripe\.com/i, { timeout: timeoutMs })
    .then(() => ({ mode: 'same_tab' as const }))
    .catch(() => null)

  try {
    const target = page.locator(chosenSelector).first()
    await target.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {})
    // Re-verify dismissal right before the click — the banner can re-flash
    // if the SPA re-mounts it on route change.
    await dismissAwsCookieBanner(page, log)
    await target.click({ timeout: 5000 })
  } catch (e) {
    return {
      success: false,
      reason: 'button_not_found',
      detail: e instanceof Error ? e.message : String(e)
    }
  }

  const winner = await Promise.race([
    newPagePromise.then((r) => (r ? r : null)),
    sameTabPromise.then((r) => (r ? r : null)),
    // Hard fallback so neither-fires returns instead of hanging.
    new Promise<null>((r) => setTimeout(() => r(null), timeoutMs + 1000))
  ])

  if (winner?.mode === 'new_tab') {
    const newPage = winner.page
    try {
      await newPage.waitForLoadState('domcontentloaded', { timeout: 30000 })
    } catch {}
    const host = (() => {
      try {
        return new URL(newPage.url()).hostname
      } catch {
        return ''
      }
    })()
    if (host.endsWith('checkout.stripe.com')) {
      log(`[upgrade-click] resolved to new tab at ${host}`)
      return { success: true, mode: 'new_tab', page: newPage, url: newPage.url() }
    }
    // New tab opened but not on Stripe — maybe an interstitial. Give it a moment.
    try {
      await newPage.waitForURL(/checkout\.stripe\.com/i, { timeout: 15000 })
      return {
        success: true,
        mode: 'new_tab',
        page: newPage,
        url: newPage.url()
      }
    } catch {
      return {
        success: false,
        reason: 'wrong_host',
        detail: `new tab landed on ${newPage.url()}`
      }
    }
  }

  if (winner?.mode === 'same_tab') {
    log(`[upgrade-click] resolved in same tab at ${page.url()}`)
    return { success: true, mode: 'same_tab', page, url: page.url() }
  }

  return {
    success: false,
    reason: 'no_navigation',
    detail: `still on ${page.url()}`
  }
}
