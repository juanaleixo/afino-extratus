import { PdfNormalizeError, normalizePdf } from '@/parsers/pdf/normalizer'
import { nubankCartao } from '@/parsers/pdf/plugins/nubank-cartao'
import { PdfPluginNotDetectedError, detectAndParse } from '@/parsers/pdf/registry'
import { describe, expect, it } from 'vitest'

/**
 * Fixtures here mirror the text pdfjs produces from a real Nubank fatura PDF. We don't ship
 * actual PDF binaries in the repo (the binary→text step belongs to `extractor.ts`, which is
 * thin and exercised at runtime); instead we feed the post-extraction text directly so the
 * plugin's regex layer is what's actually under test.
 */

const FATURA_HEADER = 'FATURA 10 MAR 2026'

function fatura(body: string[]): string {
  return [
    FATURA_HEADER,
    'CNPJ 18.236.120/0001-58',
    'Nu Pagamentos S.A.',
    '',
    'TRANSAÇÕES DE 10 FEV 2026 A 09 MAR 2026',
    ...body,
  ].join('\n')
}

describe('nubankCartao.detect', () => {
  it('matches by CNPJ', () => {
    expect(nubankCartao.detect('Algum texto\nCNPJ 18.236.120/0001-58\nblah')).toBe(true)
  })

  it('matches by issuer name', () => {
    expect(nubankCartao.detect('Nu Pagamentos S.A.')).toBe(true)
  })

  it('matches by trademark', () => {
    expect(nubankCartao.detect('Sua fatura nubank de março')).toBe(true)
  })

  it('rejects unrelated text', () => {
    expect(nubankCartao.detect('Fatura Itaucard')).toBe(false)
  })
})

describe('nubankCartao.parse — same-line transactions', () => {
  it('parses a single debit and credit', () => {
    const text = fatura(['15 FEV Netflix R$ 49,90', '20 FEV Pagamento recebido −R$ 200,00'])
    const txs = nubankCartao.parse(text)
    expect(txs).toHaveLength(2)
    const [netflix, pagamento] = txs
    if (!netflix || !pagamento) throw new Error('unreachable')
    expect(netflix.type).toBe('debit')
    expect(netflix.description).toBe('Netflix')
    expect(netflix.amount.toString()).toBe('49.9')
    expect(netflix.postedAt.toISOString()).toBe('2026-02-15T03:00:00.000Z')

    expect(pagamento.type).toBe('credit')
    expect(pagamento.description).toBe('Pagamento recebido')
    expect(pagamento.amount.toString()).toBe('200')
  })

  it('extracts year from FATURA header', () => {
    const text = ['FATURA 03 MAI 2025', 'Nu Pagamentos', 'TRANSAÇÕES DE', '01 ABR Spotify R$ 21,90'].join('\n')
    const [tx] = nubankCartao.parse(text)
    if (!tx) throw new Error('unreachable')
    expect(tx.postedAt.toISOString()).toBe('2025-04-01T03:00:00.000Z')
  })

  it('detects installment marker in description', () => {
    const text = fatura(['10 FEV Marketplace parcela 03/12 R$ 99,90'])
    const [tx] = nubankCartao.parse(text)
    if (!tx) throw new Error('unreachable')
    expect(tx.installment).toEqual({ current: 3, total: 12 })
  })

  it('skips category headers and holder totals', () => {
    const text = fatura([
      'Mercado R$ 234,56', // category header
      '15 FEV Mercado Pão R$ 49,90',
      'Joao da Silva R$ 1.234,56', // holder total
      '16 FEV Padaria R$ 12,00',
    ])
    const txs = nubankCartao.parse(text)
    expect(txs.map((t) => t.description)).toEqual(['Mercado Pão', 'Padaria'])
  })

  it('skips known noise lines (USD, Conversão, Saldo restante, page numbers)', () => {
    const text = fatura([
      '15 FEV Uber R$ 25,00',
      'USD 5.00',
      'Conversão: 5.00 USD',
      '1 de 3',
      'Saldo restante R$ 0,00',
      '16 FEV iFood R$ 40,00',
    ])
    const txs = nubankCartao.parse(text)
    expect(txs.map((t) => t.description)).toEqual(['Uber', 'iFood'])
  })

  it('discards zero-value lines', () => {
    const text = fatura(['15 FEV Estorno integral R$ 0,00'])
    const txs = nubankCartao.parse(text)
    expect(txs).toHaveLength(0)
  })
})

describe('nubankCartao.parse — international (amount on next line)', () => {
  it('captures amount within 4-line lookahead', () => {
    const text = fatura(['15 FEV AWS Amazon Web Services', 'USD 12,50', 'Conversão: 5,42', 'R$ 67,80'])
    const txs = nubankCartao.parse(text)
    expect(txs).toHaveLength(1)
    const tx = txs[0]
    if (!tx) throw new Error('unreachable')
    expect(tx.description).toBe('AWS Amazon Web Services')
    expect(tx.amount.toString()).toBe('67.8')
    expect(tx.type).toBe('debit')
  })

  it('captures credit amount on next line', () => {
    const text = fatura(['15 FEV Estorno internacional', '−R$ 50,00'])
    const [tx] = nubankCartao.parse(text)
    if (!tx) throw new Error('unreachable')
    expect(tx.type).toBe('credit')
    expect(tx.amount.toString()).toBe('50')
  })

  it('stops lookahead when next transaction starts', () => {
    const text = fatura(['15 FEV Compra orfan sem valor', '16 FEV Outra compra R$ 10,00'])
    const txs = nubankCartao.parse(text)
    expect(txs).toHaveLength(1)
    expect(txs[0]?.description).toBe('Outra compra')
  })
})

describe('detectAndParse (registry)', () => {
  it('picks the Nubank plugin and parses', () => {
    const text = fatura(['15 FEV Padaria R$ 12,00'])
    const outcome = detectAndParse(text)
    expect(outcome.plugin.id).toBe('nubank-cartao')
    expect(outcome.transactions).toHaveLength(1)
  })

  it('throws PdfPluginNotDetectedError for unknown banks', () => {
    expect(() => detectAndParse('Fatura Itaucard 03/2026\n01/03 Loja R$ 50,00')).toThrow(PdfPluginNotDetectedError)
  })
})

describe('normalizePdf', () => {
  it('produces an ExtractionResult with stable FITIDs and credit_card account', () => {
    const text = fatura(['15 FEV Netflix R$ 49,90', '20 FEV Padaria R$ 8,50', '25 FEV Pagamento recebido −R$ 200,00'])
    const result = normalizePdf(detectAndParse(text), { filename: 'nubank-fatura-marco.pdf' })
    expect(result.account.type).toBe('credit_card')
    expect(result.account.bankId).toBe('18236120')
    expect(result.fi).toEqual({ org: 'Nu Pagamentos', fid: '18236120' })
    expect(result.transactions).toHaveLength(3)
    // FITIDs follow the convention `pdf-<pluginId>-<hash>-<index>`
    expect(result.transactions[0]?.fitId).toMatch(/^pdf-nubank-cartao-[0-9a-f]{8}-0$/)
    expect(result.transactions[2]?.fitId).toMatch(/^pdf-nubank-cartao-[0-9a-f]{8}-2$/)

    // Re-importing the same input ⇒ same fitId
    const result2 = normalizePdf(detectAndParse(text), { filename: 'nubank-fatura-marco.pdf' })
    expect(result2.transactions[0]?.fitId).toBe(result.transactions[0]?.fitId)
  })

  it('throws when the plugin returned no transactions', () => {
    // Plugin detects but parses zero (TRANSAÇÕES DE marker absent)
    const text = ['Nu Pagamentos S.A.', 'FATURA 10 MAR 2026', 'sem transações reconhecíveis'].join('\n')
    expect(() => normalizePdf(detectAndParse(text), { filename: 'a.pdf' })).toThrow(PdfNormalizeError)
  })
})
