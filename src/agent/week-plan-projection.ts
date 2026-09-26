/**
 * Plan tygodnia w kształcie dla MODELU — wspólny dla `get_week_plan`,
 * potwierdzenia zapisu i bloku gospodarstwa w prompcie. Jedna projekcja,
 * bo ten sam tydzień nie może wyglądać inaczej zależnie od tego, którędy
 * model go dostał.
 */

/**
 * Jedna pozycja planu w kształcie, który MODEL naprawdę wykorzystuje.
 *
 * Pola nieobowiązkowe znikają, gdy nic nie znaczą (`participants` przy
 * posiłku dla całego domu, `eatenCount` przy zerze) — przy 21 pozycjach
 * każde puste pole to kilkaset tokenów za nic.
 */
export type WeekPlanItemForModel = {
  dayOfWeek: string;
  mealType: string;
  /** `R07` dla katalogu, `recipeId` dla przepisu gospodarstwa. */
  recipe: string;
  title: string;
  kcalPerServing: number;
  prepTimeMinutes: number;
  plannedServings: number;
  /** Identyfikatory osób, które model MOŻE zobaczyć (mają zgodę). */
  participants?: string[];
  /** Ilu jedzących nie ma zgody — sama liczność, bez tożsamości. */
  othersCount?: number;
  /** Ile osób odhaczyło ten posiłek jako zjedzony. */
  eatenCount?: number;
  /**
   * Porcje per osoba (Etap 2.2): `userId → porcje`, tylko osoby ze zgodą;
   * brak pola = równy podział `plannedServings`.
   */
  portions?: Record<string, number>;
};

export type WeekPlanForModel = {
  weekStart: string;
  items: WeekPlanItemForModel[];
};

/** Wiersz planu w kształcie, w jakim oddaje go `WeeklyPlansService`. */
export type PlanItemForProjection = {
  dayOfWeek: string;
  mealType: string;
  recipeId: string;
  plannedServings: number;
  participantIds: string[];
  eatenByUserIds: string[];
  portions?: { userId: string; servings: number }[];
  recipe: {
    title: string;
    servings: number | null;
    prepTimeMinutes: number | null;
    nutritionKcal: number | null;
  };
};

/**
 * Plan tygodnia PRZEŁOŻONY dla modelu — projekcja, nie model domenowy.
 *
 * DLACZEGO W OGÓLE. `get_week_plan` oddawał modelowi dokładnie to, co dostaje
 * iOS: pełne `RecipeIngredient` każdego dania, `imageUrl`, `authorId`,
 * `householdId`, `createdAt`, `updatedAt`. Zmierzone na katalogu dev: 93 965
 * bajtów, czyli ~33 tys. tokenów na JEDEN tydzień — więcej niż cały digest
 * katalogu, i to w KAŻDEJ turze, która zajrzy do planu. Model nie użył z tego
 * ani jednego pola: składy zna z digestu, a zdjęcia i identyfikatory autora
 * nie mają jak wpłynąć na dobór dania.
 *
 * DLACZEGO TUTAJ, A NIE W SERWISIE. `WeeklyPlansService` i `PLAN_ITEM_INCLUDE`
 * zostają nietknięte: iOS renderuje z nich ekran planu i potrzebuje pełnego
 * kształtu. To jest granica asystenta, więc i miejsce na zawężenie.
 *
 * PRYWATNOŚĆ. `participantIds` i `eatenByUserIds` niosły UUID-y WSZYSTKICH
 * domowników — także tych, którzy nie wyrazili zgody na asystenta, a więc
 * tych, których nie ma nawet w `get_household_context`. Przepuszczamy więc
 * tylko identyfikatory osób ze zgodą (model i tak je zna i musi móc ich użyć
 * przy zapisie); resztę zwijamy do LICZBY. Liczba wystarcza do porcji i do
 * zdania „ta kolacja jest dla dwóch osób", a nie mówi, dla kogo. Aliasu
 * (`anon-1`) świadomie NIE wprowadzamy: byłby nowym systemem identyfikatorów,
 * który albo da się rozwiązać z powrotem na osobę — i wtedy jest obejściem
 * zgody — albo się nie da, i wtedy model traci rundę na odesłanie go do
 * walidacji audytorium.
 */
export function projectWeekPlanForModel(
  plan: { weekStart: string; items: PlanItemForProjection[] },
  /** `recipeId` → `R07`; pozycje spoza katalogu zostają przy własnym id. */
  refByRecipeId: Map<string, string>,
  /** Kogo model może zobaczyć po identyfikatorze (zgoda `AI_ASSISTANT`). */
  visibleUserIds: ReadonlySet<string>,
): WeekPlanForModel {
  return {
    weekStart: plan.weekStart,
    items: plan.items.map((item) => {
      const servings = Math.max(1, item.recipe.servings ?? 1);
      const widoczni = item.participantIds.filter((userId) =>
        visibleUserIds.has(userId),
      );
      const ukryci = item.participantIds.length - widoczni.length;
      const eaten = item.eatenByUserIds.length;
      return {
        dayOfWeek: item.dayOfWeek,
        mealType: item.mealType,
        // Indeks katalogu, a nie UUID: to samo, czym model mówi w każdym
        // innym narzędziu, i 20 tokenów taniej na pozycję. Przepis
        // gospodarstwa indeksu nie ma, więc idzie własnym identyfikatorem —
        // `resolveRecipeRef` przepuszcza go bez zmian.
        recipe: refByRecipeId.get(item.recipeId) ?? item.recipeId,
        title: item.recipe.title,
        // Na PORCJĘ, jak w digeście: w bazie makro opisuje cały przepis, a
        // model i użytkownik myślą porcjami.
        kcalPerServing: Math.round((item.recipe.nutritionKcal ?? 0) / servings),
        prepTimeMinutes: item.recipe.prepTimeMinutes ?? 0,
        plannedServings: item.plannedServings,
        // Puste audytorium znaczy „całe gospodarstwo" i tak jest opisane
        // w prompcie — brak pola niesie tu tę samą informację, co pusta lista.
        ...(widoczni.length > 0 ? { participants: widoczni } : {}),
        ...(ukryci > 0 ? { othersCount: ukryci } : {}),
        ...(eaten > 0 ? { eatenCount: eaten } : {}),
        ...portionsFor(item.portions, visibleUserIds),
      };
    }),
  };
}

/** Porcje osób ze zgodą — domownik bez zgody nie pojawia się z identyfikatorem. */
function portionsFor(
  portions: PlanItemForProjection['portions'],
  visibleUserIds: ReadonlySet<string>,
): { portions?: Record<string, number> } {
  const visible = (portions ?? []).filter((portion) =>
    visibleUserIds.has(portion.userId),
  );
  return visible.length > 0
    ? {
        portions: Object.fromEntries(
          visible.map((portion) => [portion.userId, portion.servings]),
        ),
      }
    : {};
}
