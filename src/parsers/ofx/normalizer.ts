/**
 * Convert a parsed OFX document into Extratus's canonical `ExtractionResult[]`, one per
 * statement (account / credit-card invoice). The point is to feed the same downstream pipeline
 * (`buildOfx`, `buildCsv`, dedup by fitId) regardless of whether the data came from a recipe's
 * REST scrape or from a file the user dropped in the popup.
 *
 * Why this re-normalize cycle exists: BR banks (Itaú, BB, Caixa, Mercado Pago) ship OFX with
 * inconsistent FITIDs, missing LEDGERBAL, weird charset declarations, and broken SGML closing
 * tags. Re-flowing through our normalizer + generator gives the user a single, predictable
 * OFX flavor that any importer accepts.
 */

import type { AccountInfo, AccountType, ExtractionResult, NormalizedTransaction } from '@/types/transaction'
import Decimal from 'decimal.js'
import type { OfxDocument, OfxNode } from './parser'

export interface NormalizeOfxOptions {
  /** Override the source label baked into `ExtractionResult.recipeSite`. Default `'ofx-upload'`. */
  source?: string
  /** Bumped when this normalizer's output shape changes. */
  sourceVersion?: number
  /**
   * Filename of the imported file (used as a fallback when STMTTRN.FITID is missing — we hash
   * `(filename, dtposted, trnamt, name, memo)` to stay deterministic between re-imports of the
   * same file).
   */
  filename?: string
}

export class OfxNormalizeError extends Error {}

/**
 * Walk the OFX tree and emit one `ExtractionResult` per statement found. A single OFX file can
 * contain checking + savings + credit-card statements; each becomes its own result so the
 * popup can let the user pick which to download.
 */
export function normalizeOfx(doc: OfxDocument, opts: NormalizeOfxOptions = {}): ExtractionResult[] {
  const source = opts.source ?? 'ofx-upload'
  const sourceVersion = opts.sourceVersion ?? 1
  const filename = opts.filename ?? ''

  const ofx = doc.OFX
  if (typeof ofx !== 'object') throw new OfxNormalizeError('OFX vazio ou malformado')

  const out: ExtractionResult[] = []
  const fi = pickFi(ofx)

  // Bank statements (BANKMSGSRSV1 → STMTTRNRS[] → STMTRS)
  const bankNodes = findStatements(ofx, 'BANKMSGSRSV1', 'STMTTRNRS', 'STMTRS')
  for (const stmt of bankNodes) {
    const result = bankStatementToResult(stmt, { source, sourceVersion, filename, fi })
    if (result) out.push(result)
  }

  // Credit card statements (CREDITCARDMSGSRSV1 → CCSTMTTRNRS[] → CCSTMTRS)
  const ccNodes = findStatements(ofx, 'CREDITCARDMSGSRSV1', 'CCSTMTTRNRS', 'CCSTMTRS')
  for (const stmt of ccNodes) {
    const result = ccStatementToResult(stmt, { source, sourceVersion, filename, fi })
    if (result) out.push(result)
  }

  if (out.length === 0) {
    throw new OfxNormalizeError(
      'Nenhum extrato encontrado no OFX (procurei BANKMSGSRSV1/STMTRS e CREDITCARDMSGSRSV1/CCSTMTRS)',
    )
  }
  return out
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

function findStatements(ofx: OfxNode, envelope: string, wrapper: string, leaf: string): OfxNode[] {
  if (typeof ofx !== 'object') return []
  const env = ofx[envelope]
  if (!env || typeof env !== 'object' || Array.isArray(env)) return []
  const wrappers = asArray((env as Record<string, OfxNode | OfxNode[]>)[wrapper])
  const out: OfxNode[] = []
  for (const w of wrappers) {
    if (typeof w !== 'object' || Array.isArray(w)) continue
    const stmts = asArray(w[leaf])
    for (const s of stmts) if (typeof s === 'object' && !Array.isArray(s)) out.push(s)
  }
  return out
}

function pickFi(ofx: OfxNode): { org: string; fid?: string } | undefined {
  if (typeof ofx !== 'object' || Array.isArray(ofx)) return undefined
  const sign = ofx.SIGNONMSGSRSV1
  if (!sign || typeof sign !== 'object' || Array.isArray(sign)) return undefined
  const sonrs = sign.SONRS
  if (!sonrs || typeof sonrs !== 'object' || Array.isArray(sonrs)) return undefined
  const fi = sonrs.FI
  if (!fi || typeof fi !== 'object' || Array.isArray(fi)) return undefined
  const org = readString(fi, 'ORG')
  if (!org) return undefined
  const fid = readString(fi, 'FID')
  return fid ? { org, fid } : { org }
}

// ---------------------------------------------------------------------------
// Statement → ExtractionResult
// ---------------------------------------------------------------------------

interface BuildContext {
  source: string
  sourceVersion: number
  filename: string
  fi: { org: string; fid?: string } | undefined
}

function bankStatementToResult(stmt: OfxNode, ctx: BuildContext): ExtractionResult | null {
  if (typeof stmt !== 'object' || Array.isArray(stmt)) return null
  const account = readBankAccount(stmt)
  if (!account) return null

  const txList = readTransactionList(stmt)
  if (!txList) return null

  const transactions = parseTransactions(txList.txns, account.currency, ctx)
  if (transactions.length === 0) return null

  return makeResult({
    account,
    transactions,
    periodStart: txList.dtStart,
    periodEnd: txList.dtEnd,
    balance: readLedgerBalance(stmt),
    ctx,
  })
}

function ccStatementToResult(stmt: OfxNode, ctx: BuildContext): ExtractionResult | null {
  if (typeof stmt !== 'object' || Array.isArray(stmt)) return null
  const account = readCcAccount(stmt)
  if (!account) return null

  const txList = readTransactionList(stmt)
  if (!txList) return null

  const transactions = parseTransactions(txList.txns, account.currency, ctx)
  if (transactions.length === 0) return null

  return makeResult({
    account,
    transactions,
    periodStart: txList.dtStart,
    periodEnd: txList.dtEnd,
    balance: readLedgerBalance(stmt),
    ctx,
  })
}

interface MakeResultArgs {
  account: AccountInfo
  transactions: NormalizedTransaction[]
  periodStart: Date | null
  periodEnd: Date | null
  balance: ExtractionResult['balance']
  ctx: BuildContext
}

function makeResult(args: MakeResultArgs): ExtractionResult {
  // OFX should provide DTSTART/DTEND but some banks omit them — derive from the transaction
  // window so downstream OFX generation stays well-formed.
  const times = args.transactions.map((t) => t.postedAt.getTime())
  const periodStart = args.periodStart ?? new Date(Math.min(...times))
  const periodEnd = args.periodEnd ?? new Date(Math.max(...times))
  return {
    account: args.account,
    transactions: args.transactions,
    periodStart,
    periodEnd,
    balance: args.balance,
    fi: args.ctx.fi,
    recipeSite: args.ctx.source,
    recipeVersion: args.ctx.sourceVersion,
  }
}

// ---------------------------------------------------------------------------
// Sub-blocks
// ---------------------------------------------------------------------------

function readBankAccount(stmt: Record<string, OfxNode | OfxNode[]>): AccountInfo | null {
  const from = stmt.BANKACCTFROM
  if (!from || typeof from !== 'object' || Array.isArray(from)) return null
  const acctId = readString(from, 'ACCTID')
  if (!acctId) return null
  const bankId = readString(from, 'BANKID') || undefined
  const branchId = readString(from, 'BRANCHID') || undefined
  const acctType = (readString(from, 'ACCTTYPE') || 'CHECKING').toUpperCase()
  const type: AccountType = acctType === 'SAVINGS' ? 'savings' : 'checking'
  const currency = readString(stmt, 'CURDEF') || 'BRL'
  return {
    id: acctId,
    bankId,
    branchId,
    name: friendlyName(bankId, acctId, type),
    type,
    currency,
  }
}

function readCcAccount(stmt: Record<string, OfxNode | OfxNode[]>): AccountInfo | null {
  const from = stmt.CCACCTFROM
  if (!from || typeof from !== 'object' || Array.isArray(from)) return null
  const acctId = readString(from, 'ACCTID')
  if (!acctId) return null
  const currency = readString(stmt, 'CURDEF') || 'BRL'
  return {
    id: acctId,
    name: `Cartão **** ${acctId.slice(-4)}`,
    type: 'credit_card',
    currency,
  }
}

function friendlyName(bankId: string | undefined, acctId: string, type: AccountType): string {
  const last4 = acctId.slice(-4)
  const kind = type === 'savings' ? 'Poupança' : 'Conta'
  return bankId ? `Banco ${bankId} — ${kind} *${last4}` : `${kind} *${last4}`
}

function readTransactionList(stmt: Record<string, OfxNode | OfxNode[]>): {
  txns: OfxNode[]
  dtStart: Date | null
  dtEnd: Date | null
} | null {
  const list = stmt.BANKTRANLIST
  if (!list || typeof list !== 'object' || Array.isArray(list)) return null
  const dtStart = parseOfxDate(readString(list, 'DTSTART'))
  const dtEnd = parseOfxDate(readString(list, 'DTEND'))
  const txns = asArray(list.STMTTRN)
  return { txns, dtStart, dtEnd }
}

function readLedgerBalance(stmt: Record<string, OfxNode | OfxNode[]>): ExtractionResult['balance'] {
  const bal = stmt.LEDGERBAL
  if (!bal || typeof bal !== 'object' || Array.isArray(bal)) return undefined
  const amountStr = readString(bal, 'BALAMT')
  if (!amountStr) return undefined
  let amount: Decimal
  try {
    amount = new Decimal(amountStr.replace(',', '.'))
  } catch {
    return undefined
  }
  const asOf = parseOfxDate(readString(bal, 'DTASOF')) ?? new Date()
  return { amount, asOf, source: 'fetched' }
}

// ---------------------------------------------------------------------------
// Transactions
// ---------------------------------------------------------------------------

function parseTransactions(txns: OfxNode[], fallbackCurrency: string, ctx: BuildContext): NormalizedTransaction[] {
  const seen = new Set<string>()
  const out: NormalizedTransaction[] = []
  for (let i = 0; i < txns.length; i++) {
    const node = txns[i]
    const tx = parseSingleTransaction(node, fallbackCurrency, ctx, i)
    if (!tx) continue
    if (seen.has(tx.fitId)) continue
    seen.add(tx.fitId)
    out.push(tx)
  }
  return out
}

function parseSingleTransaction(
  node: OfxNode | undefined,
  fallbackCurrency: string,
  ctx: BuildContext,
  index: number,
): NormalizedTransaction | null {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return null
  const dtPosted = parseOfxDate(readString(node, 'DTPOSTED'))
  if (!dtPosted) return null
  const trnAmt = readString(node, 'TRNAMT')
  if (!trnAmt) return null
  let amountSigned: Decimal
  try {
    amountSigned = new Decimal(trnAmt.replace(',', '.'))
  } catch {
    return null
  }
  const type: 'credit' | 'debit' = amountSigned.gte(0) ? 'credit' : 'debit'

  const name = readString(node, 'NAME')
  const memo = readString(node, 'MEMO')
  // Same convention as our other recipes: prefer NAME as the short label, append MEMO when both
  // are present and differ. Falls back to MEMO when NAME is missing (some BR banks invert it).
  const description = composeDescription(name, memo) || '(sem descrição)'

  const fitIdRaw = readString(node, 'FITID')
  const fitId = fitIdRaw || syntheticFitId(ctx.filename, dtPosted, amountSigned, name, memo, index)

  // OFX has CURRENCY/ORIGCURRENCY blocks per transaction but they're rare in BR — fall back to
  // the statement-level CURDEF.
  const currency = readCurrency(node) || fallbackCurrency

  return {
    fitId,
    postedAt: dtPosted,
    amount: amountSigned.abs(),
    currency,
    description,
    type,
  }
}

function composeDescription(name: string, memo: string): string {
  const n = name.trim()
  const m = memo.trim()
  if (n && m && n !== m) return `${n} — ${m}`
  return n || m
}

function readCurrency(node: Record<string, OfxNode | OfxNode[]>): string {
  const cur = node.CURRENCY ?? node.ORIGCURRENCY
  if (!cur) return ''
  if (typeof cur === 'string') return cur
  if (Array.isArray(cur)) return ''
  return readString(cur, 'CURSYM')
}

/**
 * Deterministic FITID for OFX exports that omit one. Re-importing the same file produces the
 * same id, but two different files with identical transactions get different ids — that's the
 * least-bad tradeoff (the alternative of pure content-hash collides legitimate transfers).
 */
function syntheticFitId(
  filename: string,
  dtPosted: Date,
  amountSigned: Decimal,
  name: string,
  memo: string,
  index: number,
): string {
  const seed = [filename, dtPosted.toISOString(), amountSigned.toString(), name, memo, index].join('|')
  return `ofx-${djb2Hash(seed)}-${index}`
}

function djb2Hash(input: string): string {
  let hash = 5381
  for (let i = 0; i < input.length; i++) {
    hash = ((hash << 5) + hash + input.charCodeAt(i)) | 0
  }
  // Unsigned 32-bit hex — short, stable, no dependency.
  return (hash >>> 0).toString(16).padStart(8, '0')
}

// ---------------------------------------------------------------------------
// Date parsing — OFX 1.0.2 datetime format
// ---------------------------------------------------------------------------

/**
 * OFX 1.0.2 datetime: `YYYYMMDD[HHMMSS[.XXX]][TZ]` where TZ is `[offsetHours[.fraction]:tzname]`,
 * e.g. `20260501100000[-3:BRT]`. Date-only forms (`YYYYMMDD`) map to local midnight at the OFX
 * file's timezone if known, otherwise UTC.
 */
export function parseOfxDate(raw: string | null | undefined): Date | null {
  if (!raw) return null
  const s = raw.trim()
  if (!s) return null

  // Optional timezone block at the end: [offset:abbrev]
  let tzOffsetMinutes = 0
  let tzApplied = false
  const tzMatch = s.match(/\[([+-]?\d+(?:\.\d+)?)(?::[^\]]*)?\]\s*$/)
  let core = s
  if (tzMatch) {
    const offsetHours = Number.parseFloat(tzMatch[1] as string)
    if (Number.isFinite(offsetHours)) {
      tzOffsetMinutes = Math.round(offsetHours * 60)
      tzApplied = true
    }
    core = s.slice(0, tzMatch.index).trim()
  }

  const m = core.match(/^(\d{4})(\d{2})(\d{2})(?:(\d{2})(\d{2})(\d{2})(?:\.(\d{1,6}))?)?$/)
  if (!m) return null
  const [, yyyy, mm, dd, hh = '00', mi = '00', ss = '00', frac = '0'] = m as unknown as [
    string,
    string,
    string,
    string,
    string | undefined,
    string | undefined,
    string | undefined,
    string | undefined,
  ]
  const ms = Math.round(Number.parseFloat(`0.${frac}`) * 1000)

  // Parse as if UTC, then shift back so the moment matches the declared local time.
  // E.g. `20260501100000[-3:BRT]` means 10:00 BRT = 13:00 UTC; we Date.UTC(...) to 10:00 then add 3h.
  const utc = Date.UTC(Number(yyyy), Number(mm) - 1, Number(dd), Number(hh), Number(mi), Number(ss), ms)
  if (Number.isNaN(utc)) return null
  if (!tzApplied) return new Date(utc)
  return new Date(utc - tzOffsetMinutes * 60_000)
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readString(node: OfxNode, key: string): string {
  if (typeof node !== 'object' || Array.isArray(node)) return ''
  const v = node[key]
  if (typeof v === 'string') return v
  if (Array.isArray(v) && v.length > 0 && typeof v[0] === 'string') return v[0]
  return ''
}

function asArray(v: OfxNode | OfxNode[] | undefined): OfxNode[] {
  if (v === undefined) return []
  return Array.isArray(v) ? v : [v]
}
