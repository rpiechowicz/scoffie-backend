/**
 * Generator obrazków przepisów (pollinations). Adres niesie w ścieżce tytuł
 * i opis przepisu, więc dla przepisu DOMU wysyłał prywatną treść do strony
 * trzeciej (audyt 5.09.2026, 2.2.5). Jedna definicja „to jest adres
 * generatora” — dla przepisów (`RecipesService`) i kart asystenta zapisanych
 * w historii rozmów (`withoutGeneratedImages`).
 */
export const DEFAULT_IMAGE_GENERATOR_BASE_URL =
  'https://image.pollinations.ai/prompt';

const GENERATOR_HOST = 'image.pollinations.ai';

/** Baza generatora z env (czytana per wywołanie, jak w `RecipesService`). */
export function imageGeneratorBaseUrl(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return env.IMAGE_GENERATOR_BASE_URL ?? DEFAULT_IMAGE_GENERATOR_BASE_URL;
}

/**
 * Adres pod skonfigurowaną bazą generatora albo na hoście pollinations
 * (adresy utrwalone przy starszej konfiguracji też się liczą).
 */
export function isGeneratedRecipeImageUrl(
  imageUrl: string,
  baseUrl: string = imageGeneratorBaseUrl(),
): boolean {
  const normalized = imageUrl.trim();
  if (!normalized) return false;
  if (normalized.startsWith(`${baseUrl}/`)) return true;
  try {
    return new URL(normalized).hostname === GENERATOR_HOST;
  } catch {
    return false;
  }
}

/**
 * Karta bez adresów generatora obrazków (review 7.10.2026, audyt 2.2.5).
 *
 * Karty asystenta (OPTIONS, PLAN_DAY, PLAN_WEEK, …) leżą w JSON-ie wiadomości
 * i propozycji. Te sprzed 7.10.2026 mogą trzymać adres pollinations z tytułem
 * i opisem przepisu DOMU — telefon pobrałby go przy otwarciu historii.
 * Każde pole `imageUrl` (na dowolnej głębokości) z adresem generatora staje
 * się `null`, czyli „brak zdjęcia” — tak, jak przepis domu bez zdjęcia
 * wygląda dziś wszędzie indziej. Zdjęcia katalogu są pod `img.scoffie.app`
 * i zostają; katalog z adresem generatora — 0 wierszy w lokalnej kopii (7.10.2026) — też
 * traci go na karcie, co jest tylko zaślepką zamiast obrazka.
 *
 * Na ODCZYCIE (historia, propozycje, eksport RODO), a nie migracją JSON-ów:
 * jedna reguła dla wszystkich kształtów kart, także tych zapisanych starszą
 * wersją. Bez zmian = ten sam obiekt (bez kopiowania).
 */
export function withoutGeneratedImages<T>(card: T): T {
  return strip(card) as T;
}

function strip(value: unknown): unknown {
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((item) => {
      const stripped = strip(item);
      if (stripped !== item) changed = true;
      return stripped;
    });
    return changed ? next : value;
  }
  if (value === null || typeof value !== 'object') return value;
  const record = value as Record<string, unknown>;
  let changed = false;
  const next: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(record)) {
    let replaced: unknown;
    if (
      key === 'imageUrl' &&
      typeof field === 'string' &&
      isGeneratedRecipeImageUrl(field)
    ) {
      replaced = null;
    } else {
      replaced = strip(field);
    }
    if (replaced !== field) changed = true;
    next[key] = replaced;
  }
  return changed ? next : value;
}
