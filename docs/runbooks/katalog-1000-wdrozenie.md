# Katalog 1000 — wdrożenie na produkcję

Stan repo (28.09.2026): `prisma/catalog/recipes-catalog-full-v2.json` ma 1072 przepisy
(500 dotychczasowych + 572 z partii katalogu 1000, klucze w `katalog-1000-lista.md`),
51 nowych składników (48 z #243 + 3 z partii) i taksonomię oraz cukry/nasycone dla wszystkich.
Baza produkcji jest źródłem prawdy (D1), więc nowe przepisy i składniki trzeba do niej
WCZYTAĆ — migracje tego nie robią (wstawiają wyłącznie UPDATE-y istniejących wierszy).

## Kolejność (po wdrożeniu `develop` → `main`, tylko z jawnym „tak” Rafała)

Migracje `20260928120000…`–`20260928140100…` wchodzą same przy starcie kontenera
(taksonomia i cukry dla 500 istniejących przepisów i 421 składników). Potem, przez
`railway ssh --service scoffie-backend -- sh -c 'cd /app && …'`:

1. `pnpm catalog:ingredients:load` — nowe nazwy składników z `ingredients-*.txt`
   (idempotentne, istniejących nie rusza).
2. `pnpm catalog:ingredients:nutrition` — makro (z cukrami i nasyconymi) nowych składników.
3. `pnpm catalog:ingredients:tags` — alergeny i tagi diet nowych składników; przelicza
   też unie tagów przepisów.
4. `RECIPE_IMPORT_FILE=prisma/catalog/recipes-catalog-full-v2.json pnpm recipes:import:json`
   — dodaje 572 przepisy (nowe id z pliku przechodzą bez potwierdzenia). Jeśli strażnik
   importu odmówi, znaczy to, że baza ma zmiany z panelu, których plik nie ma — NIE
   potwierdzać w ciemno: najpierw `pnpm catalog:export -- --check`/`--summary` i porównać.
5. Sprawdzić: `SELECT count(*) FROM "Recipe" WHERE "isCatalog" AND "isActive"` = 1072;
   telefony dostaną nowe przepisy deltą synchronizacji katalogu (wyzwalacze `CatalogChange`).

## Zdjęcia

Nowe przepisy mają zaślepkę (`RECIPE_IMAGE_PLACEHOLDER_URL`). Opisy do Recrafta są w
`prisma/catalog/recipe-image-dishes.json` (styl A, napoje w `cup`). Generowanie:
`pnpm exec tsx scripts/recraft-recipe-images.ts --ids <id,…>` (klucze `RECRAFT_AI_KEY`, `R2_*`),
potem `scripts/apply-recipe-images.ts` i `scripts/sync-catalog-image-urls.ts --apply`.
Koszt i publikacja do R2 — decyzja Rafała.
