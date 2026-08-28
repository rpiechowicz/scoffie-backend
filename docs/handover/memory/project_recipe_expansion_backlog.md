---
name: recipe-expansion-backlog
description: "Zatwierdzona lista 55 nowych przepisów do dodania do bazy Weekly Meals, z podziałem na partie i statusem realizacji."
metadata: 
  node_type: memory
  type: project
  originSessionId: a673613e-4da2-4a42-a697-9d485bd8a0df
  modified: 2026-08-24T13:33:52.655Z
---

**ZAKOŃCZONE I ZMERGOWANE (2026-08-24):** cały plan zrealizowany — baza ma 89 przepisów (30 + 59 nowych), wszystkie ze zdjęciami w R2, po audycie QA. Backend: gałąź `feat/recipe-catalog-expansion` zmergowana do `develop` (commit bbe19ba, merge ef1fa40) — w tym zbiorczy `recipes-catalog-full-v2.json` (89 przepisów z jawnymi id; import z `RECIPE_IMPORT_CLEAR_EXISTING=false` to bezpieczny upsert, przetestowany: updated=89/created=0) i bootstrap w `prisma-migrate-deploy-safe.js` celujący w ten plik + ładujący nutrition. iOS: `feature/recipe-catalog-ux` zmergowana do `develop` (sheet szczegółów nad listą kategorii + pełne ładowanie katalogu w RecipeCatalogStore). Release na produkcję: przygotowany runbook (deploy z develop + jednorazowy load danych w kontenerze), promocja do `main` czeka na decyzję Rafała.

Zatwierdzona 2026-08-24 lista 55 nowych przepisów (rozbudowa bazy z 30 do 85→ ostatecznie 89). Robimy partiami od góry. Preferencje: [[recipe-content-preferences]], makra wg [[recipe-macro-convention]]. Zdjęcia: użytkownik generuje w Recraft AI, wgrywa do R2 `recipe-images/`, pliki nazywamy slugiem przepisu.

**Partia 1 — Śniadania (8) — GOTOWA (2026-08-24): w bazie + zdjęcia w R2 podpięte.**
Plik: `prisma/catalog/recipes-batch-breakfast-8-v1.json` (makra przeliczone skryptem, imageUrl wpisane). Baza ma 38/38 przepisów ze zdjęciami. Styl promptów Recrafta: aktualna wersja **v4** w `recipes-batch-soups-8-v1.json` — szeroki kadr, jasny blat, rekwizyty w tle, jasne światło, 3:2, plus wymuszone: centrowanie ("perfectly centered in the middle of the frame" + "in the exact center of the image"), nieprzezroczysta ceramika ("rustic opaque ceramic stoneware bowl", "no glass or transparent dishes" — v2/v3 dawały szklane miski) i wysoki kąt ~60° pokazujący wnętrze naczynia z góry. Do partii 4–6 kopiować v4 (dla dań na talerzu podmienić "bowl"→"plate").
1. Owsianka nocna z masłem orzechowym i malinami — f50f6d7e-bf1e-4e06-afad-949974d7c2fa
2. Skyr z granolą i malinami — 386586d2-b4f8-41f0-9641-cce2b7c20dd7
3. Twarożek na słodko z brzoskwinią i granolą — 7b3ef680-7a54-460b-a3d5-39c205631318
4. Serniczki fit z twarogiem i borówkami — 0a1dd45f-1e37-4b35-8315-5fb61441e87d
5. Bułeczki z pastą jajeczną i rzodkiewką — f83eed93-fb23-4171-91aa-c786aa330928
6. Tosty francuskie z owocami — 734a0932-01b8-4f5d-9789-d1c886796068
7. Omlet z szynką i pomidorami — 3087759e-713c-4a44-b87d-2bfca0d36171
8. Kanapki z szynką, serem i pomidorem — 4b5c9b22-d219-4719-82be-dc25b22fef52

Przy imporcie ustawiać `IMAGE_GENERATOR_PROVIDER=none` (albo po imporcie wyzerować `imageUrl`) — inaczej import wstawia URL-e pollinations. Dodane składniki: granola, masło orzechowe, miód (+ makra dla 10 pozycji w `ingredient-nutrition-pl-v1.json`). Workflow partii: edycja katalogów → scratch container (`docker run --network weakly-meals-backend_default` z obrazu API) → `pnpm catalog:ingredients:load` → `catalog:ingredients:nutrition` → `recipes:recompute:nutrition -- --write` → `recipes:import:json` → docker cp JSON z powrotem.

**Dodatek na życzenie (2026-08-24) — 3 pierogi — GOTOWE (zdjęcia podpięte):** Pierogi z mięsem 34efc155… · Pierogi z kapustą i grzybami e467a224… · Pierogi z truskawkami 1d3ef7ce… (plik `recipes-batch-pierogi-3-v1.json`; nowe składniki: kapusta kiszona + makro cukru; plan urósł do 58 pozycji, baza ma 52 przepisy). Prompty dopisane do artefaktu „Prompty obiadowe".

**Partia 2 — Obiady, polska klasyka (11) — GOTOWA (2026-08-24, zdjęcia podpięte; baza 52/52 ze zdjęciami):**
Plik: `prisma/catalog/recipes-batch-polish-classics-11-v1.json`. Baza ma 49 przepisów. Dodane składniki: bułka tarta, majeranek, koperek (+19 wpisów makro: mięsa, kasze, konserwy, burak, kapusta). `imageUrl` NULL — użytkownik generuje w Recrafcie wg artefaktu „Prompty obiadowe", wgrywa jako `recipe-images/<id>.png`, potem UPDATE.
Kotlet schabowy 669d9bd0… · Kotlety mielone 8d486c7d… · Gulasz wieprzowy d5885b80… · Schab duszony 34b6e886… · Bitki wołowe 6e0e7983… · Gołąbki 68213b62… · Pierogi ruskie 2b63c5bd… · Placki ziemniaczane 3d9e3532… · Leczo a9c470e6… · Fasolka po bretońsku 11b90cde… · Polędwiczki 8c0f0ba7…

**Partia 3 — Zupy i kremy (8) — GOTOWA (2026-08-24, zdjęcia podpięte; baza 60/60 ze zdjęciami). W trakcie: 5 poprawek zdjęć śniadaniowych w stylu v4 (skyr, twarożek, serniczki, tosty francuskie, omlet — te same nazwy plików, nadpisanie w R2).**
Plik: `recipes-batch-soups-8-v1.json`. Baza ma 60 przepisów. Nowe składniki: seler korzeniowy, makaron nitki, zakwas na żurek, pestki dyni (+12 wpisów makro: buliony, kiełbasa biała, noga z kurczaka, dynia, por, pietruszka, natka, kasza jęczmienna). Prompty: artefakt „Prompty zupowe". Rosół b62e8c28… · Ogórkowa e6542205… · Żurek b9b691e4… · Krupnik ac211d05… · Gulaszowa b3be931b… · Krem brokuły 4bec001d… · Krem dynia 4114372b… · Krem por d0b4e5af…

**Partia 4 — Obiady: indyk, ryby i reszta (12) — GOTOWA (2026-08-24, zdjęcia podpięte; baza 72/72 ze zdjęciami):**
Plik: `recipes-batch-world-12-v1.json`. Baza ma 72 przepisy. Nowe składniki: indyk mielony, mintaj, ryż arborio, kmin rzymski (+18 wpisów makro: strączki/kukurydza z puszki, ryby, sosy, przyprawy, kasza jaglana). Prompty (v4): artefakt „Prompty obiadowe II". Poprawione zdjęcia 6 śniadań wgrane (nadpisane w R2, te same URL-e).
Potrawka 7fbebfae… · Pierś indyka a4e6c328… · Chili 095ebe70… · Burgery f84842de… · Dorsz 0f921aec… · Mintaj 743db996… · Teriyaki 8c6f5576… · Bowl 8ea632a7… · Kaszotto 6510782c… · Risotto c3859fc1… · Makaron z cukinią a02d4167… · Kotlety z ciecierzycy 50b6c4f8…

**Partie 5+6 — Kolacje (7) i przekąski (10) — ZAIMPORTOWANE DO BAZY (2026-08-24), czekają zdjęcia:**
Pliki: `recipes-batch-dinners-7-v1.json` i `recipes-batch-snacks-10-v1.json`. **Baza ma komplet planu: 89 przepisów** (72 ze zdjęciami + 17 czeka). Nowe składniki: łosoś wędzony, nasiona chia, kakao, hummus (+8 wpisów makro). Prompty: artefakt „Prompty finałowe" (koktajle i chia w szkle, reszta ceramika v4).
UWAGA na przyszłość: jednostki łyżeczka/szczypta działają TYLKO dla kategorii "Przyprawy i sosy" — np. proszek do pieczenia (Cukiernia) musi być w gramach, inaczej recompute i import rzucają błąd (import przerywa się w połowie partii, bez rollbacku).
Kolacje: Zapiekanki 3372daf0… · Zapiekanka makaronowa 1f988f7d… · Sałatka tuńczyk af34c689… · Sałatka łosoś 4f82670a… · Naleśniki szpinak fa523dda… · Wrapy tuńczyk a1d0a64d… · Quesadilla 136432dd…
Przekąski: Koktajl ban-trusk 463a10d3… · Koktajl skyr fd807639… · Pudding chia 76954d2c… · Pudding ryżowy 01079d45… · Deser twarogowy 7faa8914… · Muffiny 77921fc5… · Hummus 671cd8e4… · Pasta tuńczyk fb9b74ae… · Wrap indyk b083624b… · Budyń 35de5380…

Zrobione wcześniej tego samego dnia: rozszerzenie `suitableMealTypes` istniejących 30 przepisów (obiady→także kolacja itd.).
