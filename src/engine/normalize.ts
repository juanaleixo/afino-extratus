import type {
  ExtractionResult,
  NormalizedTransaction,
  SerializedExtractionResult,
  SerializedTransaction,
} from '@/types/transaction'
import { fromZonedTime, toZonedTime } from 'date-fns-tz'
import Decimal from 'decimal.js'

export const BR_TIMEZONE = 'America/Sao_Paulo'

/** Parse a "DD/MM/YYYY" string as a date at midnight São Paulo time, returning the UTC instant. */
export function parseBrDate(input: string): Date {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(input.trim())
  if (!match) throw new Error(`Invalid BR date: ${input}`)
  const [, dd, mm, yyyy] = match as unknown as [string, string, string, string]
  const localMidnight = new Date(`${yyyy}-${mm}-${dd}T00:00:00`)
  return fromZonedTime(localMidnight, BR_TIMEZONE)
}

/** Format Date as DD/MM/YYYY in São Paulo time. */
export function formatBrDate(date: Date): string {
  const z = toZonedTime(date, BR_TIMEZONE)
  const pad = (n: number) => n.toString().padStart(2, '0')
  return `${pad(z.getDate())}/${pad(z.getMonth() + 1)}/${z.getFullYear()}`
}

/** Format Date as YYYYMMDDHHMMSS[-3:BRT], the OFX 1.0.2 datetime spec. */
export function formatOfxDateTime(date: Date): string {
  const z = toZonedTime(date, BR_TIMEZONE)
  const pad = (n: number) => n.toString().padStart(2, '0')
  return `${z.getFullYear()}${pad(z.getMonth() + 1)}${pad(z.getDate())}${pad(z.getHours())}${pad(z.getMinutes())}${pad(z.getSeconds())}[-3:BRT]`
}

/** Parse a Brazilian decimal string ("1.234,56" or "R$ 1.234,56") into Decimal. */
export function parseBrAmount(input: string): Decimal {
  const cleaned = input
    .replace(/[^\d,.\-]/g, '')
    .replace(/\./g, '')
    .replace(',', '.')
  if (!cleaned || cleaned === '-') throw new Error(`Invalid BR amount: ${input}`)
  return new Decimal(cleaned)
}

export function serializeTransaction(t: NormalizedTransaction): SerializedTransaction {
  return {
    fitId: t.fitId,
    postedAt: t.postedAt.toISOString(),
    amount: t.amount.toString(),
    currency: t.currency,
    description: t.description,
    type: t.type,
  }
}

export function deserializeTransaction(s: SerializedTransaction): NormalizedTransaction {
  return {
    fitId: s.fitId,
    postedAt: new Date(s.postedAt),
    amount: new Decimal(s.amount),
    currency: s.currency,
    description: s.description,
    type: s.type,
  }
}

export function serializeResult(r: ExtractionResult): SerializedExtractionResult {
  return {
    account: r.account,
    transactions: r.transactions.map(serializeTransaction),
    periodStart: r.periodStart.toISOString(),
    periodEnd: r.periodEnd.toISOString(),
    recipeSite: r.recipeSite,
    recipeVersion: r.recipeVersion,
  }
}

export function deserializeResult(s: SerializedExtractionResult): ExtractionResult {
  return {
    account: s.account,
    transactions: s.transactions.map(deserializeTransaction),
    periodStart: new Date(s.periodStart),
    periodEnd: new Date(s.periodEnd),
    recipeSite: s.recipeSite,
    recipeVersion: s.recipeVersion,
  }
}
