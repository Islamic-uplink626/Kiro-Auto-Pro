import { execSync } from 'node:child_process'
import { createInterface } from 'node:readline'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { mkdir, writeFile } from 'node:fs/promises'
import { BinAggregator, DEFAULT_SOURCE_PRIORITY, type BinSourceName } from '../lib/bin/aggregator'
import { generateCards, generateFromBinInfo } from '../lib/bin/generator'
import { applyFilter, mergeBinInfo, type BinFilter, type BinInfo } from '../lib/bin/types'
import { appendVccFile, generatedToVcc, type BillingTemplate } from '../lib/bin/to-vcc'

/**
 * Default VCC pool path that the upgrade flow consumes.
 * `cmdGenerate` writes here automatically unless the user passes
 * --append <path>, --out <path>, or --no-save.
 */
const DEFAULT_VCC_POOL_PATH = 'accounts/vcc.json'

if (process.platform === 'win32') {
  try {
    const stdout = execSync('chcp', { encoding: 'utf8' })
    if (!stdout.includes('65001')) execSync('chcp 65001 >nul 2>&1')
  } catch {}
}

process.stdin.setEncoding?.('utf8')
process.stdout.setDefaultEncoding?.('utf8')
process.stderr.setDefaultEncoding?.('utf8')

const COLORS = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m'
}
function print(s: string) {
  process.stdout.write(s + '\n')
}
function log(c: keyof typeof COLORS, s: string) {
  print(`${COLORS[c]}${s}${COLORS.reset}`)
}

type Subcommand = 'lookup' | 'search' | 'cascade' | 'generate' | 'refresh-db' | 'menu' | 'help'

type CliFlags = {
  cmd?: Subcommand
  bin?: string
  country?: string
  scheme?: string
  type?: string
  bank?: string
  brand?: string
  search?: string
  prepaid?: boolean
  limit?: number
  count?: number
  length?: number
  expMonth?: number
  expYear?: number
  out?: string
  appendVccPath?: string
  billingFile?: string
  noSave?: boolean
  enableScrapers?: boolean
  proxy?: string
  cachePath?: string
  localDbPath?: string
  sources?: BinSourceName[]
  json?: boolean
  yes?: boolean
}

function toInt(s: string | undefined, fallback: number): number {
  if (!s) return fallback
  const n = Number.parseInt(s, 10)
  return Number.isFinite(n) ? n : fallback
}

/**
 * argv tokenizer that survives npm's flag-eating on Windows.
 *
 * `npm run bin -- --country Indonesia` is supposed to forward everything
 * after `--` to the script, but npm.cmd on Windows (and some PowerShell
 * profiles) strip unrecognized `--<long-flag>` tokens and pass only the
 * raw values, leaving the script with `cascade Indonesia VISA` instead of
 * `cascade --country Indonesia --scheme VISA`.
 *
 * To survive every shell quirk we accept three forms simultaneously:
 *
 *   1. --key=value          (npm may convert this to npm_config_key)
 *   2. --key value          (survives when shell forwards --foo cleanly)
 *   3. positional arguments (the Windows-degraded fallback; mapped per
 *      subcommand by the caller via `positionalSpecs[<cmd>]`)
 *
 * Tokens are split into:
 *   - flags: { '--key': 'value' | true }
 *   - positionals: string[]
 *
 * Booleans (no value) like `--json` are preserved as `true`.
 */
type ParsedTokens = {
  flags: Record<string, string | boolean>
  positionals: string[]
}

const BOOLEAN_FLAGS = new Set([
  '--prepaid',
  '--no-prepaid',
  '--enable-scrapers',
  '--no-save',
  '--json',
  '--yes',
  '-y',
  '--non-interactive',
  '--headed',
  '--headless'
])

function tokenize(argv: string[]): ParsedTokens {
  const flags: Record<string, string | boolean> = {}
  const positionals: string[] = []
  let i = 0
  while (i < argv.length) {
    const tok = argv[i]
    if (tok === '--') {
      // Everything after a bare `--` is forced positional.
      positionals.push(...argv.slice(i + 1))
      break
    }
    if (tok.startsWith('--') || /^-[a-zA-Z]$/.test(tok)) {
      const eq = tok.indexOf('=')
      if (eq > 0) {
        flags[tok.slice(0, eq)] = tok.slice(eq + 1)
        i++
        continue
      }
      if (BOOLEAN_FLAGS.has(tok)) {
        flags[tok] = true
        i++
        continue
      }
      const next = argv[i + 1]
      // If next is missing OR another flag, treat this as a boolean.
      if (next === undefined || next.startsWith('--') || /^-[a-zA-Z]$/.test(next)) {
        flags[tok] = true
        i++
        continue
      }
      flags[tok] = next
      i += 2
      continue
    }
    positionals.push(tok)
    i++
  }
  return { flags, positionals }
}

function pickFlag(
  flags: Record<string, string | boolean>,
  names: string[]
): string | undefined {
  for (const n of names) {
    const v = flags[n]
    if (typeof v === 'string') return v
  }
  return undefined
}

function npmConfigValue(names: string[]): string | undefined {
  for (const name of names) {
    if (!name.startsWith('--')) continue
    const key = `npm_config_${name.slice(2).replace(/-/g, '_').toLowerCase()}`
    const value = process.env[key] ?? process.env[key.toUpperCase()]
    if (value !== undefined && value !== '') return value
  }
  return undefined
}

function npmConfigStringValue(names: string[]): string | undefined {
  const value = npmConfigValue(names)
  if (value === undefined || /^(?:true|false)$/i.test(value)) return undefined
  return value
}

function pickBool(
  flags: Record<string, string | boolean>,
  names: string[],
  allowNpmConfig = true
): boolean {
  for (const n of names) if (flags[n] === true) return true
  if (!allowNpmConfig) return false
  const value = npmConfigValue(names)
  if (value === undefined) return false
  return !/^(?:0|false|no|off)$/i.test(value)
}

/**
 * Per-subcommand positional schemas. Used when npm has stripped flag
 * names: e.g. `cascade Indonesia VISA "BANK CENTRAL ASIA"` is read as
 * `--country=Indonesia --scheme=VISA --bank="BANK CENTRAL ASIA"`.
 *
 * The mapping is intentionally narrow — each subcommand declares only
 * the fields a user might reasonably pass positionally, in the order
 * the equivalent `--key value` CLI accepts them. Anything past the
 * schema length is concatenated back into the LAST string-typed slot
 * so multi-word values like `BANK CENTRAL ASIA` survive even when
 * PowerShell splits them across argv tokens. The final slot is NOT
 * absorbed when it is a known integer-like field (e.g. `count`,
 * `limit`) so trailing path arguments do not get joined into numbers.
 */
const POSITIONAL_SPECS: Record<string, string[]> = {
  lookup: ['bin'],
  search: ['country', 'scheme', 'type', 'bank', 'limit'],
  cascade: ['country', 'scheme', 'bank'],
  generate: ['bin', 'count', 'billing', 'append'],
  'refresh-db': []
}

/** Slots that should never absorb trailing tokens — they have a fixed
 *  scalar type (integer / file path) and joining extra tokens would
 *  corrupt the value. */
const NON_ABSORBING_SLOTS = new Set(['limit', 'count', 'billing', 'append', 'bin'])

function applyPositionals(
  cmd: string | undefined,
  positionals: string[],
  out: Record<string, string>
): void {
  if (!cmd) return
  const spec = POSITIONAL_SPECS[cmd]
  if (!spec || spec.length === 0) return

  const slots = spec.filter((slot) => !out[slot])
  if (slots.length === 0 || positionals.length === 0) return

  const overflow = Math.max(0, positionals.length - slots.length)
  let absorbIdx = -1
  if (overflow > 0) {
    for (let idx = slots.length - 1; idx >= 0; idx--) {
      if (!NON_ABSORBING_SLOTS.has(slots[idx])) {
        absorbIdx = idx
        break
      }
    }
  }

  let tokenIdx = 0
  for (let idx = 0; idx < slots.length && tokenIdx < positionals.length; idx++) {
    const key = slots[idx]

    if (idx === absorbIdx) {
      out[key] = positionals.slice(tokenIdx, tokenIdx + overflow + 1).join(' ')
      tokenIdx += overflow + 1
    } else {
      out[key] = positionals[tokenIdx]
      tokenIdx += 1
    }
  }
}

export function parseCli(argv: string[]): CliFlags {
  const normalizedArgv = argv[0] === '--' ? argv.slice(1) : argv
  const sub = normalizedArgv[0] as Subcommand | undefined
  const known: Subcommand[] = [
    'lookup',
    'search',
    'cascade',
    'generate',
    'refresh-db',
    'menu',
    'help'
  ]
  const cmd = sub && known.includes(sub) ? sub : undefined
  // Strip the subcommand from the rest before tokenizing.
  const rest = cmd ? normalizedArgv.slice(1) : normalizedArgv
  const { flags, positionals } = tokenize(rest)

  // Build a normalized string-bag the rest of parseCli reads from.
  const s: Record<string, string> = {}
  const setStr = (key: string, names: string[], allowNpmConfig = true) => {
    const v = pickFlag(flags, names) ?? (allowNpmConfig ? npmConfigStringValue(names) : undefined)
    if (v !== undefined) s[key] = v
  }
  setStr('bin', ['--bin', '-b'])
  setStr('country', ['--country', '-C'])
  setStr('scheme', ['--scheme', '--brand', '-s'])
  setStr('type', ['--type', '-t'])
  setStr('bank', ['--bank'])
  setStr('cardBrand', ['--card-brand'])
  setStr('search', ['--search', '-q'])
  setStr('limit', ['--limit'])
  setStr('count', ['--count', '-n'])
  setStr('length', ['--length'])
  setStr('expMonth', ['--expMonth', '--exp-month'])
  setStr('expYear', ['--expYear', '--exp-year'])
  setStr('out', ['--out', '-o'])
  setStr('append', ['--append'])
  setStr('billing', ['--billing'])
  setStr('proxy', ['--proxy'], false)
  setStr('cachePath', ['--cache'], false)
  setStr('localDb', ['--local-db'])
  setStr('sources', ['--sources'])

  // Fill remaining slots from positional args using per-cmd schema.
  applyPositionals(cmd, positionals, s)

  const f: CliFlags = { cmd }
  f.bin = s.bin
  f.country = s.country
  f.scheme = s.scheme
  f.type = s.type
  f.bank = s.bank
  f.brand = s.cardBrand
  f.search = s.search

  if (pickBool(flags, ['--prepaid'])) f.prepaid = true
  if (pickBool(flags, ['--no-prepaid'])) f.prepaid = false

  if (s.limit) f.limit = toInt(s.limit, 50) || undefined
  if (s.count) f.count = toInt(s.count, 5)
  if (s.length) f.length = toInt(s.length, 16)
  if (s.expMonth) f.expMonth = toInt(s.expMonth, 0) || undefined
  if (s.expYear) f.expYear = toInt(s.expYear, 0) || undefined

  f.out = s.out
  f.appendVccPath = s.append
  f.billingFile = s.billing
  if (pickBool(flags, ['--enable-scrapers'])) f.enableScrapers = true
  if (pickBool(flags, ['--no-save'])) f.noSave = true
  f.proxy = s.proxy
  f.cachePath = s.cachePath
  f.localDbPath = s.localDb
  if (s.sources) {
    const parts = s.sources
      .split(/[,\s]+/)
      .map((x) => x.trim())
      .filter(Boolean) as BinSourceName[]
    f.sources = parts.filter((p) => DEFAULT_SOURCE_PRIORITY.includes(p))
  }
  if (pickBool(flags, ['--json'])) f.json = true
  if (pickBool(flags, ['--yes', '-y', '--non-interactive'])) f.yes = true

  return f
}

function aggregatorOptions(f: CliFlags) {
  return {
    cachePath: f.cachePath,
    localDbPath: f.localDbPath,
    enableScrapers: f.enableScrapers,
    proxyUrl: f.proxy,
    sources: f.sources,
    log: (m: string) => log('dim', m)
  }
}

async function readBillingTemplate(path: string): Promise<BillingTemplate> {
  const raw = await import('node:fs/promises').then((m) => m.readFile(resolve(path), 'utf-8'))
  const parsed = JSON.parse(raw)
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`billing template ${path}: not an object`)
  }
  return parsed as BillingTemplate
}

function fmtRow(row: BinInfo): string {
  const parts = [
    `${COLORS.cyan}${row.bin}${COLORS.reset}`,
    row.scheme ?? '?',
    row.type ?? '?',
    row.country?.alpha2 ?? row.country?.name ?? '?',
    row.bank?.name ?? '?',
    `[${row.source}]`
  ]
  return parts.join('  ')
}

async function cmdLookup(f: CliFlags): Promise<number> {
  if (!f.bin) {
    log('red', 'lookup needs --bin <digits>')
    return 1
  }
  const agg = await BinAggregator.open(aggregatorOptions(f))
  try {
    const r = await agg.lookup(f.bin)
    if (f.json) {
      print(JSON.stringify(r, null, 2))
      return r.merged ? 0 : 2
    }
    print('')
    if (!r.merged) {
      log('yellow', `No data for BIN ${r.bin}.`)
    } else {
      log('bright', `BIN ${r.bin}`)
      print(`  scheme  : ${r.merged.scheme ?? '-'}`)
      print(`  type    : ${r.merged.type ?? '-'}`)
      print(`  brand   : ${r.merged.brand ?? '-'}`)
      print(`  prepaid : ${r.merged.prepaid ?? '-'}`)
      print(`  length  : ${r.merged.length ?? '-'}`)
      print(`  luhn    : ${r.merged.luhn ?? '-'}`)
      const c = r.merged.country ?? {}
      print(
        `  country : ${c.name ?? '-'} (${c.alpha2 ?? '-'} / ${c.alpha3 ?? '-'})  currency=${
          c.currency ?? '-'
        }`
      )
      const b = r.merged.bank ?? {}
      print(`  bank    : ${b.name ?? '-'}`)
      print(`  url     : ${b.url ?? '-'}`)
      print(`  phone   : ${b.phone ?? '-'}`)
      print(`  source  : ${r.merged.source}`)
    }
    print('')
    log('dim', 'sources:')
    for (const o of r.outcomes) {
      const status = o.ok ? `${COLORS.green}ok${COLORS.reset}` : `${COLORS.red}${o.reason}${COLORS.reset}`
      print(`  ${o.source.padEnd(20)} ${status}  (${o.durationMs}ms)`)
    }
    return r.merged ? 0 : 2
  } finally {
    await agg.close()
  }
}

async function cmdSearch(f: CliFlags): Promise<number> {
  const filter: BinFilter & { search?: string; limit?: number } = {
    country: f.country,
    scheme: f.scheme,
    type: f.type,
    bank: f.bank,
    brand: f.brand,
    prepaid: f.prepaid,
    search: f.search ?? f.bin,
    limit: f.limit ?? 50
  }
  const agg = await BinAggregator.open(aggregatorOptions(f))
  try {
    const rows = await agg.findByFilter(filter)
    if (f.json) {
      print(JSON.stringify(rows, null, 2))
      return rows.length > 0 ? 0 : 2
    }
    if (rows.length === 0) {
      log('yellow', 'No matching BINs.')
      return 2
    }
    log('bright', `Found ${rows.length} BIN(s)`)
    for (const r of rows) print('  ' + fmtRow(r))
    return 0
  } finally {
    await agg.close()
  }
}

async function cmdCascade(f: CliFlags): Promise<number> {
  const country = f.country
  if (!country) {
    log('red', 'cascade needs --country "<Country Display Name>"')
    return 1
  }
  const agg = await BinAggregator.open(aggregatorOptions(f))
  try {
    const r = await agg.cascadeVccGenerator({
      country,
      brand: f.scheme,
      bank: f.bank
    })
    if (f.json) {
      print(JSON.stringify(r, null, 2))
      return 0
    }
    if (r.brands) {
      log('bright', `Brands available in ${country} (${r.brands.length})`)
      for (const b of r.brands) print('  ' + b)
    }
    if (r.banks) {
      log('bright', `Banks for ${country} / ${f.scheme} (${r.banks.length})`)
      for (const b of r.banks) print('  ' + b)
    }
    if (r.bins) {
      log('bright', `BINs for ${country} / ${f.scheme} / ${f.bank} (${r.bins.length})`)
      for (const b of r.bins) print('  ' + b)
    }
    return 0
  } finally {
    await agg.close()
  }
}

async function cmdGenerate(f: CliFlags): Promise<number> {
  if (!f.bin) {
    log('red', 'generate needs --bin <digits>')
    return 1
  }
  const count = Math.max(1, f.count ?? 5)
  const agg = await BinAggregator.open(aggregatorOptions(f))
  let info: BinInfo | null = null
  try {
    const r = await agg.lookup(f.bin)
    info = r.merged
  } finally {
    await agg.close()
  }

  let cards
  if (info) {
    cards = generateFromBinInfo(info, count, {
      length: f.length,
      expMonth: f.expMonth,
      expYear: f.expYear,
      scheme: f.scheme ?? info.scheme
    })
  } else {
    cards = generateCards({
      bin: f.bin,
      count,
      length: f.length,
      scheme: f.scheme,
      expMonth: f.expMonth,
      expYear: f.expYear
    })
  }

  // Default-on auto persistence:
  //   - explicit --no-save:  print only (machine-friendly, no side effects)
  //   - explicit --out PATH: write to fresh file
  //   - everything else:     append to accounts/vcc.json (the pool the
  //                          upgrade flow consumes). Billing is faked
  //                          per-card from the BIN's issuer country
  //                          unless --billing <path> is supplied.
  const saveDisabled = f.noSave === true
  const appendPath = saveDisabled
    ? undefined
    : (f.appendVccPath ?? (f.out ? undefined : DEFAULT_VCC_POOL_PATH))
  const writeFreshPath = saveDisabled ? undefined : f.out

  let sharedBilling: BillingTemplate | undefined
  if (f.billingFile) {
    sharedBilling = await readBillingTemplate(f.billingFile)
  }
  const entries = generatedToVcc(
    cards,
    { billing: sharedBilling },
    info ?? undefined
  )

  if (appendPath) {
    const appended = await appendVccFile(appendPath, entries)
    log(
      'green',
      `Appended ${appended}/${entries.length} entries to ${resolve(appendPath)}`
    )
    if (appended < entries.length) {
      log(
        'dim',
        `  ${entries.length - appended} skipped (duplicate id or PAN+expiry already in pool)`
      )
    }
  }
  if (writeFreshPath) {
    const abs = resolve(writeFreshPath)
    await mkdir(resolve(abs, '..'), { recursive: true })
    await writeFile(abs, JSON.stringify(entries, null, 2), 'utf-8')
    log('green', `Wrote ${entries.length} entries to ${abs}`)
  }

  if (f.json) {
    print(JSON.stringify(entries, null, 2))
    return 0
  }

  // Human-readable summary so the user sees what was written.
  log('bright', `Generated ${cards.length} card(s) from BIN ${f.bin}`)
  if (info?.bank?.name || info?.country?.name) {
    log(
      'dim',
      `  source: ${info.bank?.name ?? '-'} / ${info.country?.name ?? info.country?.alpha2 ?? '-'} / ${
        info.scheme ?? '-'
      }`
    )
  }
  for (const e of entries) {
    const exp = `${String(e.expMonth).padStart(2, '0')}/${String(e.expYear).slice(-2)}`
    print(
      `  ${e.number}  exp=${exp}  cvc=${e.cvc}  ${e.brand ?? '?'}  ` +
        `${e.billing.name}  ${e.billing.country}`
    )
  }
  if (saveDisabled) {
    log('dim', '— --no-save set; cards printed only.')
  } else if (!appendPath && !writeFreshPath) {
    log('dim', '— nothing saved (no append / out path resolved).')
  }
  return 0
}

async function cmdRefreshDb(f: CliFlags): Promise<number> {
  const { LocalBinSource } = await import('../lib/bin/sources/local-db')
  const src = new LocalBinSource({
    path: f.localDbPath,
    autoBootstrap: true,
    log: (m) => log('dim', m)
  })
  await src.load()
  log('green', `local-db loaded: ${src.size()} unique BIN entries`)
  return 0
}

async function interactiveMenu(initial: CliFlags): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const ask = (q: string): Promise<string> => new Promise((r) => rl.question(q, r))
  const askD = async (q: string, def: string): Promise<string> => {
    const a = await ask(`${q} [${def}]: `)
    return a.trim() || def
  }
  let f: CliFlags = { ...initial }

  const banner = () => {
    print('')
    log('bright', '╔══════════════════════════════════════════════════════════╗')
    log('bright', '║  Kiro Auto — BIN Search / Finder / Generator             ║')
    log('bright', '║  binlist + handyapi + bincheck + vccgen + bincodes + db  ║')
    log('bright', '╚══════════════════════════════════════════════════════════╝')
  }

  let running = true
  while (running) {
    banner()
    print('')
    log(
      'dim',
      `cache: ${f.cachePath ?? 'show/bin-cache.json'}  local-db: ${f.localDbPath ?? 'accounts/bin-database.json'}`
    )
    log(
      'dim',
      `sources: ${(f.sources ?? DEFAULT_SOURCE_PRIORITY).join(',')}  scrapers: ${
        f.enableScrapers ? 'ON' : 'off'
      }  proxy: ${f.proxy ?? '(none)'}`
    )
    print('')
    log('cyan', '[1] Lookup BIN (multi-source)')
    log('cyan', '[2] Search BINs by filter (country / scheme / type / bank)')
    log('cyan', '[3] Cascade browse (country → brand → bank → BINs)')
    log('cyan', '[4] Generate cards from BIN (Luhn-valid PANs)')
    log('cyan', '[5] Refresh local BIN database')
    log('cyan', '[s] Toggle scraper sources (browser-based)')
    log('cyan', '[p] Set proxy')
    log('cyan', '[c] Set cache path')
    log('cyan', '[d] Set local-db path')
    log('cyan', '[r] Restrict source list')
    log('cyan', '[0] Quit')
    print('')

    const cmd = (await ask(COLORS.green + '> ' + COLORS.reset)).trim().toLowerCase()
    switch (cmd) {
      case '1': {
        f.bin = await askD('BIN (6–8 digits)', f.bin ?? '')
        await cmdLookup(f)
        break
      }
      case '2': {
        f.country = (await askD('country alpha-2 (us,id,…) or empty', f.country ?? '')) || undefined
        f.scheme = (await askD('scheme (visa, mastercard, …) or empty', f.scheme ?? '')) || undefined
        f.type = (await askD('type (credit/debit/prepaid) or empty', f.type ?? '')) || undefined
        f.bank = (await askD('bank substring or empty', f.bank ?? '')) || undefined
        f.search = (await askD('free-text search or empty', f.search ?? '')) || undefined
        const lim = await askD('limit', String(f.limit ?? 50))
        f.limit = toInt(lim, 50)
        await cmdSearch(f)
        break
      }
      case '3': {
        f.country = await askD('country display name (e.g. United States)', f.country ?? '')
        f.scheme = (await askD('brand or empty', f.scheme ?? '')) || undefined
        f.bank = (await askD('bank or empty', f.bank ?? '')) || undefined
        await cmdCascade(f)
        break
      }
      case '4': {
        f.bin = await askD('BIN (6–8 digits)', f.bin ?? '')
        const ct = await askD('count', String(f.count ?? 5))
        f.count = toInt(ct, 5)
        const ln = await askD('length (auto if empty)', f.length ? String(f.length) : '')
        if (ln) f.length = toInt(ln, 16)
        const em = await askD('expMonth (1–12, blank=random)', f.expMonth ? String(f.expMonth) : '')
        const ey = await askD('expYear (4-digit, blank=random)', f.expYear ? String(f.expYear) : '')
        f.expMonth = em ? toInt(em, 0) : undefined
        f.expYear = ey ? toInt(ey, 0) : undefined
        const append = await askD(
          'append to VCC pool path',
          f.appendVccPath ?? DEFAULT_VCC_POOL_PATH
        )
        f.appendVccPath = append || undefined
        const billing = await askD(
          'shared billing template path (blank = auto-fake per card)',
          f.billingFile ?? ''
        )
        f.billingFile = billing || undefined
        await cmdGenerate(f)
        break
      }
      case '5':
        await cmdRefreshDb(f)
        break
      case 's':
        f.enableScrapers = !f.enableScrapers
        break
      case 'p': {
        const p = await ask(`proxy URL [${f.proxy ?? ''}]: `)
        f.proxy = p.trim() ? p.trim() : undefined
        break
      }
      case 'c':
        f.cachePath = (await askD('cache path', f.cachePath ?? 'show/bin-cache.json')) || undefined
        break
      case 'd':
        f.localDbPath =
          (await askD('local-db path', f.localDbPath ?? 'accounts/bin-database.json')) || undefined
        break
      case 'r': {
        const csv = await askD(
          'sources CSV (cache,local-db,binlist,handyapi,bincheck,bincheck-details,vccgenerator,bincodes)',
          (f.sources ?? DEFAULT_SOURCE_PRIORITY).join(',')
        )
        const list = csv
          .split(/[,\s]+/)
          .map((s) => s.trim())
          .filter(Boolean) as BinSourceName[]
        f.sources = list.filter((p) => DEFAULT_SOURCE_PRIORITY.includes(p))
        break
      }
      case '0':
      case 'q':
      case 'quit':
      case 'exit':
        running = false
        log('green', 'bye')
        break
      default:
        log('yellow', `unknown: ${cmd}`)
    }
  }
  rl.close()
}

function printHelp(): void {
  print('')
  log('bright', 'kiro-auto BIN tool')
  print('')
  print('Usage:')
  print('  npm run bin                                 # interactive menu')
  print('  npm run bin -- lookup --bin 418832          # multi-source lookup')
  print('  npm run bin -- search --country US --scheme visa --type credit --limit 25')
  print('  npm run bin -- cascade --country "United States" --scheme VISA --bank "1ST SOURCE BANK"')
  print('  npm run bin -- generate --bin 447242 --count 10                    # auto-saves to accounts/vcc.json with fake billing')
  print('  npm run bin -- generate --bin 447242 --count 5 --billing accounts/billing.json')
  print('  npm run bin -- generate --bin 447242 --count 5 --out accounts/vcc-batch.json')
  print('  npm run bin -- generate --bin 447242 --count 5 --no-save           # print only, do not write the pool')
  print('  npm run bin -- refresh-db')
  print('')
  print('Argument forms (any of these works on every shell):')
  print('  --key value     ← when shell forwards correctly')
  print('  --key=value     ← recovered from npm_config_* when npm strips it')
  print('  positional      ← per-subcommand fallback when npm strips flag names')
  print('                    cascade  <country> [scheme] [bank]')
  print('                    search   <country> [scheme] [type] [bank] [limit]')
  print('                    lookup   <bin>')
  print('                    generate <bin> [count] [billing] [append]')
  print('')
  print('Common flags:')
  print('  --json                emit machine-readable JSON')
  print('  --enable-scrapers     allow heavy browser-based sources (bincodes)')
  print('  --proxy <url>         outbound HTTP/SOCKS proxy')
  print('  --sources a,b,c       restrict source priority (cache,local-db,binlist,handyapi,bincheck,bincheck-details,vccgenerator,bincodes)')
  print('  --cache <path>        cache file (default show/bin-cache.json)')
  print('  --local-db <path>     local BIN dataset (default accounts/bin-database.json)')
  print('')
}

async function main() {
  const argv = process.argv.slice(2)
  if (argv.length === 0) {
    await interactiveMenu({})
    return
  }
  const f = parseCli(argv)
  switch (f.cmd) {
    case 'lookup':
      process.exitCode = await cmdLookup(f)
      break
    case 'search':
      process.exitCode = await cmdSearch(f)
      break
    case 'cascade':
      process.exitCode = await cmdCascade(f)
      break
    case 'generate':
      process.exitCode = await cmdGenerate(f)
      break
    case 'refresh-db':
      process.exitCode = await cmdRefreshDb(f)
      break
    case 'menu':
      await interactiveMenu(f)
      break
    case 'help':
    case undefined:
    default:
      printHelp()
      process.exitCode = f.cmd ? 0 : 1
  }
}

const isDirectRun =
  !!process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href

if (isDirectRun) {
  main().catch((e) => {
    process.stderr.write(`fatal: ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`)
    process.exitCode = 1
  })
}
