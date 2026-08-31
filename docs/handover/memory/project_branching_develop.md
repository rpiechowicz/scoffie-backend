---
name: project-branching-develop
description: Oba repa (iOS i backend) integrują na gałęzi `develop`; lokalne refy bywają stare — najpierw `git fetch`, potem oceniaj.
metadata:
  type: project
---

Oba repozytoria Weekly Meals — `weekly-meals-ios` i `weakly-meals-backend` — mają gałąź integracyjną `develop` i to z niej zakłada się nowe branche. Lokalne kopie refów potrafią być mocno przeterminowane (backendowy `master` wyglądał na starszy o cztery miesiące, a `origin/develop` w ogóle nie istniał lokalnie, dopóki nie zrobiłem `git fetch --prune`).

**Zawsze `git fetch origin --prune` przed oceną stanu gałęzi.** Wnioski o „stary/nowy” wyciągnięte z lokalnych refów bywają po prostu fałszywe.

Uwaga operacyjna: `git status`, `git checkout` i `git merge` w tych repach potrafią trwać minutami albo wywalić się w timeout — patrz [[project-mac-resources-exhausted]]. Przerwany w połowie `checkout` zostawia drzewo robocze niespójne z HEAD (pliki z poprzedniej gałęzi jako „untracked”); ratunek to `git reset --hard <ref>`.
