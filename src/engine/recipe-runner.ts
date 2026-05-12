import type { PeriodFilter, Recipe } from '@/recipes/_schema'
import type { ExtractionResult, RecipeOutput } from '@/types/transaction'

export interface RunRecipeOptions {
  recipe: Recipe
  fetch: typeof fetch
  period?: PeriodFilter
}

export async function runRecipe(opts: RunRecipeOptions): Promise<ExtractionResult[]> {
  const { recipe, fetch, period } = opts

  const outputs = await recipe.extract({ fetch, period })
  const populated = outputs.filter((o) => o.transactions.length > 0)
  if (populated.length === 0) {
    throw new Error('Nenhuma transação encontrada — verifique se está logado no banco e tem movimento no período')
  }

  return populated.map((output) => finalizeResult(output, recipe))
}

function finalizeResult(output: RecipeOutput, recipe: Recipe): ExtractionResult {
  const times = output.transactions.map((t) => t.postedAt.getTime())
  return {
    account: output.account,
    transactions: output.transactions,
    periodStart: new Date(Math.min(...times)),
    periodEnd: new Date(Math.max(...times)),
    recipeSite: recipe.site,
    recipeVersion: recipe.version,
  }
}
