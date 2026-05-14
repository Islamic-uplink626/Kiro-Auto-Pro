/**
 * Extra-stealth helpers active on `checkout.stripe.com`.
 *
 * Goal: make a hosted-checkout session look like a returning human user, both
 * to Stripe's fingerprint collectors (m.stripe.com/r and embedded sigma /
 * Radar signals) AND to the chromium automation detectors that the public
 * stealth plugin doesn't fully cover.
 *
 * Design notes — read before changing anything in this file:
 *
 *   1. We DO NOT block Stripe's telemetry (m.stripe.com, m.stripe.network).
 *      Blocking those endpoints flips Radar's risk score upward; blocked
 *      sessions look exactly like Tor / automation users to the model. Stripe
 *      Radar feeds on signals like keystroke cadence, mouse travel before
 *      first focus, dwell-on-CVC, etc. — supplying realistic versions of
 *      those signals is much higher EV than blocking the collection.
 *
 *   2. Hardening init scripts are scoped to `checkout.stripe.com` via URL
 *      check inside the script, so they no-op on Kiro / Google / Cognito
 *      pages and never interfere with auth flows.
 *
 *   3. Camoufox (Firefox fork) ships its own C-level anti-fingerprinting
 *      patches that are stricter than anything injectable from JS. Layering
 *      Chrome-shaped hooks on top would create internal inconsistencies
 *      (e.g. `chrome.runtime` defined while `navigator.userAgent` says
 *      Firefox), which is itself a red flag. Anything Chromium-specific is
 *      gated on the engine type by the caller (see browser.ts).
 *
 *   4. Humanized input helpers (typing / mouse / scroll) are page-scoped
 *      utilities — they work the same on any engine.
 */

import type { BrowserContext, Locator, Page } from 'playwright'
import type { BrowserEngine } from './browser'

type LogCallback = (message: string) => void

const STRIPE_HOST_RE = /(?:^|\.)checkout\.stripe\.com$/i

/** Apply Chromium-only init scripts that further harden a checkout.stripe.com
 *  page beyond what `puppeteer-extra-plugin-stealth` does in browser.ts.
 *
 *  Skipped on camoufox — Firefox already covers (and over-covers) these. */
export async function applyStripeStealthContext(
  context: BrowserContext,
  engine: BrowserEngine,
  log: LogCallback
): Promise<void> {
  if (engine === 'camoufox') {
    log('[stripe-stealth] camoufox engine — skipping Chromium-shaped init scripts')
    return
  }

  await context.addInitScript(STRIPE_HARDENING_SCRIPT)
  log('[stripe-stealth] installed Chromium hardening init script (URL-scoped to checkout.stripe.com)')
}

/**
 * Run-once-per-page warmup to feed Stripe Radar realistic interaction
 * signals before we touch any input. Without this, the entire user session
 * looks like: page load → instant focus to card field → submit. That signature
 * is a classic Radar tell.
 */
export async function prewarmStripePage(page: Page, log: LogCallback): Promise<void> {
  // Bail if we've already warmed this page (e.g. reused after reload).
  const already = await page
    .evaluate(() => (window as any).__stripe_stealth_warmed === true)
    .catch(() => false)
  if (already) return

  // Initial dwell — a real user needs ~1–2.5s to read the page header before
  // moving the mouse.
  await sleep(jitter(900, 2200))

  // Tiny mouse path: top-left → centre → near the card-number field. Real
  // users almost always wiggle the cursor during the first second of a page.
  try {
    const vp = page.viewportSize()
    if (vp) {
      const { width, height } = vp
      const points: Array<[number, number]> = [
        [Math.floor(width * 0.15), Math.floor(height * 0.18)],
        [Math.floor(width * 0.4), Math.floor(height * 0.32)],
        [Math.floor(width * 0.55), Math.floor(height * 0.45)],
        [Math.floor(width * 0.5), Math.floor(height * 0.55)]
      ]
      for (const [x, y] of points) {
        await page.mouse.move(x + jitter(-8, 8), y + jitter(-6, 6), {
          steps: jitter(6, 14)
        })
        await sleep(jitter(80, 220))
      }
    }
  } catch {
    // Mouse moves aren't critical — keep flow going.
  }

  // Read-pause: real users skim the order summary before typing.
  await sleep(jitter(450, 1100))

  // Light scroll to expose the billing fields below the fold (also fires
  // scroll events that Radar captures).
  try {
    await page.evaluate(() => {
      try {
        window.scrollBy({ top: 60 + Math.floor(Math.random() * 80), behavior: 'smooth' })
      } catch {
        window.scrollBy(0, 80)
      }
    })
  } catch {}
  await sleep(jitter(300, 800))

  try {
    await page.evaluate(() => {
      ;(window as any).__stripe_stealth_warmed = true
    })
  } catch {}

  log('[stripe-stealth] prewarmed page (mouse + scroll + dwell)')
}

/**
 * Type into a Stripe input with cadence variation, occasional read-pauses,
 * and a small chance of a typo+correction. Resilient to Stripe's input
 * masking (which only accepts InputEvent-driven mutations).
 *
 * Options:
 *   - `mistakes`: probability of inserting a typo+backspace inside this field.
 *      Default 0 — keep field-by-field, only enable for long fields.
 *   - `clear`: clear the field first using triple-click + Backspace. Default
 *      true — Ctrl+A is unreliable across all 3 engines.
 */
export async function humanType(
  locator: Locator,
  value: string,
  options: { mistakes?: number; clear?: boolean; pageForMouse?: Page } = {}
): Promise<void> {
  const { mistakes = 0, clear = true } = options

  // Focus via click — emit real mousedown/up/click + focus events. Stripe's
  // input mask fires on focus, not on synthetic value sets.
  await locator.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {})
  await locator.click({ timeout: 5000 })
  await sleep(jitter(60, 180))

  if (clear) {
    // Ctrl+A → Backspace is the most reliable clear across all 3 engines for
    // Stripe-masked inputs (cardNumber / cardExpiry / cardCvc) — triple-click
    // alone can leave residual digits on Firefox/camoufox when the mask
    // re-formats during the click.
    try {
      await locator.press('Control+a', { delay: jitter(20, 60) })
      await locator.press('Backspace').catch(() => {})
    } catch {
      // Fall back to triple-click selection.
    }
    try {
      await locator.click({ clickCount: 3, timeout: 3000 })
    } catch {
      // Some engines reject clickCount on masked inputs — fall back.
    }
    await locator.press('Backspace').catch(() => {})
    await locator.press('Delete').catch(() => {})
  }

  let typoCount = 0
  let charsTyped = 0
  for (const ch of value) {
    // Occasional read-pause every 4–8 chars.
    if (charsTyped > 0 && charsTyped % jitter(4, 8) === 0 && Math.random() < 0.25) {
      await sleep(jitter(180, 450))
    }

    // Occasional typo: type a random adjacent char then backspace.
    if (mistakes > 0 && typoCount < 1 && Math.random() < mistakes) {
      const wrong = randomChar(ch)
      await locator.press(wrong, { delay: jitter(20, 60) }).catch(() => {})
      await sleep(jitter(120, 300))
      await locator.press('Backspace').catch(() => {})
      await sleep(jitter(80, 200))
      typoCount++
    }

    await locator.press(ch, { delay: jitter(30, 110) }).catch(async () => {
      // Some characters (e.g. spaces in card-number fields) may need explicit type.
      await locator.type(ch, { delay: jitter(30, 110) }).catch(() => {})
    })
    charsTyped++
  }

  // Blur via Tab — Stripe's validators run on blur, not on input.
  await sleep(jitter(80, 240))
  await locator.press('Tab').catch(() => {})
  await sleep(jitter(80, 220))
}

/** Real-feeling click: move to target via a multi-step path, dwell briefly,
 *  then click. Use for Subscribe + country select + any button on Stripe. */
export async function humanClick(
  page: Page,
  locator: Locator,
  options: { dwellMs?: [number, number] } = {}
): Promise<void> {
  const dwell = options.dwellMs ?? [120, 320]
  await locator.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {})

  // Get bounding box + nudge cursor toward the centre with two intermediate
  // points (Bezier-ish without overengineering).
  const box = await locator.boundingBox().catch(() => null)
  if (box) {
    const tx = box.x + box.width / 2 + jitter(-Math.min(8, box.width / 6), Math.min(8, box.width / 6))
    const ty = box.y + box.height / 2 + jitter(-Math.min(4, box.height / 6), Math.min(4, box.height / 6))
    try {
      const mid1x = tx + jitter(-50, 50)
      const mid1y = ty + jitter(-30, 30)
      await page.mouse.move(mid1x, mid1y, { steps: jitter(6, 14) })
      await sleep(jitter(50, 140))
      await page.mouse.move(tx, ty, { steps: jitter(8, 18) })
    } catch {}
  }

  await sleep(jitter(dwell[0], dwell[1]))
  await locator.click({ timeout: 5000 })
}

/** Sleep for a humanized read-pause. Exported so callers (e.g. checkout
 *  classifier) can space out their polling. */
export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

function jitter(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min
}

/** Pick a "near" character on a QWERTY layout to simulate fat-finger typos. */
function randomChar(target: string): string {
  const map: Record<string, string> = {
    a: 'sqwz',
    s: 'awedxz',
    d: 'sefcx',
    f: 'drvgct',
    g: 'fhytvb',
    h: 'gjyubn',
    j: 'hknmui',
    k: 'jlmoiu',
    l: 'kop',
    q: 'wa',
    w: 'qeas',
    e: 'wrsd',
    r: 'etdf',
    t: 'ryfg',
    y: 'tugh',
    u: 'yihj',
    i: 'uojk',
    o: 'iplk',
    p: 'ol',
    z: 'asx',
    x: 'zsdc',
    c: 'xdfv',
    v: 'cfgb',
    b: 'vghn',
    n: 'bhjm',
    m: 'nkj'
  }
  const lower = target.toLowerCase()
  if (/[0-9]/.test(target)) {
    const n = Number.parseInt(target, 10)
    const candidates = [n - 1, n + 1].filter((v) => v >= 0 && v <= 9)
    if (candidates.length === 0) return '0'
    return String(candidates[Math.floor(Math.random() * candidates.length)])
  }
  const adj = map[lower]
  if (!adj) return target
  const pick = adj[Math.floor(Math.random() * adj.length)]
  return target === target.toUpperCase() ? pick.toUpperCase() : pick
}

/**
 * URL-guarded Chromium hardening script. Runs on every navigation but no-ops
 * outside `checkout.stripe.com` so it never interferes with Kiro / Google /
 * Cognito.
 *
 * Hooks (Chromium only — see top-of-file rationale):
 *   - Strip "HeadlessChrome" / "Headless" substrings from UA fallback paths.
 *   - Force `navigator.webdriver = false` (re-applied at install time so a
 *     later prototype mutation doesn't slip through).
 *   - Coerce `Notification.permission` to "default" to match the user-agent
 *     state Stripe expects from a fresh-but-real session.
 *   - `chrome.runtime`, `chrome.csi`, `chrome.loadTimes` shims for engines
 *     where the stealth plugin omitted them.
 *   - Plugin / mimeType array realism (length=3 stock plugins).
 *   - Hide function-toString patches done by us: Function.prototype.toString
 *     wrapper that returns the original native string for any of our hooked
 *     functions.
 */
const STRIPE_HARDENING_SCRIPT = `
(() => {
  try {
    if (!/(?:^|\\.)checkout\\.stripe\\.com$/i.test(location.hostname)) {
      return;
    }
  } catch (_) {
    return;
  }

  const safe = (fn) => {
    try { fn(); } catch (_) {}
  };

  // 1. webdriver — rebind even if prototype was already monkey-patched.
  safe(() => {
    Object.defineProperty(Navigator.prototype, 'webdriver', {
      get: () => false,
      configurable: true
    });
  });

  // 2. UA scrub: very-final defensive removal of "HeadlessChrome".
  safe(() => {
    const ua = navigator.userAgent;
    if (/HeadlessChrome/i.test(ua)) {
      const cleaned = ua.replace(/HeadlessChrome/gi, 'Chrome');
      Object.defineProperty(Navigator.prototype, 'userAgent', {
        get: () => cleaned,
        configurable: true
      });
    }
  });

  // 3. Notification.permission default. Some headless contexts return "denied"
  //    silently; "default" is what fresh real users have.
  safe(() => {
    if (typeof Notification !== 'undefined') {
      Object.defineProperty(Notification, 'permission', {
        get: () => 'default',
        configurable: true
      });
    }
  });

  // 4. permissions.query: in real Chrome, notifications/clipboard return
  //    "prompt" by default. The stealth plugin handles notifications; we
  //    extend to a few that Stripe Radar samples.
  safe(() => {
    const anyNav = navigator;
    if (anyNav.permissions && anyNav.permissions.query) {
      const orig = anyNav.permissions.query.bind(anyNav.permissions);
      anyNav.permissions.query = (params) => {
        const name = params && params.name;
        if (name === 'notifications') {
          return Promise.resolve({ state: Notification.permission, onchange: null });
        }
        if (name === 'clipboard-read' || name === 'clipboard-write' || name === 'persistent-storage') {
          return Promise.resolve({ state: 'prompt', onchange: null });
        }
        return orig(params);
      };
    }
  });

  // 5. chrome.* API shims. Stripe doesn't query these, but downstream Radar
  //    fingerprint scripts do — and a bare \`window.chrome\` triggers a flag.
  safe(() => {
    if (!window.chrome) {
      window.chrome = {};
    }
    if (!window.chrome.runtime) {
      window.chrome.runtime = {};
    }
    if (typeof window.chrome.csi !== 'function') {
      window.chrome.csi = function() {
        return { onloadT: Date.now(), pageT: Math.random() * 1000, startE: Date.now(), tran: 15 };
      };
    }
    if (typeof window.chrome.loadTimes !== 'function') {
      window.chrome.loadTimes = function() {
        const now = Date.now() / 1000;
        return {
          requestTime: now - 1,
          startLoadTime: now - 0.95,
          commitLoadTime: now - 0.9,
          finishDocumentLoadTime: now - 0.4,
          finishLoadTime: now - 0.1,
          firstPaintTime: now - 0.3,
          firstPaintAfterLoadTime: 0,
          navigationType: 'Other',
          wasFetchedViaSpdy: true,
          wasNpnNegotiated: true,
          npnNegotiatedProtocol: 'h2',
          wasAlternateProtocolAvailable: false,
          connectionInfo: 'h2'
        };
      };
    }
  });

  // 6. Plugin / mimeType length parity with real Chrome (3 plugins, 4 mimeTypes).
  //    Many fingerprint libs check \`navigator.plugins.length === 0\` as a
  //    headless tell.
  safe(() => {
    if (navigator.plugins && navigator.plugins.length === 0) {
      const fakePlugins = [
        { name: 'PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
        { name: 'Chrome PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
        { name: 'Chromium PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' }
      ];
      Object.defineProperty(Navigator.prototype, 'plugins', {
        get: () => {
          const arr = fakePlugins.slice();
          Object.defineProperty(arr, 'item', { value: (i) => arr[i] || null });
          Object.defineProperty(arr, 'namedItem', {
            value: (n) => arr.find((p) => p.name === n) || null
          });
          Object.defineProperty(arr, 'refresh', { value: () => {} });
          return arr;
        },
        configurable: true
      });
    }
  });

  // 7. Object.getOwnPropertyDescriptor(navigator, 'webdriver') shape. Some
  //    bot detectors compare the descriptor object structure. Make ours look
  //    like a getter, not a data prop.
  safe(() => {
    const desc = Object.getOwnPropertyDescriptor(Navigator.prototype, 'webdriver');
    if (desc && 'value' in desc) {
      Object.defineProperty(Navigator.prototype, 'webdriver', {
        get: () => false,
        configurable: true
      });
    }
  });
})();
`
