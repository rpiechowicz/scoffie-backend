---
name: project-recipe-ids-vs-r2-images
description: 'Zdjęcia w R2 nazwane id przepisu są ŹRÓDŁEM PRAWDY o parowaniu id↔danie; złe id w katalogu naprawia się w katalogu, nigdy przez przestawianie obiektów.'
metadata:
  node_type: memory
  type: project
  originSessionId: 3830a418-7f92-4d32-825a-5fad3cb1049e
  modified: 2026-08-27T14:20:22.385Z
---

Obiekty w R2 (`recipe-images/<Recipe.id>.png`) zostały wygenerowane z poprawnym parowaniem id↔danie. Rozjazd wziął się z `recipes-catalog-full-v2.json`: pulę id z `recipes-approved-30-image-ids.txt` (posortowaną po UUID) nałożono po INDEKSIE na listę w kolejności tytułów, więc 28 z 30 pierwotnych przepisów dostało w katalogu id innego dania. Import robi upsert PO ID, więc te złe id weszły do bazy.

**Objaw wygląda jak „złe zdjęcie", ale to nie jest problem ze zdjęciami.** Wiersz w bazie ma cudze id, więc wszystko, co trzyma samo id — pozycje planu, ulubione, cache katalogu w aplikacji, nazwa obrazka — zostaje przy poprzednim daniu. Użytkownik stuka kafelek A, do planu wchodzi B. Zgłoszone z produkcji.

Naprawa idzie w JEDNĄ stronę: prostuje się `id` + `imageUrl` w katalogu (commit `b2ad82f` na `develop`, poprawne parowanie wzięte z `recipes-db-v1-import.json`) i importuje ponownie. **Nigdy odwrotnie** — przestawianie obiektów w buckecie „żeby zdjęcia się zgadzały" maskuje błąd tożsamości i niszczy jedyny wiarygodny ślad poprawnego parowania. Import z 28 zmianami tytułu wymaga `RECIPE_IMPORT_ALLOW_RETITLE=true`; bez tego świadomie wywala się błędem (ten sam commit).

Przed każdą naprawą katalogu: `git fetch` i sprawdź, czy tego nie naprawiono już na `develop` — patrz [[feedback-check-remote-before-asking]] i [[project-branching-develop]].

**Po naprawie po stronie serwera trzeba unieważnić cache w aplikacji.** Telefon trzyma katalog przez 12 h (`recipes_catalog_cache_vN.json`) i obrazy przez 30 dni (`com.weeklymeals.imagecache.vN`, klucz = URL). Adres `<id>.png` się nie zmienia, zmienia się zawartość pod nim, więc żaden z tych cache'y nie ma jak zauważyć poprawki — jedyne wyjście to podbicie numeru wersji w obu (zrobione: katalog v10, obrazy v3, 27.08.2026).
