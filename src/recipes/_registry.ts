import { findCustomRecipeBySite, listCustomRecipes } from '@/storage/custom-recipes'
import { type Recipe, parseRecipe } from './_schema'
import inter from './inter.co.json'
import mercadopago from './mercadopago.com.br.json'
import rico from './rico.com.vc.json'

/** Built-in recipes shipped with the extension. Parsed once at module load to fail fast on schema drift. */
export const builtInRecipes: Recipe[] = [parseRecipe(mercadopago), parseRecipe(rico), parseRecipe(inter)]

export interface RecipeWithSource {
  recipe: Recipe
  source: 'built-in' | 'custom'
}

/** Returns built-in + custom recipes. Custom recipes override built-ins on conflicting `site`. */
export async function listAllRecipes(): Promise<RecipeWithSource[]> {
  const custom = await listCustomRecipes()
  const customSites = new Set(custom.map((r) => r.site))
  const builtIn = builtInRecipes
    .filter((r) => !customSites.has(r.site))
    .map((recipe) => ({ recipe, source: 'built-in' as const }))
  return [...custom.map((recipe) => ({ recipe, source: 'custom' as const })), ...builtIn]
}

export async function findRecipeBySite(site: string): Promise<Recipe | null> {
  const custom = await findCustomRecipeBySite(site)
  if (custom) return custom
  return builtInRecipes.find((r) => r.site === site) ?? null
}
