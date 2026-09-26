import { Injectable } from '@nestjs/common';

type CacheEntry<T> = {
  value: T;
  expiresAt: number;
};

@Injectable()
export class RecipesCacheService {
  private readonly store = new Map<string, CacheEntry<unknown>>();
  private readonly recipesListPrefix = 'recipes:list:';
  private hits = 0;
  private misses = 0;

  private readonly enabled = process.env.RECIPES_LIST_CACHE_ENABLED !== 'false';
  private readonly ttlSeconds = Number.parseInt(
    process.env.RECIPES_LIST_CACHE_TTL_SECONDS ?? '90',
    10,
  );
  /**
   * Sufit wpisów: wygasłe znikały dotąd tylko przy odczycie TEGO SAMEGO
   * klucza, więc bez zmian w katalogu mapa rosła po jednym wpisie na
   * (dom × posiłek × strona) w nieskończoność.
   */
  private readonly maxEntries = Math.max(
    1,
    Number.parseInt(process.env.RECIPES_LIST_CACHE_MAX_ENTRIES ?? '500', 10) ||
      500,
  );

  private now(): number {
    return Date.now();
  }

  get<T>(key: string): T | null {
    if (!this.enabled) return null;
    const entry = this.store.get(key);
    if (!entry) {
      this.misses += 1;
      return null;
    }
    if (entry.expiresAt <= this.now()) {
      this.store.delete(key);
      this.misses += 1;
      return null;
    }
    this.hits += 1;
    return entry.value as T;
  }

  set<T>(key: string, value: T): void {
    if (!this.enabled) return;
    const ttlMs = Math.max(1, this.ttlSeconds) * 1000;
    if (this.store.size >= this.maxEntries) this.prune();
    this.store.set(key, {
      value,
      expiresAt: this.now() + ttlMs,
    });
  }

  /** Najpierw wygasłe; gdy to nie wystarcza — najstarsze wpisy (Map trzyma kolejność wstawiania). */
  private prune(): void {
    const now = this.now();
    for (const [key, entry] of this.store) {
      if (entry.expiresAt <= now) this.store.delete(key);
    }
    while (this.store.size >= this.maxEntries) {
      const oldest = this.store.keys().next().value;
      if (oldest === undefined) break;
      this.store.delete(oldest);
    }
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
    const favoritePart =
      typeof input.isFavorite === 'boolean'
        ? String(input.isFavorite)
        : 'all-favorites';
    return `${this.recipesListPrefix}${input.userId}:${householdPart}:${mealTypePart}:${favoritePart}:${input.page}:${input.limit}`;
  }

  /**
   * Bez argumentu — cała lista (zmiana KATALOGU: panel, import). Z domem —
   * tylko jego wpisy (zmiana przepisu gospodarstwa, Etap 4B): wspólne wpisy
   * katalogu (`all-households`) i listy innych domów zostają.
   */
  invalidateRecipesList(householdId?: string): void {
    if (!this.enabled) return;
    const marker = householdId ? `:${householdId}:` : null;
    for (const key of this.store.keys()) {
      if (!key.startsWith(this.recipesListPrefix)) continue;
      if (marker === null || key.includes(marker)) {
        this.store.delete(key);
      }
    }
  }

  stats() {
    return {
      enabled: this.enabled,
      ttlSeconds: this.ttlSeconds,
      maxEntries: this.maxEntries,
      size: this.store.size,
      hits: this.hits,
      misses: this.misses,
      hitRate:
        this.hits + this.misses > 0
          ? Number((this.hits / (this.hits + this.misses)).toFixed(4))
          : 0,
    };
  }
}
