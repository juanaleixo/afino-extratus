import { type BitacoraMovement, mapBitacoraMovement, parseBitacoraAmount } from '@/engine/bitacora-mapper'
import { describe, expect, it } from 'vitest'

function mov(overrides: Partial<BitacoraMovement> = {}): BitacoraMovement {
  return {
    id: 'mov-1',
    ledger_datetime: '2026-05-12T16:19:47.000Z',
    amount: { fraction: '100', cents: '00', currency_id: 'BRL' },
    title: 'Item',
    metadata: { type: 'in' },
    ...overrides,
  }
}

describe('parseBitacoraAmount', () => {
  it('combines fraction and cents', () => {
    expect(parseBitacoraAmount({ fraction: '100', cents: '50', currency_id: 'BRL' }).toString()).toBe('100.5')
  })

  it('strips thousands separators from fraction', () => {
    expect(parseBitacoraAmount({ fraction: '1.234', cents: '56', currency_id: 'BRL' }).toString()).toBe('1234.56')
  })

  it('preserves negative sign from fraction', () => {
    expect(parseBitacoraAmount({ fraction: '-450', cents: '00', currency_id: 'BRL' }).toString()).toBe('-450')
  })

  it('zero-pads short cents', () => {
    expect(parseBitacoraAmount({ fraction: '5', cents: '5', currency_id: 'BRL' }).toString()).toBe('5.05')
  })

  it('treats empty cents as 00', () => {
    expect(parseBitacoraAmount({ fraction: '10', cents: '', currency_id: 'BRL' }).toString()).toBe('10')
  })

  it('rejects garbage', () => {
    expect(() => parseBitacoraAmount({ fraction: 'abc', cents: '00', currency_id: 'BRL' })).toThrow()
  })
})

describe('mapBitacoraMovement', () => {
  it('preserves the bitacora id as fitId (stable across re-imports)', () => {
    const t = mapBitacoraMovement(mov({ id: 'pix_transfer_mo_payout-abc123' }))
    expect(t.fitId).toBe('pix_transfer_mo_payout-abc123')
  })

  it('parses ledger_datetime as UTC instant', () => {
    const t = mapBitacoraMovement(mov({ ledger_datetime: '2026-05-12T16:19:47.000Z' }))
    expect(t.postedAt.toISOString()).toBe('2026-05-12T16:19:47.000Z')
  })

  it('stores amount as positive Decimal; sign is encoded in type', () => {
    const t = mapBitacoraMovement(
      mov({ amount: { fraction: '-450', cents: '00', currency_id: 'BRL' }, metadata: { type: 'out' } }),
    )
    expect(t.amount.toString()).toBe('450')
    expect(t.type).toBe('debit')
  })

  it('metadata.type "out" → debit, "in" → credit, "income" → credit', () => {
    expect(mapBitacoraMovement(mov({ metadata: { type: 'out' } })).type).toBe('debit')
    expect(mapBitacoraMovement(mov({ metadata: { type: 'in' } })).type).toBe('credit')
    expect(mapBitacoraMovement(mov({ metadata: { type: 'income' } })).type).toBe('credit')
  })

  it('falls back to credit when metadata is missing', () => {
    expect(mapBitacoraMovement(mov({ metadata: undefined })).type).toBe('credit')
  })

  it('prefixes "Rendimento ·" when metadata.recipe is fund-asset_management_gain', () => {
    const t = mapBitacoraMovement(
      mov({ title: 'Rendimentos', metadata: { type: 'income', recipe: 'fund-asset_management_gain' } }),
    )
    expect(t.description).toBe('Rendimento · Rendimentos')
  })

  it('prefixes "Cofrinho ·" when metadata.kind is fund_reallocation', () => {
    const t = mapBitacoraMovement(mov({ title: 'Porquinho', metadata: { type: 'out', kind: 'fund_reallocation' } }))
    expect(t.description).toBe('Cofrinho · Porquinho')
  })

  it('prefixes "Pix ·" when metadata.detail is pix', () => {
    const t = mapBitacoraMovement(
      mov({ title: 'Recebedor', description: 'Pix enviado', metadata: { type: 'out', detail: 'pix' } }),
    )
    expect(t.description).toBe('Pix · Recebedor — Pix enviado')
  })

  it('combines title + description when both present', () => {
    const t = mapBitacoraMovement(mov({ title: 'Mercado Livre', description: 'Compra' }))
    expect(t.description).toContain('Mercado Livre')
    expect(t.description).toContain('Compra')
  })

  it('uses title when description is empty', () => {
    const t = mapBitacoraMovement(mov({ title: 'Sabesp', description: '' }))
    expect(t.description).toBe('Sabesp')
  })

  it('fallback description "(sem descrição)" when both empty', () => {
    const t = mapBitacoraMovement(mov({ title: '', description: '' }))
    expect(t.description).toBe('(sem descrição)')
  })

  it('uses currency_id from amount', () => {
    const t = mapBitacoraMovement(mov({ amount: { fraction: '1', cents: '00', currency_id: 'USD' } }))
    expect(t.currency).toBe('USD')
  })
})
