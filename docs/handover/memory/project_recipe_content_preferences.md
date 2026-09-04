---
name: recipe-content-preferences
description: 'Preferencje żywieniowe do bazy przepisów — wieprzowina/wołowina tak, krewetki i śledź nie, więcej indyka, tylko proste domowe dania.'
metadata:
  node_type: memory
  type: project
  originSessionId: a673613e-4da2-4a42-a697-9d485bd8a0df
  modified: 2026-08-24T09:48:41.589Z
---

Preferencje do przepisów w Scoffie (ustalone 2026-08-24 przy rozbudowie bazy):

- Wieprzowina i wołowina: TAK, bez ograniczeń.
- Krewetki i śledź: NIE — nie proponować.
- Indyk: mile widziany, celowo zwiększać jego udział.
- Styl: proste domowe dania, które użytkownik sam ugotuje — żadnych wymyślnych/"restauracyjnych" przepisów. Składniki realnie dostępne w Biedronce/Lidlu.
- Porcje: domyślnie 2 (jak cała dotychczasowa baza).
- Każdy przepis powinien mieć sensownie szerokie `suitableMealTypes` (obiady zwykle też DINNER itd.), wartości w kolejności enuma — patrz [[meal-slots-architecture]].
- Zdjęcia: użytkownik generuje w Recraft AI i wgrywa do Cloudflare R2 (`recipe-images/`), publiczny URL `https://pub-d6de57d50783403ab7f168d38802a1a6.r2.dev/recipe-images/<plik>.png`.
- Makra liczyć wg [[recipe-macro-convention]].
