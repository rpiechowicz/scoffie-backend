# Rebranding Weekly Meals → Scoffie — stan na 4.09.2026

Nowa aplikacja od zera (stary rekord w App Store Connect został usunięty z wgranym
buildem, więc Apple zablokowało bundle ID `rpiechowicz.weekly-meals` i SKU).

## Identyfikatory (źródło prawdy)

| Co                                     | Wartość                                                                                          |
| -------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Bundle ID (Developer Portal, explicit) | `app.scoffie.ios`                                                                                |
| SKU w ASC                              | `scoffie-ios`                                                                                    |
| Apple ID apki w ASC                    | `6808608589` → Railway `APPLE_APP_APPLE_ID`                                                      |
| Product ID subskrypcji                 | `app.scoffie.pro.solo.monthly`, `.duet.`, `.family.` (grupa „Scoffie Pro")                       |
| API                                    | `https://api.scoffie.app` (Railway projekt `scoffie`, serwis `scoffie-backend`, deploy z `main`) |
| Strona / support                       | `https://scoffie.app` (GitHub Pages z `docs/` repo iOS, `docs/CNAME`), `support@scoffie.app`     |
| URL scheme                             | `scoffie://invite?token=…`                                                                       |

Backend w kodzie ma domyślny bundle ID `app.scoffie` (bez `.ios`) — na Railway
zmienne `APPLE_AUDIENCE`, `APPLE_BUNDLE_ID`, `APNS_BUNDLE_ID` = `app.scoffie.ios`
nadpisują to. Wyrównanie domyślnych w kodzie (10 miejsc z testami) — do zrobienia.

## Zrobione

- Backend: nowy projekt Railway `scoffie` (Postgres, `scoffie-cookidoo`, `scoffie-backend`),
  `PORT=3000` jawnie (Railway wstrzykiwał 8080, domena celowała w 3000), domena `api.scoffie.app`
  przez Cloudflare **DNS only** (z proxy Railway nie weryfikuje domeny → 502).
- Hotfix `fab508a`: `BillingModule` importuje `AuthModule` — bez tego każdy start `main` od
  merge'u #64 padał na `UnknownDependenciesException` (JwtAuthGuard → AccessTokenService).
- iOS: commit `f1f23c2` na `claude/rebranding-scoffie-xyht15` — nazwa, teksty, bundle ID,
  URL scheme, Keychain, cache, product ID, domena, API, rename projektu na `Scoffie.xcodeproj`,
  build number 1. NIE zmergowane do `develop`; kompilację sprawdzi CI na PR (macOS runner).

## Do zrobienia (kolejność)

1. PR iOS `claude/rebranding-scoffie-xyht15` → `develop` (CI buduje), potem `develop` → `main`
   (TestFlight z workflow).
2. Ikona: 3 × PNG 1024×1024 w `Scoffie/Assets.xcassets/AppIcon.appiconset/` pod obecnymi
   nazwami (`app-icon-primary.png` bez alfa, `-dark.png` tło przezroczyste, `-tinted.png`
   skala szarości). Logo w kodzie `SCSteamingBowlLogo.swift` rysuje parę w kształcie „WM" —
   potrzebny nowy SVG 1024, ścieżki przenieść jak z `branding/weekly-meals-logo-v3.svg`.
3. DNS `scoffie.app`: 4 × A na GitHub Pages (185.199.108–111.153), CNAME `www` →
   `rpiechowicz.github.io`, GitHub Settings → Pages → custom domain + Enforce HTTPS;
   Cloudflare Email Routing dla `support@scoffie.app`. Potem Support URL w ASC na
   `https://scoffie.app/support/`.
4. ASC: Subtitle, kategorie, App Store Server Notifications URL
   `https://api.scoffie.app/billing/apple/notifications` (v2), subskrypcje, App Privacy
   (= `PrivacyInfo.xcprivacy` + Product Interaction, Other Diagnostic Data, Other Data),
   teksty wersji 1.0, screenshoty 6,9" 1320×2868 (iPhone only).
5. Przed recenzją: `AI_ALLOWED_USERS` puste na Railway (inaczej recenzent widzi „asystent
   niedostępny" → odrzucenie 2.1). `APNS_ENABLED=false` do czasu klucza APNs.
   `BILLING_ENABLED=false` do czasu klucza In-App Purchase.
6. Opcjonalnie: `.gitignore` dla `xcuserdata/` w repo iOS; manifest prywatności o 3 typy.
7. Sprawdzić zasiew katalogu: `SELECT count(*) FROM "Recipe"` = 145, `imageUrl IS NULL` = 0.
8. Stary projekt Railway `soothing-celebration` skasować po przejściu recenzji.
