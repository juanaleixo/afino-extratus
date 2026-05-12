import { buildCsv } from '@/engine/csv-generator'
import type { ExtractionResult, NormalizedTransaction } from '@/types/transaction'
import Decimal from 'decimal.js'
import { describe, expect, it } from 'vitest'

function makeResult(transactions: NormalizedTransaction[], accountName = 'Test'): ExtractionResult {
  return {
    account: { id: 'acc', name: accountName, type: 'checking', currency: 'BRL' },
    transactions,
    periodStart: new Date('2026-05-01T00:00:00Z'),
    periodEnd: new Date('2026-05-31T23:59:59Z'),
    recipeSite: 'test.com.br',
    recipeVersion: 1,
  }
}

function tx(overrides: Partial<NormalizedTransaction> = {}): NormalizedTransaction {
  return {
    fitId: 'tx',
    postedAt: new Date('2026-05-01T13:00:00Z'),
    amount: new Decimal('10.00'),
    currency: 'BRL',
    description: 'item',
    type: 'credit',
    ...overrides,
  }
}

describe('buildCsv', () => {
  it('emits the BR header row first (with Conta column)', () => {
    const csv = buildCsv(makeResult([]))
    expect(csv.split('\r\n')[0]).toBe('Data,Descrição,Valor,Moeda,Conta,ID')
  })

  it('uses CRLF line endings between rows', () => {
    const csv = buildCsv(makeResult([tx()]))
    expect(csv.split('\r\n')).toHaveLength(2)
  })

  it('formats values with comma as decimal separator (BR) — and quotes them since they contain commas', () => {
    const csv = buildCsv(makeResult([tx({ amount: new Decimal('1234.56') })]))
    expect(csv).toContain('"1234,56"')
  })

  it('signs debits as negative', () => {
    const csv = buildCsv(makeResult([tx({ type: 'debit', amount: new Decimal('40.00') })]))
    expect(csv).toContain('"-40,00"')
  })

  it('escapes fields containing comma, quote, or newline', () => {
    const csv = buildCsv(makeResult([tx({ description: 'hello, "world"\n2nd line', fitId: 'plain-id' })]))
    expect(csv).toContain('"hello, ""world""\n2nd line"')
    expect(csv).toContain('plain-id')
  })

  it('formats date in BR timezone (DD/MM/YYYY)', () => {
    // 02:00 UTC == 23:00 BRT prev day — make sure we render BR-local day, not UTC.
    const csv = buildCsv(makeResult([tx({ postedAt: new Date('2026-05-01T02:00:00Z') })]))
    expect(csv).toContain('30/04/2026')
  })

  it('preserves Decimal precision (no float drift)', () => {
    const csv = buildCsv(makeResult([tx({ amount: new Decimal('0.10').plus('0.20') })]))
    expect(csv).toContain('"0,30"')
    expect(csv).not.toContain('0,30000')
  })

  it('includes account name in the Conta column', () => {
    const csv = buildCsv(makeResult([tx()], 'Mercado Pago — Conta'))
    expect(csv).toContain('Mercado Pago — Conta')
  })

  it('consolidates multiple ExtractionResults into one file', () => {
    const r1 = makeResult([tx({ fitId: 'a' })], 'Conta')
    const r2 = makeResult([tx({ fitId: 'b' })], 'Cofrinho')
    const csv = buildCsv([r1, r2])
    const lines = csv.split('\r\n')
    expect(lines).toHaveLength(3) // header + 2 rows
    expect(lines[1]).toContain('Conta')
    expect(lines[1]).toContain(',a')
    expect(lines[2]).toContain('Cofrinho')
    expect(lines[2]).toContain(',b')
  })
})
