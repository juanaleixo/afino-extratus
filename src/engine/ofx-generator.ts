import type { ExtractionResult, NormalizedTransaction } from '@/types/transaction'
import { formatOfxDateTime } from './normalize'

/**
 * Build an OFX 1.0.2 SGML document. Most Brazilian importers (Afino, GnuCash,
 * banks' reconciliation tools) expect this dialect rather than OFX 2.0 XML.
 */
export function buildOfx(result: ExtractionResult, generatedAt: Date = new Date()): string {
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

  const body =
    result.account.type === 'credit_card' ? renderCreditCard(result, generatedAt) : renderBank(result, generatedAt)

  return header + body
}

function renderBank(result: ExtractionResult, generatedAt: Date): string {
  const { account, transactions, periodStart, periodEnd } = result
  return [
    '<OFX>',
    renderSignon(generatedAt),
    '<BANKMSGSRSV1>',
    '<STMTTRNRS>',
    '<TRNUID>1',
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
    '</BANKMSGSRSV1>',
    '</OFX>',
  ].join('\r\n')
}

function renderCreditCard(result: ExtractionResult, generatedAt: Date): string {
  const { account, transactions, periodStart, periodEnd } = result
  return [
    '<OFX>',
    renderSignon(generatedAt),
    '<CREDITCARDMSGSRSV1>',
    '<CCSTMTTRNRS>',
    '<TRNUID>1',
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
    '</CREDITCARDMSGSRSV1>',
    '</OFX>',
  ].join('\r\n')
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
