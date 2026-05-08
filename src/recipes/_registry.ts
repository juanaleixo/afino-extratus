import type { Recipe } from './_schema'
import { mercadopago } from './mercadopago.com.br'

export const recipes: Recipe[] = [mercadopago]

export function findRecipeForUrl(url: URL): Recipe | null {
  return recipes.find((r) => r.match(url)) ?? null
}
