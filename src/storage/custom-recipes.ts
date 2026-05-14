import { type Recipe, parseRecipe } from '@/recipes/_schema'

const STORAGE_KEY = 'afino:custom-recipes'

interface StoredShape {
  [site: string]: Recipe
}

async function load(): Promise<StoredShape> {
  const raw = await chrome.storage.local.get(STORAGE_KEY)
  const value = raw[STORAGE_KEY]
  return isObject(value) ? (value as StoredShape) : {}
}

async function save(map: StoredShape): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEY]: map })
}

export async function listCustomRecipes(): Promise<Recipe[]> {
  return Object.values(await load())
}

export async function findCustomRecipeBySite(site: string): Promise<Recipe | null> {
  const map = await load()
  return map[site] ?? null
}

/** Parses, validates and persists a recipe JSON. Returns the stored recipe. Replaces any prior recipe for the same site. */
export async function importCustomRecipe(rawJson: string): Promise<Recipe> {
  let parsed: unknown
  try {
    parsed = JSON.parse(rawJson)
  } catch (err) {
    throw new Error(`JSON inválido: ${(err as Error).message}`)
  }
  const recipe = parseRecipe(parsed)
  const map = await load()
  map[recipe.site] = recipe
  await save(map)
  return recipe
}

export async function deleteCustomRecipe(site: string): Promise<void> {
  const map = await load()
  if (site in map) {
    delete map[site]
    await save(map)
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}
