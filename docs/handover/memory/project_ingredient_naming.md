---
name: ingredient-naming
description: "Konwencja nazw składników po sprzątaniu 2026-08-24 — name z polskimi znakami, normalizedName ASCII jako klucz; jak scalać duplikaty."
metadata: 
  node_type: memory
  type: project
  originSessionId: a673613e-4da2-4a42-a697-9d485bd8a0df
  modified: 2026-08-24T10:44:35.949Z
---

Po sprzątnięciu bazy składników (2026-08-24): `Ingredient.name` ma polskie znaki (wyświetlane w apce), `normalizedName` jest ASCII i jest KLUCZEM dopasowania (pliki txt katalogu, `ingredient-nutrition-pl-v1.json`, importy przepisów — wszystko schodzi się po `normalizeText`). Pliki `prisma/catalog/ingredients-*.txt` trzymają teraz nazwy z polskimi znakami.

**Why:** zmiana `name` bez zmiany znormalizowanej formy jest darmowa; zmiana słowa/formy zmienia klucz i wymaga: aliasu (`IngredientAlias`), aktualizacji txt i ewentualnie klucza w nutrition JSON. Loader katalogu NIE zmienia nazw istniejących składników (tylko dodaje aliasy), więc renejmy robi się SQL-em + sync `RecipeIngredient.name/department` z `Ingredient` na końcu.

**How to apply:** duplikat scalamy tylko przy 0 użyć: alias stary→kanoniczny + `isActive=false` + usunięcie linii z txt (loader ustawia `isActive=true` dla każdej linii, więc pozostawiona linia by go wskrzesiła). Scalone: jogurt typu skyr→skyr naturalny, mleko kokosowe→mleko kokosowe z puszki, papierowy ręcznik kuchenny→ręcznik papierowy, wrap pszenny→tortilla pszenna, margaryna roślinna→margaryna. Celowo NIE scalone (różne produkty): śmietana 12/18 vs śmietanka 12/18 (kwaśna vs słodka), tuńczyk (świeży, Ryby) vs tuńczyk w puszce (Konserwy), serek kremowy vs serek kanapkowy. Powiązane: [[recipe-expansion-backlog]].
