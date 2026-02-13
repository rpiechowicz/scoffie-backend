import { Injectable } from '@nestjs/common';

type CacheEntry<T> = {
  value: T;
  expiresAt: number;
};

@Injectable()
export class RecipesCacheService {
  private readonly store = new Map<string, CacheEntry<unknown>>();
  private readonly recipesListPrefix = 'recipes:list:';

  private readonly enabled = process.env.RECIPES_LIST_CACHE_ENABLED !== 'false';
  private readonly ttlSeconds = Number.parseInt(process.env.RECIPES_LIST_CACHE_TTL_SECONDS ?? '90', 10);

  private now(): number {
    return Date.now();
  }

  get<T>(key: string): T | null {
    if (!this.enabled) return null;
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= this.now()) {
      this.store.delete(key);
      return null;
    }
    return entry.value as T;
  }

  set<T>(key: string, value: T): void {
    if (!this.enabled) return;
    const ttlMs = Math.max(1, this.ttlSeconds) * 1000;
    this.store.set(key, {
      value,
      expiresAt: this.now() + ttlMs,
    });
  }

  buildRecipesListKey(input: {
    userId: string;
    householdId?: string;
    mealType?: string;
    isFavorite?: boolean;
    page: number;
    limit: number;
  }): string {
    const householdPart = input.householdId ?? 'all-households';
    const mealTypePart = input.mealType ?? 'all-meals';
    const favoritePart = typeof input.isFavorite === 'boolean' ? String(input.isFavorite) : 'all-favorites';
    return `${this.recipesListPrefix}${input.userId}:${householdPart}:${mealTypePart}:${favoritePart}:${input.page}:${input.limit}`;
  }

  invalidateRecipesList(): void {
    if (!this.enabled) return;
    for (const key of this.store.keys()) {
      if (key.startsWith(this.recipesListPrefix)) {
        this.store.delete(key);
      }
    }
  }
}

