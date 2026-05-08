import type { Recipe } from '@/recipes/_schema'
import type { ExtractionResult } from '@/types/transaction'

export interface RunRecipeOptions {
  recipe: Recipe
  document: Document
  window: Window
}

export async function runRecipe(opts: RunRecipeOptions): Promise<ExtractionResult> {
  const { recipe, document, window } = opts
  const ctx = { document, window }

  const account = recipe.detectAccount(ctx)
  if (!account) throw new Error(`Não foi possível identificar a conta em ${recipe.site}`)

  const transactions = await recipe.extract(ctx)
  if (transactions.length === 0) {
    throw new Error('Nenhuma transação encontrada na página atual')
  }

  const dates = transactions.map((t) => t.postedAt.getTime())
  const periodStart = new Date(Math.min(...dates))
  const periodEnd = new Date(Math.max(...dates))

  return {
    account,
    transactions,
    periodStart,
    periodEnd,
    recipeSite: recipe.site,
    recipeVersion: recipe.version,
  }
}
