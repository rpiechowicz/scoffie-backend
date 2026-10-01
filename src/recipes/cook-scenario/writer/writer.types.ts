/**
 * System pisania scenariuszy Gotuj (Etap E3, scoffie-ios
 * `docs/workstreams/gotuj/README.md` §7): AI pisze, system decyduje.
 *
 * Przebieg: przepis → prompt → model (Structured Outputs) → walidatory twarde
 * → (błąd: ponów z raportem) → recenzent AI → VALIDATED / REJECTED / SKIPPED.
 * Nic tu nie publikuje — publikacja to osobna, świadoma decyzja
 * (`publishCookScenario`, panel w E3c).
 *
 * Model jest za interfejsem `WriterModel`, żeby przebieg dało się sprawdzić
 * bez sieci, a dostawcę wymienić bez ruszania reguł.
 */

/** Przepis tak, jak widzi go system pisania. */
export interface WriterRecipe {
  id: string;
  title: string;
  description: string | null;
  servings: number;
  mealType: string;
  difficulty: string;
  prepTimeMinutes: number;
  dishType: string | null;
  equipment: string[];
  /** Kroki przepisu (`sourceInstructions`) po kolei. */
  instructions: string[];
  ingredients: WriterIngredient[];
}

export interface WriterIngredient {
  ingredientId: string;
  name: string;
  amount: number;
  unit: string;
  /** Dział katalogu („Mięso”, „Ryby”, „Konserwy”…) — zakres reguł bezpieczeństwa. */
  department?: string | null;
}

/** Wynik jednego wywołania modelu. */
export interface WriterModelResult {
  json: unknown;
  usage: WriterUsage;
  stopReason: string | null;
}

export interface WriterUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Koszt w milionowych częściach dolara. */
  costMicroUsd: number;
  /** `false` = model spoza cennika, koszt policzony po najdroższej stawce. */
  priceKnown: boolean;
}

export interface WriterModelCall {
  model: string;
  effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /** Stała część (zasady, kontrakt, wzorzec) — cache'owana między przepisami. */
  system: string;
  user: string;
  /** JSON Schema odpowiedzi (Structured Outputs). */
  schema: Record<string, unknown>;
  maxTokens: number;
}

export interface WriterModel {
  complete(call: WriterModelCall): Promise<WriterModelResult>;
}

export const ZERO_USAGE: WriterUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costMicroUsd: 0,
  priceKnown: true,
};

export function addUsage(total: WriterUsage, part: WriterUsage): WriterUsage {
  return {
    inputTokens: total.inputTokens + part.inputTokens,
    outputTokens: total.outputTokens + part.outputTokens,
    cacheReadTokens: total.cacheReadTokens + part.cacheReadTokens,
    cacheWriteTokens: total.cacheWriteTokens + part.cacheWriteTokens,
    costMicroUsd: total.costMicroUsd + part.costMicroUsd,
    priceKnown: total.priceKnown && part.priceKnown,
  };
}
