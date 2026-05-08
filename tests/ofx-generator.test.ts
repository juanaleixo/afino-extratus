import Decimal from 'decimal.js'
import { describe, expect, it } from 'vitest'
import { buildOfx } from '@/engine/ofx-generator'
import type { ExtractionResult } from '@/types/transaction'

function makeResult(overrides: Partial<ExtractionResult> = {}): ExtractionResult {
  return {
    account: { id: '12345-6', name: 'Test', type: 'checking', currency: 'BRL' },
    transactions: [
      {
        fitId: 'tx-1',
        postedAt: new Date('2026-05-01T13:00:00Z'),
        amount: new Decimal('150.00'),
        currency: 'BRL',
        description: 'Pix recebido',
        type: 'credit',
      },
      {
        fitId: 'tx-2',
        postedAt: new Date('2026-05-02T13:00:00Z'),
        amount: new Decimal('40.00'),
        currency: 'BRL',
        description: 'Mercado',
        type: 'debit',
      },
    ],
    periodStart: new Date('2026-05-01T00:00:00Z'),
    periodEnd: new Date('2026-05-02T23:59:59Z'),
    recipeSite: 'test.com.br',
    recipeVersion: 1,
    ...overrides,
  }
}

describe('buildOfx', () => {
  it('emits OFX 1.0.2 SGML header', () => {
    const ofx = buildOfx(makeResult())
    expect(ofx).toContain('OFXHEADER:100')
    expect(ofx).toContain('DATA:OFXSGML')
    expect(ofx).toContain('VERSION:102')
  })

  it('signs amounts: credit positive, debit negative', () => {
    const ofx = buildOfx(makeResult())
    expect(ofx).toContain('<TRNTYPE>CREDIT')
    expect(ofx).toContain('<TRNAMT>150.00')
    expect(ofx).toContain('<TRNTYPE>DEBIT')
    expect(ofx).toContain('<TRNAMT>-40.00')
  })

  it('emits BANKACCTFROM for checking accounts', () => {
    const ofx = buildOfx(makeResult())
    expect(ofx).toContain('<BANKACCTFROM>')
    expect(ofx).toContain('<ACCTTYPE>CHECKING')
    expect(ofx).not.toContain('<CCACCTFROM>')
  })

  it('emits CCACCTFROM for credit card accounts', () => {
    const ofx = buildOfx(
      makeResult({
        account: { id: '4111', name: 'Cartão', type: 'credit_card', currency: 'BRL' },
      }),
    )
    expect(ofx).toContain('<CREDITCARDMSGSRSV1>')
    expect(ofx).toContain('<CCACCTFROM>')
    expect(ofx).not.toContain('<BANKACCTFROM>')
  })

  it('escapes XML-special characters in MEMO', () => {
    const ofx = buildOfx(
      makeResult({
        transactions: [
          {
            fitId: 'tx',
            postedAt: new Date('2026-05-01T00:00:00Z'),
            amount: new Decimal('1.00'),
            currency: 'BRL',
            description: 'A & B < C > D',
            type: 'credit',
          },
        ],
      }),
    )
    expect(ofx).toContain('A &amp; B &lt; C &gt; D')
  })

  it('formats datetimes in São Paulo timezone with [-3:BRT] suffix', () => {
    const ofx = buildOfx(
      makeResult({
        transactions: [
          {
            fitId: 'tx',
            postedAt: new Date('2026-05-01T13:00:00Z'),
            amount: new Decimal('1.00'),
            currency: 'BRL',
            description: 'x',
            type: 'credit',
          },
        ],
      }),
    )
    // 13:00 UTC == 10:00 BRT
    expect(ofx).toMatch(/<DTPOSTED>20260501100000\[-3:BRT\]/)
  })

  it('preserves Decimal precision in TRNAMT (no float drift)', () => {
    const ofx = buildOfx(
      makeResult({
        transactions: [
          {
            fitId: 'tx',
            postedAt: new Date('2026-05-01T00:00:00Z'),
            amount: new Decimal('0.10').plus('0.20'), // 0.30, not 0.30000000000000004
            currency: 'BRL',
            description: 'precision',
            type: 'credit',
          },
        ],
      }),
    )
    expect(ofx).toContain('<TRNAMT>0.30')
    expect(ofx).not.toContain('0.30000')
  })
})
