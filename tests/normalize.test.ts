import {
  deserializeResult,
  deserializeTransaction,
  formatBrDate,
  formatOfxDateTime,
  parseBrAmount,
  parseBrDate,
  serializeResult,
  serializeTransaction,
} from '@/engine/normalize'
import type { ExtractionResult, NormalizedTransaction } from '@/types/transaction'
import Decimal from 'decimal.js'
import { describe, expect, it } from 'vitest'

describe('parseBrDate', () => {
  it('parses DD/MM/YYYY as midnight São Paulo time (UTC instant)', () => {
    // BRT is UTC-3, so 00:00 BRT == 03:00 UTC.
    expect(parseBrDate('01/05/2026').toISOString()).toBe('2026-05-01T03:00:00.000Z')
  })

  it('rejects malformed strings', () => {
    expect(() => parseBrDate('1/5/2026')).toThrow()
    expect(() => parseBrDate('2026-05-01')).toThrow()
    expect(() => parseBrDate('foo')).toThrow()
  })

  it('round-trips through formatBrDate', () => {
    const d = parseBrDate('15/03/2026')
    expect(formatBrDate(d)).toBe('15/03/2026')
  })
})

describe('formatBrDate', () => {
  it('formats UTC instant in São Paulo timezone (after DST removal)', () => {
    // 03:00 UTC == 00:00 BRT — same calendar day in BR.
    expect(formatBrDate(new Date('2026-05-01T03:00:00Z'))).toBe('01/05/2026')
  })

  it('respects the timezone shift across midnight UTC', () => {
    // 02:00 UTC on 1 May == 23:00 BRT on 30 Apr.
    expect(formatBrDate(new Date('2026-05-01T02:00:00Z'))).toBe('30/04/2026')
  })

  it('zero-pads day and month', () => {
    expect(formatBrDate(new Date('2026-01-09T15:00:00Z'))).toBe('09/01/2026')
  })
})

describe('formatOfxDateTime', () => {
  it('uses the OFX 1.0.2 spec with [-3:BRT] suffix', () => {
    expect(formatOfxDateTime(new Date('2026-05-01T13:00:00Z'))).toBe('20260501100000[-3:BRT]')
  })

  it('handles seconds and minutes correctly', () => {
    expect(formatOfxDateTime(new Date('2026-05-01T13:42:07Z'))).toBe('20260501104207[-3:BRT]')
  })
})

describe('parseBrAmount', () => {
  it('parses plain integer', () => {
    expect(parseBrAmount('1234').toString()).toBe('1234')
  })

  it('parses BR-formatted decimal with thousand separators', () => {
    expect(parseBrAmount('1.234,56').toString()).toBe('1234.56')
  })

  it('strips R$ and whitespace', () => {
    expect(parseBrAmount('R$ 1.234,56').toString()).toBe('1234.56')
  })

  it('handles negative sign', () => {
    expect(parseBrAmount('-R$ 50,00').toString()).toBe('-50')
  })

  it('preserves Decimal precision (no float drift)', () => {
    const a = parseBrAmount('0,10').plus(parseBrAmount('0,20'))
    expect(a.toString()).toBe('0.3')
  })

  it('rejects empty / non-numeric input', () => {
    expect(() => parseBrAmount('—')).toThrow()
    expect(() => parseBrAmount('')).toThrow()
  })
})

describe('serialize/deserialize', () => {
  function makeTx(): NormalizedTransaction {
    return {
      fitId: 'tx-1',
      postedAt: new Date('2026-05-01T13:00:00Z'),
      amount: new Decimal('1234.56'),
      currency: 'BRL',
      description: 'Mercado',
      type: 'debit',
    }
  }

  it('round-trips a transaction without losing Decimal precision', () => {
    const original = makeTx()
    const restored = deserializeTransaction(serializeTransaction(original))
    expect(restored.fitId).toBe(original.fitId)
    expect(restored.postedAt.toISOString()).toBe(original.postedAt.toISOString())
    expect(restored.amount.toString()).toBe(original.amount.toString())
    expect(restored.amount).toBeInstanceOf(Decimal)
    expect(restored.currency).toBe(original.currency)
    expect(restored.description).toBe(original.description)
    expect(restored.type).toBe(original.type)
  })

  it('round-trips an ExtractionResult with metadata intact', () => {
    const result: ExtractionResult = {
      account: { id: 'acc-1', name: 'Test', type: 'checking', currency: 'BRL' },
      transactions: [makeTx()],
      periodStart: new Date('2026-05-01T00:00:00Z'),
      periodEnd: new Date('2026-05-31T23:59:59Z'),
      recipeSite: 'test.com.br',
      recipeVersion: 3,
    }

    const restored = deserializeResult(serializeResult(result))
    expect(restored.account).toEqual(result.account)
    expect(restored.recipeSite).toBe('test.com.br')
    expect(restored.recipeVersion).toBe(3)
    expect(restored.periodStart.toISOString()).toBe(result.periodStart.toISOString())
    expect(restored.periodEnd.toISOString()).toBe(result.periodEnd.toISOString())
    expect(restored.transactions).toHaveLength(1)
    expect(restored.transactions[0]?.amount.toString()).toBe('1234.56')
  })

  it('serialized form is JSON-safe (survives postMessage / sendMessage)', () => {
    const original = makeTx()
    const cloned = JSON.parse(JSON.stringify(serializeTransaction(original)))
    const restored = deserializeTransaction(cloned)
    expect(restored.amount.toString()).toBe('1234.56')
  })
})
