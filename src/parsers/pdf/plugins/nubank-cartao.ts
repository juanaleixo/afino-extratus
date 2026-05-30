/**
 * Nubank cartão de crédito — fatura em PDF.
 *
 * Logic ported from `tio-ze-rj/banksheet` (MIT), `packages/core/src/plugins/BR/nubank-cartao`.
 * Key adaptations for Extratus:
 *   - Amounts as `Decimal` (engine invariant), not `number`.
 *   - Dates as `Date` (UTC instant at São Paulo midnight), not ISO strings.
 *   - Direction explicit on the raw transaction (banksheet used signed numbers).
 *   - Year resolution is identical: extracted from "FATURA DD MMM YYYY" header; falls back to
 *     the current year (the banksheet behavior we inherit, with the same caveat for re-imports
 *     of old statements).
 */

import type { PdfPlugin, RawPdfTransaction } from '../types'
import { PT_MONTHS, brDateFromParts, parseBrAmount } from '../utils'

// Hoisted regexes — compiled once at module load (banksheet pattern).
const TXN_DATE_RE = /^(\d{1,2})\s+([A-Za-zçÇ]{3})\s+(.+)/
const FATURA_YEAR_RE = /FATURA\s+\d{1,2}\s+[A-Za-zçÇ]{3}\s+(\d{4})/
// "Pagamento −R$ 1.234,56" — credit (the minus uses unicode U+2212).
const CREDIT_RE = /^(.+?)\s*[−-]R\$\s*([\d.,]+)\s*$/
// "Mercado R$ 49,90" — debit (default direction for cartão).
const DEBIT_RE = /^(.+?)\s+R\$\s*([\d.,]+)\s*$/
// International purchases sometimes land amount on the next line.
const NEXT_CREDIT_RE = /^[−-]R\$\s*([\d.,]+)\s*$/
const NEXT_DEBIT_RE = /^R\$\s*([\d.,]+)\s*$/
const PAGE_BREAK_RE = /^--- PAGE BREAK ---/
// Category summary line: "Mercado R$ 234,56" (sub-total per category).
const CATEGORY_HEADER_RE = /^[A-ZÁÀÃÂÉÊÍÓÔÕÚÇ][a-záàãâéêíóôõúç\s]+[-−]?R\$\s*[\d.,]+$/
// Card-holder total: "Joao da Silva R$ 1.234,56" (sub-total per holder on family plans).
const HOLDER_TOTAL_RE = /^[A-Z][a-zA-ZÁÀÃÂÉÊÍÓÔÕÚÇáàãâéêíóôõúç\s]+R\$\s*[\d.,]+$/
// Optional installment marker in the description: "Loja parcela 02/12".
const INSTALLMENT_RE = /(\d{1,2})\/(\d{1,2})/

const SKIP_PATTERNS = [
  /^USD\s/i,
  /^Conversão:/i,
  /^Saldo restante/i,
  /^Em cumprimento/i,
  /^Como assegurado/i,
  /^\d+\s+de\s+\d+$/,
]

export const nubankCartao: PdfPlugin = {
  id: 'nubank-cartao',
  label: 'Nubank — Cartão de crédito',
  country: 'BR',
  accountType: 'credit_card',
  bank: { id: '18236120', org: 'Nu Pagamentos' },

  detect(text: string): boolean {
    return /Nu\s*Pagamentos\s*S\.?A\.?/i.test(text) || /CNPJ\s*18\.236\.120/i.test(text) || /nubank/i.test(text)
  },

  parse(text: string): RawPdfTransaction[] {
    const lines = text.split('\n').map((l) => l.trim())

    const yearMatch = text.match(FATURA_YEAR_RE)
    const year = yearMatch?.[1] ?? String(new Date().getFullYear())

    const startIdx = lines.findIndex((l) => /^TRANSAÇÕES DE/i.test(l))
    if (startIdx === -1) return []

    const transactions: RawPdfTransaction[] = []
    let i = startIdx + 1
    while (i < lines.length) {
      const line = lines[i]
      if (!line) {
        i++
        continue
      }
      if (SKIP_PATTERNS.some((p) => p.test(line))) {
        i++
        continue
      }
      if (PAGE_BREAK_RE.test(line)) {
        i++
        continue
      }

      const dateMatch = line.match(TXN_DATE_RE)
      // Category headers / holder totals look transaction-ish without a real date — skip them.
      if (!dateMatch) {
        if (HOLDER_TOTAL_RE.test(line) || CATEGORY_HEADER_RE.test(line)) {
          i++
          continue
        }
        i++
        continue
      }

      const day = dateMatch[1] as string
      const monthAbbr = (dateMatch[2] as string).toLowerCase().replace('.', '')
      const rest = dateMatch[3] as string
      const month = PT_MONTHS[monthAbbr]
      if (!month) {
        i++
        continue
      }

      let postedAt: Date
      try {
        postedAt = brDateFromParts(year, month, day)
      } catch {
        i++
        continue
      }

      if (/Saldo restante/i.test(rest)) {
        i++
        continue
      }

      // Same-line credit (payment): "Description −R$ AMOUNT"
      const creditMatch = rest.match(CREDIT_RE)
      if (creditMatch) {
        const desc = (creditMatch[1] as string).trim()
        const amount = parseBrAmount(creditMatch[2] as string)
        if (amount.isZero()) {
          i++
          continue
        }
        transactions.push({
          postedAt,
          description: desc,
          amount: amount.abs(),
          type: 'credit',
          installment: parseInstallment(desc),
          raw: line,
        })
        i++
        continue
      }

      // Same-line debit: "Description R$ AMOUNT"
      const debitMatch = rest.match(DEBIT_RE)
      if (debitMatch) {
        const desc = (debitMatch[1] as string).trim()
        const amount = parseBrAmount(debitMatch[2] as string)
        if (amount.isZero()) {
          i++
          continue
        }
        transactions.push({
          postedAt,
          description: desc,
          amount: amount.abs(),
          type: 'debit',
          installment: parseInstallment(desc),
          raw: line,
        })
        i++
        continue
      }

      // International purchases: description on this line, amount in the next 1–4 lines.
      const description = rest.trim()
      let foundAmount = false

      for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
        const nextLine = lines[j] ?? ''
        if (!nextLine || SKIP_PATTERNS.some((p) => p.test(nextLine))) continue

        const nextCreditMatch = nextLine.match(NEXT_CREDIT_RE)
        if (nextCreditMatch) {
          const amount = parseBrAmount(nextCreditMatch[1] as string)
          if (!amount.isZero()) {
            transactions.push({
              postedAt,
              description,
              amount: amount.abs(),
              type: 'credit',
              installment: parseInstallment(description),
              raw: line,
            })
          }
          i = j + 1
          foundAmount = true
          break
        }

        const nextDebitMatch = nextLine.match(NEXT_DEBIT_RE)
        if (nextDebitMatch) {
          const amount = parseBrAmount(nextDebitMatch[1] as string)
          if (!amount.isZero()) {
            transactions.push({
              postedAt,
              description,
              amount: amount.abs(),
              type: 'debit',
              installment: parseInstallment(description),
              raw: line,
            })
          }
          i = j + 1
          foundAmount = true
          break
        }

        if (TXN_DATE_RE.test(nextLine)) break
      }

      if (!foundAmount) {
        i++
      }
    }

    return transactions
  },
}

function parseInstallment(description: string): { current: number; total: number } | undefined {
  const m = description.match(INSTALLMENT_RE)
  if (!m) return undefined
  const current = Number.parseInt(m[1] as string, 10)
  const total = Number.parseInt(m[2] as string, 10)
  if (!Number.isFinite(current) || !Number.isFinite(total)) return undefined
  if (current < 1 || total < current || total > 99) return undefined
  return { current, total }
}
