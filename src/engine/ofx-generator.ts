import type { ExtractionResult, NormalizedTransaction } from '@/types/transaction'
import { formatOfxDateTime } from './normalize'

/**
 * Build an OFX 1.0.2 SGML document that aims to be importable by as many tools
 * as practical (Afino, GnuCash, Quicken, Money2025, Bradesco e similares).
 *
 * Choices for maximum compatibility:
 *   - SGML 1.0.2 (not the 2.x XML), since most BR importers expect the SGML dialect.
 *   - <FI> with <ORG>/<FID> emitted whenever the recipe declares it (Quicken-friendly).
 *   - <BANKID> falls back to ISPB-or-account-id, never empty.
 *   - <BRANCHID> emitted when known.
 *   - Each <STMTTRN> emits both <NAME> (≤32 chars short label) and <MEMO> (long form).
 *   - <LEDGERBAL> emitted when the result has a balance (derived or fetched).
 *   - Bank vs credit-card statements split into BANKMSGSRSV1 / CREDITCARDMSGSRSV1 properly.
 *
 * Accepts one result or many. When given many of the same kind, statements share a
 * single envelope.
 */
export function buildOfx(input: ExtractionResult | ExtractionResult[], generatedAt: Date = new Date()): string {
  const results = Array.isArray(input) ? input : [input]
  if (results.length === 0) throw new Error('buildOfx: no results provided')

  const fi = results.find((r) => r.fi)?.fi

  const bankResults = results.filter((r) => r.account.type !== 'credit_card')
  const ccResults = results.filter((r) => r.account.type === 'credit_card')

  const header = [
    'OFXHEADER:100',
    'DATA:OFXSGML',
    'VERSION:102',
    'SECURITY:NONE',
    'ENCODING:USASCII',
    'CHARSET:1252',
    'COMPRESSION:NONE',
    'OLDFILEUID:NONE',
    'NEWFILEUID:NONE',
    '',
    '',
  ].join('\r\n')

  const body = [
    '<OFX>',
    renderSignon(generatedAt, fi),
    ...(bankResults.length ? renderBankBlock(bankResults) : []),
    ...(ccResults.length ? renderCreditCardBlock(ccResults) : []),
    '</OFX>',
  ].join('\r\n')

  return header + body
}

function renderBankBlock(results: ExtractionResult[]): string[] {
  return ['<BANKMSGSRSV1>', ...results.flatMap((r, i) => renderBankStatement(r, i + 1)), '</BANKMSGSRSV1>']
}

function renderCreditCardBlock(results: ExtractionResult[]): string[] {
  return [
    '<CREDITCARDMSGSRSV1>',
    ...results.flatMap((r, i) => renderCreditCardStatement(r, i + 1)),
    '</CREDITCARDMSGSRSV1>',
  ]
}

function renderBankStatement(result: ExtractionResult, trnuid: number): string[] {
  const { account, transactions, periodStart, periodEnd, balance } = result
  const bankId = account.bankId || account.id
  return [
    '<STMTTRNRS>',
    `<TRNUID>${trnuid}`,
    '<STATUS><CODE>0<SEVERITY>INFO</STATUS>',
    '<STMTRS>',
    `<CURDEF>${account.currency}`,
    '<BANKACCTFROM>',
    `<BANKID>${escapeOfx(bankId)}`,
    ...(account.branchId ? [`<BRANCHID>${escapeOfx(account.branchId)}`] : []),
    `<ACCTID>${escapeOfx(account.id)}`,
    `<ACCTTYPE>${account.type === 'savings' ? 'SAVINGS' : 'CHECKING'}`,
    '</BANKACCTFROM>',
    '<BANKTRANLIST>',
    `<DTSTART>${formatOfxDateTime(periodStart)}`,
    `<DTEND>${formatOfxDateTime(periodEnd)}`,
    ...transactions.map(renderTransaction),
    '</BANKTRANLIST>',
    ...renderLedgerBal(balance),
    '</STMTRS>',
    '</STMTTRNRS>',
  ]
}

function renderCreditCardStatement(result: ExtractionResult, trnuid: number): string[] {
  const { account, transactions, periodStart, periodEnd, balance } = result
  return [
    '<CCSTMTTRNRS>',
    `<TRNUID>${trnuid}`,
    '<STATUS><CODE>0<SEVERITY>INFO</STATUS>',
    '<CCSTMTRS>',
    `<CURDEF>${account.currency}`,
    '<CCACCTFROM>',
    `<ACCTID>${escapeOfx(account.id)}`,
    '</CCACCTFROM>',
    '<BANKTRANLIST>',
    `<DTSTART>${formatOfxDateTime(periodStart)}`,
    `<DTEND>${formatOfxDateTime(periodEnd)}`,
    ...transactions.map(renderTransaction),
    '</BANKTRANLIST>',
    ...renderLedgerBal(balance),
    '</CCSTMTRS>',
    '</CCSTMTTRNRS>',
  ]
}

function renderSignon(generatedAt: Date, fi?: { org: string; fid?: string }): string {
  const fiBlock = fi
    ? ['<FI>', `<ORG>${escapeOfx(fi.org)}`, ...(fi.fid ? [`<FID>${escapeOfx(fi.fid)}`] : []), '</FI>']
    : []
  return [
    '<SIGNONMSGSRSV1>',
    '<SONRS>',
    '<STATUS><CODE>0<SEVERITY>INFO</STATUS>',
    `<DTSERVER>${formatOfxDateTime(generatedAt)}`,
    '<LANGUAGE>POR',
    ...fiBlock,
    '</SONRS>',
    '</SIGNONMSGSRSV1>',
  ].join('\r\n')
}

function renderLedgerBal(balance: ExtractionResult['balance']): string[] {
  if (!balance) return []
  return [
    '<LEDGERBAL>',
    `<BALAMT>${balance.amount.toFixed(2)}`,
    `<DTASOF>${formatOfxDateTime(balance.asOf)}`,
    '</LEDGERBAL>',
  ]
}

function renderTransaction(t: NormalizedTransaction): string {
  const signedAmount = t.type === 'debit' ? t.amount.neg() : t.amount
  const name = shortName(t.description)
  return [
    '<STMTTRN>',
    `<TRNTYPE>${t.type === 'debit' ? 'DEBIT' : 'CREDIT'}`,
    `<DTPOSTED>${formatOfxDateTime(t.postedAt)}`,
    `<TRNAMT>${signedAmount.toFixed(2)}`,
    `<FITID>${escapeOfx(t.fitId)}`,
    `<NAME>${escapeOfx(name)}`,
    `<MEMO>${escapeOfx(t.description)}`,
    '</STMTTRN>',
  ].join('\r\n')
}

/** OFX <NAME> is short-form (Quicken/Money treat it as the payee). Trim to 32 chars. */
function shortName(description: string): string {
  const cleaned = description.replace(/\s+/g, ' ').trim() || '(sem descrição)'
  return cleaned.length <= 32 ? cleaned : `${cleaned.slice(0, 31)}…`
}

function escapeOfx(input: string): string {
  return input.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
