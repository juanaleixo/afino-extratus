import { buildCsv } from '@/engine/csv-generator'
import type { ExtractionResult, NormalizedTransaction } from '@/types/transaction'
import Decimal from 'decimal.js'
import { describe, expect, it } from 'vitest'

function tx(over: Partial<NormalizedTransaction> = {}): NormalizedTransaction {
  return {
    fitId: 'f1',
    postedAt: new Date('2026-05-12T16:19:47.000Z'),
    amount: new Decimal('100.50'),
    currency: 'BRL',
    description: 'Pagamento',
    type: 'credit',
    ...over,
  }
}

function res(over: Partial<ExtractionResult> = {}): ExtractionResult {
  const t1 = tx({ fitId: 'a', amount: new Decimal('10.00'), type: 'credit', description: 'Recebido' })
  const t2 = tx({ fitId: 'b', amount: new Decimal('5.50'), type: 'debit', description: 'Pix; "saída"' })
  return {
    account: { id: 'main', name: 'Conta', type: 'checking', currency: 'BRL' },
    transactions: [t1, t2],
    periodStart: new Date('2026-05-01T00:00:00Z'),
    periodEnd: new Date('2026-05-12T00:00:00Z'),
    recipeSite: 'banco.com.br',
    recipeVersion: 1,
    fi: { org: 'Banco' },
    ...over,
  }
}

describe('buildCsv', () => {
  it('inclui header com colunas Afino-friendly e BOM por padrão', () => {
    const csv = buildCsv(res())
    expect(csv.charCodeAt(0)).toBe(0xfeff) // BOM
    expect(csv.split('\r\n')[0]).toContain('Data;Descrição;Valor;Tipo;ID;Conta;Banco;Moeda')
  })

  it('valor com vírgula decimal e sinal por tipo', () => {
    const csv = buildCsv(res())
    expect(csv).toContain(';10,00;Crédito;')
    expect(csv).toContain(';-5,50;Débito;')
  })

  it('escapa campos com separador ou aspas', () => {
    const csv = buildCsv(res())
    expect(csv).toContain('"Pix; ""saída"""')
  })

  it('aceita lista e concatena', () => {
    const r1 = res({ account: { id: 'a', name: 'A', type: 'checking', currency: 'BRL' } })
    const r2 = res({ account: { id: 'b', name: 'B', type: 'savings', currency: 'BRL' } })
    const csv = buildCsv([r1, r2])
    const lines = csv.split('\r\n').filter(Boolean)
    // 1 header + 2 txs * 2 results = 5
    expect(lines).toHaveLength(5)
  })
})
