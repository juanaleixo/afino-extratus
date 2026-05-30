/**
 * Shared helpers for PDF plugins.
 *
 * `parseBrAmount` lives in `@/engine/normalize` and already returns `Decimal` — we re-export
 * it so plugins import a single namespace, but the canonical implementation stays in engine/.
 */

export { parseBrAmount } from '@/engine/normalize'

/** Portuguese month abbreviations → 01..12. Keys are lowercase, no trailing dot. */
export const PT_MONTHS: Readonly<Record<string, string>> = {
  jan: '01',
  fev: '02',
  mar: '03',
  abr: '04',
  mai: '05',
  jun: '06',
  jul: '07',
  ago: '08',
  set: '09',
  out: '10',
  nov: '11',
  dez: '12',
}

/**
 * Build a São Paulo-midnight `Date` from numeric YYYY/MM/DD strings.
 *
 * We don't reuse `parseBrDate` here because the PDF plugins already split day/month/year out
 * of free-form text — going through a string round-trip would just lose precision and reintroduce
 * format-parsing bugs.
 */
export function brDateFromParts(yyyy: string, mm: string, dd: string): Date {
  const localMidnight = `${yyyy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}T00:00:00-03:00`
  const d = new Date(localMidnight)
  if (Number.isNaN(d.getTime())) {
    throw new Error(`Invalid date parts: ${yyyy}-${mm}-${dd}`)
  }
  return d
}

/**
 * Stable 32-bit DJB2 hash, hex-encoded. Same algorithm used by the OFX normalizer for
 * synthetic FITIDs — keeps the import flow predictable across formats.
 */
export function djb2(input: string): string {
  let hash = 5381
  for (let i = 0; i < input.length; i++) {
    hash = ((hash << 5) + hash + input.charCodeAt(i)) | 0
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}
