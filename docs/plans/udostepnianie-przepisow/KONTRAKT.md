# Udostępnianie przepisów — kontrakt (29.09.2026)

Jeden kontrakt dla backendu, strony (`scoffie-web`), iOS, Androida i panelu.
Decyzje Rafała z 29.09.2026: katalog i przepisy własne od razu; strona pokazuje
zdjęcie, opis i składniki, KROKI tylko w aplikacji; `noindex`; Universal Links
(iOS) i App Links (Android) razem z przepisami przenoszą też zaproszenia.

## Adresy

| Co                                      | Adres                                      | Kto widzi                                             |
| --------------------------------------- | ------------------------------------------ | ----------------------------------------------------- |
| Przepis katalogu                        | `https://scoffie.app/przepis/<slug>`       | każdy (katalog jest wspólny)                          |
| Przepis katalogu po id (stare/awaryjne) | `https://scoffie.app/przepis/<uuid>`       | strona robi 301 na `<slug>`; aplikacja otwiera wprost |
| Przepis własny gospodarstwa             | `https://scoffie.app/przepis/u/<token>`    | każdy, kto ma link, dopóki link jest aktywny          |
| Zaproszenie (bez zmian)                 | `https://scoffie.app/zaproszenie/#<token>` | adresat                                               |

- `slug`: `^[a-z0-9]+(?:-[a-z0-9]+)*$`, 1–80 znaków. Tylko przepisy KATALOGU mają slug.
  Nadaje go baza (trigger) przy pierwszym zapisie przepisu katalogu; zmiana tytułu
  NIE zmienia slugu. Świadoma zmiana (panel) zostawia stary jako alias → 301.
- `token`: `^[A-Za-z0-9_-]{22}$` (16 losowych bajtów, base64url). Jeden aktywny link
  na (przepis, gospodarstwo): ponowne „Udostępnij” zwraca TEN SAM adres, także na
  telefonie innego domownika. „Wyłącz link” gasi go na zawsze; następne
  „Udostępnij” wydaje nowy token.
- Końcowy `/` jest opcjonalny wszędzie (`/przepis/abc` = `/przepis/abc/`).
- Klient akceptuje hosty `scoffie.app` i `www.scoffie.app`.
- Schemat aplikacji (przycisk „Otwórz w Scoffie” na stronie — Universal Link nie
  otwiera aplikacji z tej samej domeny): `scoffie://recipe?slug=<slug>` i
  `scoffie://recipe?token=<token>`, obok istniejącego `scoffie://invite?token=<token>`.

## WebSocket (zalogowany socket, jak reszta `recipes:*`)

Każdy handler: najpierw tożsamość, potem koperta, potem członkostwo w `householdId`
(`NOT_HOUSEHOLD_MEMBER` 403). Brak przepisu, przepis wycofany, zły/wyłączony token,
cudzy przepis bez tokenu → zawsze `RECIPE_NOT_FOUND` (404) — ta sama odpowiedź.

### `recipes:shareLink` → adres do udostępnienia

```
→ { householdId: uuid, recipeId: uuid }
← { url: string, kind: "CATALOG" | "HOUSEHOLD", token: string | null }
```

- Katalog: `url = https://scoffie.app/przepis/<slug>`, `token = null`, nic się nie zapisuje.
- Przepis tego gospodarstwa: tworzy albo zwraca aktywny link (`/przepis/u/<token>`).
  Pierwsze utworzenie nadaje `recipes:changed` (`action: "UPDATED"`) do domu, żeby
  inni domownicy zobaczyli `shareUrl`.

### `recipes:revokeShare` → „Wyłącz link”

```
→ { householdId: uuid, recipeId: uuid }
← { revoked: boolean }            // false = nie było aktywnego linku
```

Dowolny domownik. Nadaje `recipes:changed` (`UPDATED`), gdy coś wyłączył.

### `recipes:shared` → „udostępniono” (licznik, bez danych osobowych)

```
→ { householdId: uuid, recipeId: uuid }
← { ok: true }
```

Klient woła PO faktycznym wysłaniu (zakończony arkusz udostępniania), nie przy otwarciu arkusza.

### `recipes:openShared` → otwarcie linku w aplikacji

```
→ { householdId: uuid, slug?: string, token?: string }   // dokładnie jedno z dwóch
← {
    origin: "CATALOG" | "HOUSEHOLD" | "SHARED",
    recipe: RecipeDetail,          // ten sam kształt co ack `recipes:findById`
    savedRecipeId: uuid | null,    // SHARED: kopia, którą ten dom już zapisał (aktywna)
    shareToken: string | null      // token, gdy otwarto po tokenie
  }
```

- `slug` przyjmuje też UUID przepisu katalogu i stary slug (alias).
- `HOUSEHOLD` = token wskazuje przepis TEGO domu → klient pokazuje zwykły szczegół.
- `SHARED` = przepis innego domu: tylko odczyt. `recipe.householdId` = `null`
  (nie zdradzamy cudzego domu), `recipe.isFavorite = false`. `recipes:findById`
  tego przepisu dalej daje 404 — klient NIE dociąga go po id.
- Zapisuje zdarzenie „otwarto w aplikacji”.

### `recipes:saveShared` → „Zapisz u siebie”

```
→ { householdId: uuid, token: string }
← { recipe: RecipeDetail, created: boolean }
```

Kopia do gospodarstwa pytającego: tytuł, opis, zdjęcie (ten sam adres, który widział
odbiorca), składniki, kroki, makro, tagi, taksonomia, źródło (Thermomix zostaje).
`isCatalog = false`, autor = pytający, `copiedFromRecipeId` = źródło. Idempotentne:
jeśli dom ma już AKTYWNĄ kopię tego przepisu, wraca ona z `created: false`.
Token przepisu tego samego domu → wraca oryginał, `created: false`.
Nadaje `recipes:changed` (`action: "CREATED"`) do domu pytającego.
„Dodaj do planu” z przepisu SHARED = najpierw `saveShared`, potem zwykłe dodanie z `recipe.id` kopii.

### Zmiany w istniejących odpowiedziach (addytywne)

- `catalog:snapshot`, `catalog:changes`, `recipes:findAll`, `recipes:householdState`,
  `recipes:findById`: przepis ma `slug: string | null`.
- `recipes:householdState` → każdy przepis domu ma `shareUrl: string | null`
  (aktywny link albo null) — z tego klient wie, czy pokazać „Wyłącz link”.
- `recipes:changed.action` może mieć wartość `CREATED` (klienci: nieznana = przeładuj).

## REST publiczny (bez logowania) — dla strony

```
GET /public/recipes/slug/:slug     → 200 PublicRecipe | 404
GET /public/recipes/shared/:token  → 200 PublicRecipe | 404
```

`:slug` przyjmuje też UUID i alias. 404 ma ciało aplikacji `{ code: "RECIPE_NOT_FOUND", … }`.

```
PublicRecipe {
  kind: "CATALOG" | "SHARED",
  slug: string | null,            // KANONICZNY slug katalogu — strona robi 301, gdy adres był inny
  title: string,
  description: string | null,
  imageUrl: string | null,        // to samo zdjęcie co w aplikacji; null = przepis domu bez zdjęcia (od 7.10.2026)
  mealType: MealType,
  difficulty: Difficulty,
  prepTimeMinutes: number,
  servings: number,
  perServing: { kcal: number, protein: number, fat: number, carbs: number },  // zaokrąglone do 1 (kcal) / 0,1 g
  allergens: string[],            // id jak w aplikacji
  ingredients: { name: string, amount: number, unit: string }[],  // na `servings` porcji
  stepCount: number,
  thermomix: boolean
}
```

- Nie ma autora, domu, id przepisu ani kroków.
- `Cache-Control`: katalog `public, max-age=300`; link własny `public, max-age=60`.
- Limit: `THROTTLE_PUBLIC_LIMIT` na IP (domyślnie 60/min). Worker strony wysyła
  nagłówek `x-scoffie-web-secret` = `WEB_RENDER_SECRET` i wtedy limitu nie ma
  (wszyscy odwiedzający przychodzą z kilku adresów Cloudflare).

## Panel (`/admin/*`)

- `GET /admin/catalog/recipes/:id` → dodatkowo `slug`, `slugAliases: string[]`,
  `shares: { shared, opened, saved }` (liczniki z całego czasu).
- `PUT /admin/catalog/recipes/:id` przyjmuje opcjonalne `slug` (zmiana adresu; stary → alias;
  zajęty adres = 400 `VALIDATION_ERROR` z `details: ["slug"]`). `slugAliases` i `shares` są
  przyjmowane i pomijane (panel odsyła cały `GET`).
- `GET /admin/catalog/insights` → `popularity.shared` i `popularity.linkOpens`
  (`CatalogRankItem[]`, top 10 katalogu w oknie `popularity.days`).
- `POST /admin/recipe-shares/revoke` `{ link, reason }` (`link` = token albo cały adres)
  → `{ revoked: boolean, recipeTitle: string | null }` — wyłączenie zgłoszonego linku
  własnego przepisu; wpis `recipe.share.revoke` w dzienniku audytu (bez tokenu). Bez step-upu.

## Pliki linków (scoffie-web)

- `/.well-known/apple-app-site-association` — `applinks` dla appID
  `5R874L3LNP.app.scoffie.ios`, ścieżki `/przepis/*`, `/zaproszenie/*`, `/otworz/*`.
- `/.well-known/assetlinks.json` — `app.scoffie.android`, odciski: klucz debug
  (klucz Play dojdzie przy publikacji w Sklepie Play).
