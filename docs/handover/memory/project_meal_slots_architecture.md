---
name: project-meal-slots-architecture
description: Dodatkowe posiłki (II śniadanie, podwieczorek, przekąska) — model danych: sloty per gospodarstwo + suitableMealTypes per przepis.
metadata:
  type: project
---

Decyzja z 22.08.2026 (branch `feat/extra-meal-slots` w obu repach): rozszerzenie planu o dodatkowe posiłki oparto na dwóch osobnych pojęciach, nie na jednym „tagu”.

1. **Które posiłki dom planuje** → `Household.enabledMealTypes` (per gospodarstwo, nie per użytkownik — plan tygodnia i lista zakupów są wspólne). Trójka `BREAKFAST/LUNCH/DINNER` jest nieusuwalna. Zmienia ją każdy domownik, nie tylko OWNER.
2. **Do których pór dnia pasuje danie** → `Recipe.suitableMealTypes` (tablica), obok niezmienionego `Recipe.mealType` (slot bazowy: sekcja, okładka, akcent). Jedna owsianka obsługuje śniadanie i II śniadanie — bez duplikowania przepisu.

Kolejność wartości w enumie `MealType` jest znacząca: Postgres sortuje po definicji, a plan tygodnia porządkuje posiłki przez `ORDER BY "mealType"`. Nowe wartości dokłada się `ALTER TYPE ... ADD VALUE ... BEFORE/AFTER`, nigdy na koniec.

**Wyłączenie slotu nie kasuje posiłków** — Plan i Kalendarz pokazują wyłączony slot, dopóki coś w nim stoi. Ta reguła siedzi w `MealSlotConfiguration.visibleSlots(planned:)`.

Klasyfikacja katalogu (`suitable-meal-types.util.ts` + `pnpm recipes:backfill:slots`) jest zachowawcza. Na 30 przepisach: 9 dopasowań do II śniadania, 3 do przekąski, tylko 2 do podwieczorku — katalogowi brakuje lekkich/słodkich dań pod podwieczorek. Patrz [[project-recipe-macro-convention]] (progi liczą się na porcję).

**Kategorie katalogu ≠ sloty (27.08.2026).** Widok Przepisów ma cztery sekcje, nie sześć: `RecipesCategory.catalogSections` = Śniadania / Obiady / Kolacje / **Przekąski i desery**. Trzy sloty opcjonalne (II śniadanie, podwieczorek, przekąska) schodzą do wspólnej sekcji `.snacks` przez `MealSlot.baseCategory` — tam wylądują przepisy z Thermomixa. Slot bazowy przestał być odtwarzalny z kategorii, więc `Recipe` niesie go osobno (`baseSlot`, czytany przez `primarySlot`). Akcent w planie (`MealSlot.accentColor`) nadal grupuje sloty **porą dnia** — rozjazd z kategorią jest zamierzony. Cache katalogu bumpuje się przy takich zmianach (`recipes_catalog_cache_vN.json`).
