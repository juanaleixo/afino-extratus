import { OfxNormalizeError, normalizeOfx, parseOfxDate } from '@/parsers/ofx/normalizer'
import { parseOfx } from '@/parsers/ofx/parser'
import { describe, expect, it } from 'vitest'

const SGML_HEADER = [
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

function buildBankOfx(transactions: string[]): string {
  return (
    SGML_HEADER +
    [
      '<OFX>',
      '<SIGNONMSGSRSV1><SONRS>',
      '<STATUS><CODE>0<SEVERITY>INFO</STATUS>',
      '<DTSERVER>20260601100000[-3:BRT]',
      '<LANGUAGE>POR',
      '<FI><ORG>Itau<FID>0341</FI>',
      '</SONRS></SIGNONMSGSRSV1>',
      '<BANKMSGSRSV1><STMTTRNRS><TRNUID>1<STATUS><CODE>0<SEVERITY>INFO</STATUS>',
      '<STMTRS>',
      '<CURDEF>BRL',
      '<BANKACCTFROM><BANKID>0341<BRANCHID>1234<ACCTID>56789-0<ACCTTYPE>CHECKING</BANKACCTFROM>',
      '<BANKTRANLIST>',
      '<DTSTART>20260501000000[-3:BRT]',
      '<DTEND>20260531235959[-3:BRT]',
      ...transactions,
      '</BANKTRANLIST>',
      '<LEDGERBAL><BALAMT>1500.50<DTASOF>20260531235959[-3:BRT]</LEDGERBAL>',
      '</STMTRS></STMTTRNRS></BANKMSGSRSV1>',
      '</OFX>',
    ].join('\n')
  )
}

describe('normalizeOfx — bank statement', () => {
  it('produces one ExtractionResult per bank statement', () => {
    const ofx = buildBankOfx([
      '<STMTTRN><DTPOSTED>20260501100000[-3:BRT]<TRNAMT>200.00<FITID>tx-1<NAME>Pix recebido<MEMO>Joao</STMTTRN>',
      '<STMTTRN><DTPOSTED>20260502130000[-3:BRT]<TRNAMT>-49.90<FITID>tx-2<NAME>Mercado<MEMO></STMTTRN>',
    ])
    const results = normalizeOfx(parseOfx(ofx))
    expect(results).toHaveLength(1)
    const r = results[0]
    if (!r) throw new Error('unreachable')
    expect(r.account.id).toBe('56789-0')
    expect(r.account.bankId).toBe('0341')
    expect(r.account.branchId).toBe('1234')
    expect(r.account.type).toBe('checking')
    expect(r.account.currency).toBe('BRL')
    expect(r.transactions).toHaveLength(2)
  })

  it('parses signed amounts: positive→credit, negative→debit', () => {
    const ofx = buildBankOfx([
      '<STMTTRN><DTPOSTED>20260501100000[-3:BRT]<TRNAMT>100.50<FITID>credit<NAME>x</STMTTRN>',
      '<STMTTRN><DTPOSTED>20260502100000[-3:BRT]<TRNAMT>-25.30<FITID>debit<NAME>y</STMTTRN>',
    ])
    const [r] = normalizeOfx(parseOfx(ofx))
    if (!r) throw new Error('unreachable')
    const credit = r.transactions.find((t) => t.fitId === 'credit')
    const debit = r.transactions.find((t) => t.fitId === 'debit')
    expect(credit?.type).toBe('credit')
    expect(credit?.amount.toString()).toBe('100.5')
    expect(debit?.type).toBe('debit')
    expect(debit?.amount.toString()).toBe('25.3')
  })

  it('composes description from NAME + MEMO when both differ', () => {
    const ofx = buildBankOfx([
      '<STMTTRN><DTPOSTED>20260501<TRNAMT>1.00<FITID>x<NAME>Pix<MEMO>Joao Silva</STMTTRN>',
      '<STMTTRN><DTPOSTED>20260502<TRNAMT>1.00<FITID>y<NAME>Mercado<MEMO>Mercado</STMTTRN>',
      '<STMTTRN><DTPOSTED>20260503<TRNAMT>1.00<FITID>z<NAME>Aluguel<MEMO></STMTTRN>',
    ])
    const [r] = normalizeOfx(parseOfx(ofx))
    if (!r) throw new Error('unreachable')
    const byId = (id: string) => r.transactions.find((t) => t.fitId === id)
    expect(byId('x')?.description).toBe('Pix — Joao Silva')
    expect(byId('y')?.description).toBe('Mercado') // dedup when NAME===MEMO
    expect(byId('z')?.description).toBe('Aluguel') // empty MEMO → just NAME
  })

  it('parses LEDGERBAL into ExtractionResult.balance', () => {
    const ofx = buildBankOfx(['<STMTTRN><DTPOSTED>20260501<TRNAMT>1.00<FITID>x<NAME>x</STMTTRN>'])
    const [r] = normalizeOfx(parseOfx(ofx))
    expect(r?.balance?.amount.toString()).toBe('1500.5')
    expect(r?.balance?.source).toBe('fetched')
  })

  it('extracts FI from SIGNONMSGSRSV1 and propagates it to results', () => {
    const ofx = buildBankOfx(['<STMTTRN><DTPOSTED>20260501<TRNAMT>1.00<FITID>x<NAME>x</STMTTRN>'])
    const [r] = normalizeOfx(parseOfx(ofx))
    expect(r?.fi).toEqual({ org: 'Itau', fid: '0341' })
  })

  it('synthesizes a stable FITID when STMTTRN.FITID is missing', () => {
    const ofx = buildBankOfx([
      '<STMTTRN><DTPOSTED>20260501<TRNAMT>1.00<NAME>x<MEMO>m</STMTTRN>',
      '<STMTTRN><DTPOSTED>20260502<TRNAMT>2.00<NAME>y<MEMO>n</STMTTRN>',
    ])
    const [r] = normalizeOfx(parseOfx(ofx), { filename: 'fixture.ofx' })
    if (!r) throw new Error('unreachable')
    expect(r.transactions).toHaveLength(2)
    const t0 = r.transactions[0]
    const t1 = r.transactions[1]
    if (!t0 || !t1) throw new Error('unreachable')
    expect(t0.fitId).toMatch(/^ofx-[0-9a-f]{8}-0$/)
    expect(t1.fitId).toMatch(/^ofx-[0-9a-f]{8}-1$/)
    // Same input ⇒ same id (re-import idempotency)
    const [r2] = normalizeOfx(parseOfx(ofx), { filename: 'fixture.ofx' })
    if (!r2) throw new Error('unreachable')
    expect(r2.transactions[0]?.fitId).toBe(t0.fitId)
  })

  it('deduplicates transactions sharing the same FITID', () => {
    const ofx = buildBankOfx([
      '<STMTTRN><DTPOSTED>20260501<TRNAMT>1.00<FITID>dup<NAME>a</STMTTRN>',
      '<STMTTRN><DTPOSTED>20260502<TRNAMT>2.00<FITID>dup<NAME>b</STMTTRN>',
    ])
    const [r] = normalizeOfx(parseOfx(ofx))
    expect(r?.transactions).toHaveLength(1)
  })
})

describe('normalizeOfx — credit card', () => {
  it('emits an ExtractionResult of type credit_card from CCSTMTRS', () => {
    const ofx =
      SGML_HEADER +
      [
        '<OFX>',
        '<CREDITCARDMSGSRSV1><CCSTMTTRNRS><CCSTMTRS>',
        '<CURDEF>BRL',
        '<CCACCTFROM><ACCTID>4111111111111111</CCACCTFROM>',
        '<BANKTRANLIST><DTSTART>20260501<DTEND>20260531',
        '<STMTTRN><DTPOSTED>20260510<TRNAMT>-99.90<FITID>cc-1<NAME>Netflix</STMTTRN>',
        '</BANKTRANLIST></CCSTMTRS></CCSTMTTRNRS></CREDITCARDMSGSRSV1>',
        '</OFX>',
      ].join('\n')
    const [r] = normalizeOfx(parseOfx(ofx))
    expect(r?.account.type).toBe('credit_card')
    expect(r?.account.id).toBe('4111111111111111')
    expect(r?.transactions[0]?.type).toBe('debit')
  })
})

describe('normalizeOfx — error paths', () => {
  it('throws when there are no statements', () => {
    const ofx = `${SGML_HEADER}<OFX><SIGNONMSGSRSV1></SIGNONMSGSRSV1></OFX>`
    expect(() => normalizeOfx(parseOfx(ofx))).toThrow(OfxNormalizeError)
  })
})

describe('parseOfxDate', () => {
  it('parses YYYYMMDDHHMMSS[-3:BRT] back to the correct UTC instant', () => {
    // 10:00 BRT == 13:00 UTC
    expect(parseOfxDate('20260501100000[-3:BRT]')?.toISOString()).toBe('2026-05-01T13:00:00.000Z')
  })

  it('parses date-only forms as UTC midnight', () => {
    expect(parseOfxDate('20260501')?.toISOString()).toBe('2026-05-01T00:00:00.000Z')
  })

  it('handles the no-timezone variant', () => {
    expect(parseOfxDate('20260501100000')?.toISOString()).toBe('2026-05-01T10:00:00.000Z')
  })

  it('handles fractional seconds', () => {
    expect(parseOfxDate('20260501100000.500')?.toISOString()).toBe('2026-05-01T10:00:00.500Z')
  })

  it('returns null for malformed input', () => {
    expect(parseOfxDate('not a date')).toBeNull()
    expect(parseOfxDate(null)).toBeNull()
    expect(parseOfxDate(undefined)).toBeNull()
    expect(parseOfxDate('')).toBeNull()
  })
})
