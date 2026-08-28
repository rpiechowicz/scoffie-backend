---
name: project-stale-local-prisma-client
description: Lokalny @prisma/client jest starszy niż schema — MealType ma w nim tylko 3 warianty, więc lokalne jest/tsc/tsx dają fałszywe wyniki.
metadata:
  type: project
---

Wygenerowany lokalnie `@prisma/client` w `weakly-meals-backend` pochodzi sprzed rozszerzenia
enuma `MealType`. Sprawdzenie zajmuje sekundę:

```
node -e "const {MealType}=require('@prisma/client'); console.log(Object.keys(MealType).join(', '))"
```

Jeśli wypisze `BREAKFAST, LUNCH, DINNER` zamiast sześciu wartości, klient jest przestarzały.
Świeży klient siedzi tylko w obrazie Dockera — tam backfill slotów działa poprawnie.

**Dlaczego to groźne:** `MealType.SECOND_BREAKFAST` i spółka są wtedy `undefined`, a nie błędem.
Kod się wykonuje, testy „przechodzą", tylko wyniki są bez sensu — `resolveSuitableMealTypes`
zwraca tablicę `undefined`. Fałszywy wynik jest gorszy niż wywalenie się.

**Jak stosować:** `npx prisma generate` na tym Macu potrafi nie skończyć (patrz
[[project-mac-resources-exhausted]]) i po drodze zjada dysk — pilnuj `df -h /` w trakcie.
Kiedy generowanie nie wchodzi w grę, logikę czystą (bez bazy) da się zweryfikować bez Prismy:
skopiuj moduł do scratchpada, podmień `from '@prisma/client'` na własny stub z pełnym enumem
i puść `node --experimental-strip-types plik.ts` — omija to jednocześnie ts-jest i esbuild,
które na tej maszynie się wieszają. Powiązane: [[project-docker-no-auto-migrate]],
[[project-meal-slots-architecture]].
