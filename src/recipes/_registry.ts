import type { Recipe } from './_schema'
import { mercadopago } from './mercadopago.com.br'

export const recipes: Recipe[] = [mercadopago]

export function findRecipeBySite(site: string): Recipe | null {
  return recipes.find((r) => r.site === site) ?? null
}
