---
name: Rozjazd migracji Prismy — naprawiony 11.09.2026
description: Dlaczego `migrate dev` żądał resetu bazy i co zrobić na innej maszynie albo na prod, żeby `migrate status` było czyste
type: project
originSessionId: cf5b81ba-7cdf-47f4-bc17-28cc40b2cb6f
---

Fakt: Do 11.09.2026 `pnpm prisma:migrate:dev` na lokalnej bazie kończył się
żądaniem `migrate reset` („migration was modified after it was applied") oraz
diffem z trzema `DROP DEFAULT`. Oba objawy miały osobne przyczyny i obie są
naprawione w kodzie / w lokalnej bazie.

**Why:**

1. Migracja `20260831180000_pamiec_asystenta` została zedytowana commitem
   `25b78c8` PO zaaplikowaniu — zmieniły się WYŁĄCZNIE komentarze SQL, ale
   Prisma porównuje SHA-256 całego pliku, więc suma w `_prisma_migrations`
   przestała pasować. Semantycznie baza i plik są identyczne.
2. Trzy migracje pisane ręcznie (`karty_i_propozycje_asystenta`,
   `zdarzenia_zgod`, `zgloszenia_odpowiedzi_asystenta`) zakładały kolumnę `id`
   z `DEFAULT gen_random_uuid()`, a schema deklarowała `@default(uuid())`
   (wartość liczona po stronie klienta, bez domyślnej w bazie). Diff chciał
   zdjąć domyślną z bazy — także na prod.

**How to apply:**

- Schema mówi teraz to samo, co baza: `AgentProposal`, `AgentReport`
  i `ConsentEvent` mają `@default(dbgenerated("gen_random_uuid()"))`. ŻADNEJ
  migracji nie trzeba, prod nietknięty, `migrate diff` pusty.
- `migrate deploy` (prod, `prisma-migrate-deploy-safe.js`) NIE sprawdza sum
  kontrolnych, więc produkcja nigdy nie była zablokowana. Blokowało tylko
  `migrate dev` / `migrate status` na maszynach, które zaaplikowały starą
  wersję pliku. Naprawa na takiej maszynie (albo na prod, jeśli ktoś chce
  czystego `migrate status`) to jedno zapytanie — suma to `sha256sum` pliku:
  `UPDATE _prisma_migrations SET checksum = '<sha256 migration.sql>'
  WHERE migration_name = '20260831180000_pamiec_asystenta';`
- Lokalne kontenery nazywają się `weeklymeals-*` (stara nazwa projektu
  compose), więc `docker compose exec db` mówi „service not running" — działa
  `docker exec weeklymeals-db psql -U weeklymeals -d weeklymeals`.
- NIE edytować zaaplikowanych migracji, nawet komentarzy. Poprawka do treści
  = nowa migracja albo komentarz w schema.
