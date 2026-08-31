---
name: feedback-check-remote-before-asking
description: Zanim zapytam o stan gałęzi/danych — sprawdzam źródło (fetch, zapytanie, plik), a nie lokalny cache.
metadata:
  type: feedback
---

Zapytałem, z czego założyć branch backendu, bo lokalnie nie było `develop`, a `master` wyglądał na stary. Odpowiedź: „ios i backend ma najnowszego developa, zaciągnij sobie i zobacz, na milion procent”.

**Why:** pytanie było oparte na nieaktualnym lokalnym cache’u, a nie na stanie faktycznym — jeden `git fetch` odpowiadał na nie lepiej niż ja. Rafał traktuje pytania o rzeczy, które da się sprawdzić, jako marnowanie jego czasu.

**How to apply:** zanim zadam pytanie, sprawdzam, czy odpowiedzi nie ma w źródle prawdy — `git fetch`/`git ls-remote`, zapytanie do bazy, zajrzenie do pliku. Pytam tylko o rzeczy, których naprawdę nie da się odczytać: preferencje, priorytety, decyzje produktowe. Patrz [[project-branching-develop]].
