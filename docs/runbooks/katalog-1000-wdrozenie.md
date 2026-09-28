# Katalog 1000 — wdrożenie na produkcję

Stan repo (28.09.2026): `prisma/catalog/recipes-catalog-full-v2.json` ma 1072 przepisy
(500 dotychczasowych + 572 z partii katalogu 1000, klucze w `katalog-1000-lista.md`),
53 nowe składniki (48 z #243 + 3 z partii + „białko jaja” i „żółtko”) i taksonomię oraz
cukry/nasycone dla wszystkich. Audyt zgodności składniki ↔ kroki ↔ makro (28.09.2026) poprawił
też ok. 120 dotychczasowych przepisów (większość ze zmienionym składem lub krokami: brakujący tłuszcz do
smażenia, nieużyte składniki, sól) i makro trzech składników liczonych z kością
(noga z kurczaka, karp, kaczka — teraz na masę zakupu). Decyzje z 28.09: żelatyna, galaretka,
kolagen, żelki i smalec mają tag MEAT (dieta wegetariańska je odrzuca — wcześniej smalec
przechodził), udon liczy sód po ugotowaniu, 6 przepisów odsolonych do ≤ 3 g (bigos i hot dogi
świadomie zostają wyżej).
Baza produkcji jest źródłem prawdy (D1), więc nowe przepisy i składniki trzeba do niej
WCZYTAĆ — migracje tego nie robią (wstawiają wyłącznie UPDATE-y istniejących wierszy).

## Kolejność (po wdrożeniu `develop` → `main`, tylko z jawnym „tak” Rafała)

Migracje `20260928120000…`–`20260928140100…` wchodzą same przy starcie kontenera
(taksonomia i cukry dla 500 istniejących przepisów i 421 składników). Potem, przez
`railway ssh --service scoffie-backend -- sh -c 'cd /app && …'`:

1. `pnpm catalog:ingredients:load` — nowe nazwy składników z `ingredients-*.txt`
   (idempotentne, istniejących nie rusza).
2. `pnpm catalog:ingredients:nutrition` — makro (z cukrami i nasyconymi) nowych składników;
   nadpisuje też noga z kurczaka / karp / kaczka. MUSI iść przed importem, bo import liczy
   kolumny przepisów z makro składników w bazie.
3. `pnpm catalog:ingredients:tags` — alergeny i tagi diet nowych składników i nowy tag MEAT
   żelatyny/galaretki/kolagenu/żelków/smalcu; przelicza też unie tagów przepisów.
4. `RECIPE_IMPORT_FILE=prisma/catalog/recipes-catalog-full-v2.json pnpm recipes:import:json`
   — dodaje 572 przepisy (nowe id przechodzą bez potwierdzenia) i poprawia ok. 120 istniejących.
   Strażnik importu ODMÓWI, bo te przepisy różnią się od bazy — to oczekiwane. Zanim ustawisz
   `RECIPE_IMPORT_FROM_JSON_CONFIRM=<dzisiejsza data>`, sprawdź w wypisanych różnicach, że
   dotyczą wyłącznie przepisów z tej partii poprawek, a nie edycji z panelu zrobionych po
   eksporcie (`pnpm catalog:export -- --summary`). Edycję z panelu najpierw przenieś do pliku.
   Import zrób PRZED najbliższym nocnym `catalog-sync` — inaczej eksport bazy otworzy PR
   cofający te poprawki w pliku.
5. Sprawdzić: `SELECT count(*) FROM "Recipe" WHERE "isCatalog" AND "isActive"` = 1072;
   telefony dostaną nowe przepisy deltą synchronizacji katalogu (wyzwalacze `CatalogChange`).

## Zdjęcia

GOTOWE (28.09.2026): 572 zdjęcia z Recrafta (styl A) leżą w R2 pod `img.scoffie.app/recipe-images/`
i są wpisane w `image.imageUrl` pliku katalogu — import z kroku 4 wstawia nowe przepisy od razu
ze zdjęciami, osobny SQL niepotrzebny. Wygenerowane `recraft-recipe-images.ts --one-shot --no-upload`
(1 próba na przepis), przejrzane na oko, 38 poprawionych (opisy 11 dań zmienione), wgrane
`scripts/upload-recipe-images-from-state.ts` (sprawdza skrót treści ↔ klucz), wpisane
`scripts/apply-recipe-images.ts`. Surowe i poprzednie wersje: `tmp/recipe-images` (gitignored,
tylko na maszynie, na której generowano).

Po imporcie sprawdzić: `SELECT count(*) FROM "Recipe" WHERE "isCatalog" AND "imageUrl" LIKE
'%recipe-placeholder%'` = 0.
