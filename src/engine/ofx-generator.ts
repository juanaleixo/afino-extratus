import type { ExtractionResult, NormalizedTransaction } from '@/types/transaction'
import { formatOfxDateTime } from './normalize'

/**
 * Build an OFX 1.0.2 SGML document. Most Brazilian importers (Afino, GnuCash,
 * banks' reconciliation tools) expect this dialect rather than OFX 2.0 XML.
 *
 * Accepts one result or many. When given many, bank accounts share a single
 * BANKMSGSRSV1 (one STMTTRNRS each) and credit cards share a CREDITCARDMSGSRSV1.
 */
export function buildOfx(input: ExtractionResult | ExtractionResult[], generatedAt: Date = new Date()): string {
  const results = Array.isArray(input) ? input : [input]
  if (results.length === 0) throw new Error('buildOfx: no results provided')

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
    renderSignon(generatedAt),
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
  const { account, transactions, periodStart, periodEnd } = result
  return [
    '<STMTTRNRS>',
    `<TRNUID>${trnuid}`,
    '<STATUS><CODE>0<SEVERITY>INFO</STATUS>',
    '<STMTRS>',
    `<CURDEF>${account.currency}`,
    '<BANKACCTFROM>',
    `<BANKID>${escapeOfx(account.bankId ?? account.id)}`,
    `<ACCTID>${escapeOfx(account.id)}`,
    `<ACCTTYPE>${account.type === 'savings' ? 'SAVINGS' : 'CHECKING'}`,
    '</BANKACCTFROM>',
    '<BANKTRANLIST>',
    `<DTSTART>${formatOfxDateTime(periodStart)}`,
    `<DTEND>${formatOfxDateTime(periodEnd)}`,
    ...transactions.map(renderTransaction),
    '</BANKTRANLIST>',
    '</STMTRS>',
    '</STMTTRNRS>',
  ]
}

function renderCreditCardStatement(result: ExtractionResult, trnuid: number): string[] {
  const { account, transactions, periodStart, periodEnd } = result
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
    '</CCSTMTRS>',
    '</CCSTMTTRNRS>',
  ]
}

function renderSignon(generatedAt: Date): string {
  return [
    '<SIGNONMSGSRSV1>',
    '<SONRS>',
    '<STATUS><CODE>0<SEVERITY>INFO</STATUS>',
    `<DTSERVER>${formatOfxDateTime(generatedAt)}`,
    '<LANGUAGE>POR',
    '</SONRS>',
    '</SIGNONMSGSRSV1>',
  ].join('\r\n')
}

function renderTransaction(t: NormalizedTransaction): string {
  const signedAmount = t.type === 'debit' ? t.amount.neg() : t.amount
  return [
    '<STMTTRN>',
    `<TRNTYPE>${t.type === 'debit' ? 'DEBIT' : 'CREDIT'}`,
    `<DTPOSTED>${formatOfxDateTime(t.postedAt)}`,
    `<TRNAMT>${signedAmount.toFixed(2)}`,
    `<FITID>${escapeOfx(t.fitId)}`,
    `<MEMO>${escapeOfx(t.description)}`,
    '</STMTTRN>',
  ].join('\r\n')
}

function escapeOfx(input: string): string {
  return input.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
