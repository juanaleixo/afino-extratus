import { OfxParseError, detectOfxCharset, parseOfx } from '@/parsers/ofx/parser'
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

describe('parseOfx — header', () => {
  it('parses header key/value pairs into an object', () => {
    const ofx = `${SGML_HEADER}<OFX></OFX>`
    const doc = parseOfx(ofx)
    expect(doc.header.OFXHEADER).toBe('100')
    expect(doc.header.DATA).toBe('OFXSGML')
    expect(doc.header.VERSION).toBe('102')
    expect(doc.header.CHARSET).toBe('1252')
  })

  it('throws when <OFX> tag is absent', () => {
    expect(() => parseOfx('OFXHEADER:100\r\n\r\nnope')).toThrow(OfxParseError)
  })

  it('throws on empty input', () => {
    expect(() => parseOfx('')).toThrow(OfxParseError)
  })
})

describe('parseOfx — SGML 1.0.2 (the BR case)', () => {
  it('parses unclosed leaf tags (the classic BR pattern)', () => {
    // Itaú/BB/Caixa style: <TAG>value with no </TAG>.
    const body = [
      '<OFX>',
      '<BANKMSGSRSV1>',
      '<STMTTRNRS>',
      '<STMTRS>',
      '<CURDEF>BRL',
      '<BANKACCTFROM>',
      '<BANKID>0341',
      '<ACCTID>12345-6',
      '<ACCTTYPE>CHECKING',
      '</BANKACCTFROM>',
      '<BANKTRANLIST>',
      '<DTSTART>20260501000000[-3:BRT]',
      '<DTEND>20260531235959[-3:BRT]',
      '<STMTTRN>',
      '<TRNTYPE>CREDIT',
      '<DTPOSTED>20260501100000[-3:BRT]',
      '<TRNAMT>150.00',
      '<FITID>tx-1',
      '<NAME>Pix recebido',
      '<MEMO>Joao Silva',
      '</STMTTRN>',
      '</BANKTRANLIST>',
      '</STMTRS>',
      '</STMTTRNRS>',
      '</BANKMSGSRSV1>',
      '</OFX>',
    ].join('\n')
    const doc = parseOfx(SGML_HEADER + body)
    const ofx = doc.OFX
    expect(typeof ofx).toBe('object')
    if (typeof ofx !== 'object') throw new Error('unreachable')
    const stmt = (ofx as Record<string, unknown>).BANKMSGSRSV1 as Record<string, unknown>
    const stmtTrnRs = stmt.STMTTRNRS as Record<string, unknown>
    const stmtRs = stmtTrnRs.STMTRS as Record<string, unknown>
    expect(stmtRs.CURDEF).toBe('BRL')
    const tranList = stmtRs.BANKTRANLIST as Record<string, unknown>
    const tx = tranList.STMTTRN as Record<string, unknown>
    expect(tx.FITID).toBe('tx-1')
    expect(tx.TRNAMT).toBe('150.00')
    expect(tx.NAME).toBe('Pix recebido')
  })

  it('groups repeated STMTTRN tags into an array', () => {
    const body = [
      '<OFX>',
      '<BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>BRL',
      '<BANKACCTFROM><BANKID>1<ACCTID>2<ACCTTYPE>CHECKING</BANKACCTFROM>',
      '<BANKTRANLIST>',
      '<DTSTART>20260501<DTEND>20260531',
      '<STMTTRN><DTPOSTED>20260501<TRNAMT>10.00<FITID>a<NAME>x</STMTTRN>',
      '<STMTTRN><DTPOSTED>20260502<TRNAMT>-5.00<FITID>b<NAME>y</STMTTRN>',
      '<STMTTRN><DTPOSTED>20260503<TRNAMT>3.00<FITID>c<NAME>z</STMTTRN>',
      '</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1>',
      '</OFX>',
    ].join('\n')
    const doc = parseOfx(SGML_HEADER + body)
    const list = (
      ((doc.OFX as Record<string, unknown>).BANKMSGSRSV1 as Record<string, unknown>).STMTTRNRS as Record<
        string,
        unknown
      >
    ).STMTRS as Record<string, unknown>
    const tranList = list.BANKTRANLIST as Record<string, unknown>
    expect(Array.isArray(tranList.STMTTRN)).toBe(true)
    expect((tranList.STMTTRN as unknown[]).length).toBe(3)
  })

  it('decodes XML entities in MEMO/NAME content', () => {
    const body = [
      '<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>BRL',
      '<BANKACCTFROM><BANKID>1<ACCTID>2<ACCTTYPE>CHECKING</BANKACCTFROM>',
      '<BANKTRANLIST><DTSTART>20260501<DTEND>20260531',
      // &amp; is XML-core, &ccedil; is HTML-named, &#231; is numeric
      '<STMTTRN><DTPOSTED>20260501<TRNAMT>1.00<FITID>x<NAME>A &amp; B<MEMO>Compra na Pra&ccedil;a &#231;</STMTTRN>',
      '</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>',
    ].join('\n')
    const doc = parseOfx(SGML_HEADER + body)
    const tx = (
      (
        ((doc.OFX as Record<string, unknown>).BANKMSGSRSV1 as Record<string, unknown>).STMTTRNRS as Record<
          string,
          unknown
        >
      ).STMTRS as Record<string, unknown>
    ).BANKTRANLIST as Record<string, unknown>
    const t = tx.STMTTRN as Record<string, string>
    expect(t.NAME).toBe('A & B')
    expect(t.MEMO).toBe('Compra na Praça ç')
  })

  it('parses CCSTMTTRNRS for credit-card statements', () => {
    const body = [
      '<OFX><CREDITCARDMSGSRSV1><CCSTMTTRNRS><CCSTMTRS>',
      '<CURDEF>BRL',
      '<CCACCTFROM><ACCTID>4111111111111111</CCACCTFROM>',
      '<BANKTRANLIST><DTSTART>20260501<DTEND>20260531',
      '<STMTTRN><DTPOSTED>20260510<TRNAMT>-99.90<FITID>cc-1<NAME>Netflix</STMTTRN>',
      '</BANKTRANLIST></CCSTMTRS></CCSTMTTRNRS></CREDITCARDMSGSRSV1></OFX>',
    ].join('\n')
    const doc = parseOfx(SGML_HEADER + body)
    expect(typeof doc.OFX).toBe('object')
    const cc = (doc.OFX as Record<string, unknown>).CREDITCARDMSGSRSV1 as Record<string, unknown>
    expect(cc.CCSTMTTRNRS).toBeTruthy()
  })
})

describe('parseOfx — OFX 2.x XML', () => {
  it('parses a strict XML payload', () => {
    const xml = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<?OFX OFXHEADER="200" VERSION="200" SECURITY="NONE" OLDFILEUID="NONE" NEWFILEUID="NONE"?>',
      '<OFX>',
      '<BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>BRL</CURDEF>',
      '<BANKACCTFROM><BANKID>0341</BANKID><ACCTID>12345-6</ACCTID><ACCTTYPE>CHECKING</ACCTTYPE></BANKACCTFROM>',
      '<BANKTRANLIST>',
      '<DTSTART>20260501</DTSTART><DTEND>20260531</DTEND>',
      '<STMTTRN><DTPOSTED>20260501</DTPOSTED><TRNAMT>50.00</TRNAMT><FITID>x</FITID><NAME>foo</NAME></STMTTRN>',
      '</BANKTRANLIST>',
      '</STMTRS></STMTTRNRS></BANKMSGSRSV1>',
      '</OFX>',
    ].join('\n')
    const doc = parseOfx(xml)
    expect(doc.header).toBeDefined()
    expect(typeof doc.OFX).toBe('object')
  })
})

describe('detectOfxCharset', () => {
  it('returns windows-1252 for "CHARSET:1252"', () => {
    const buf = new TextEncoder().encode(`${SGML_HEADER}<OFX></OFX>`)
    expect(detectOfxCharset(buf)).toBe('windows-1252')
  })

  it('returns iso-8859-1 for "CHARSET:8859-1"', () => {
    const buf = new TextEncoder().encode('CHARSET:8859-1\r\n\r\n<OFX></OFX>')
    expect(detectOfxCharset(buf)).toBe('iso-8859-1')
  })

  it('reads the encoding="..." attribute from XML 2.x prolog', () => {
    const buf = new TextEncoder().encode('<?xml version="1.0" encoding="ISO-8859-1"?><OFX></OFX>')
    expect(detectOfxCharset(buf)).toBe('iso-8859-1')
  })

  it('falls back to utf-8 when nothing is declared', () => {
    const buf = new TextEncoder().encode('<OFX></OFX>')
    expect(detectOfxCharset(buf)).toBe('utf-8')
  })
})
