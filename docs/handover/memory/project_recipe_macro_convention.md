---
name: project-recipe-macro-convention
description: Konwencja liczenia makro przepisów w Scoffie — całość vs porcja, węgle bez błonnika, tabela per-100 g jako źródło prawdy.
metadata:
  type: project
---

`Recipe.nutrition*` w bazie to wartości dla CAŁEGO przepisu (wszystkich porcji); iOS dzieli przez `servings` w `Recipe.nutritionPerServing`. Makro liczy się ze składników, nie wpisuje z ręki — źródłem prawdy są wartości per 100 g / 100 ml w `prisma/catalog/ingredient-nutrition-pl-v1.json`, wgrywane do kolumn `Ingredient.nutrition*Per100` + `gramsPerPiece`.

Ustalenia z audytu 2026-08-20, których nie widać z kodu:

- węglowodany są **przyswajalne, bez błonnika** (konwencja IŻŻ), błonnik osobno
- makaron i ryż liczone jako **sucha masa**
- olej i oliwa: 810 kcal / 100 **ml** (gęstość 0,92 g/ml), nie 900
- masy sztuk: jajko 50 g, banan 120 g, awokado 150 g, ząbek czosnku 3 g, tortilla 60 g
- sól świadomie poza zakresem audytu — `nutritionSalt` nie było przeliczane

**Why:** pierwsza baza 30 przepisów miała makro zgadnięte z zakotwiczeniem na ~400 kcal/porcję; mediana odchyłki od realnych składników wynosiła +43%, skrajność +87%, białko zaniżone o 50-70% w niemal każdym przepisie.

**How to apply:** przed zmianą makro puść `pnpm audit:recipes:nutrition` (kod wyjścia 1 = coś poza progiem 10%). Poprawki rób przez `pnpm recipes:recompute:nutrition -- --write`, nigdy ręcznie — skrypt zapisuje i do bazy, i do plików w `prisma/catalog/`, bo sama baza cofnęłaby się przy najbliższym imporcie. Powiązane: [[project-scoffie-stack]], [[project-mac-resources-exhausted]].
