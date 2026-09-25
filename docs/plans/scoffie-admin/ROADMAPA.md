# Panel administratora Scoffie — co robi i w jakiej kolejności (24.09.2026)

Status: **plan, nic jeszcze nie zbudowane.** Dokument zbiera, co panel ma
robić, na jakich danych stoi (wszystko poniżej sprawdzone w
`prisma/schema.prisma` i w kodzie z 24.09.2026), jak go ukryć i zabezpieczyć
oraz w jakiej kolejności go budować. Decyzje otwarte są na końcu.

Założenia od Rafała:

- panel jest **własny** (nie Metabase / Retool / AdminJS),
- front: **wybiera Claude, bo to on pisze kod** (24.09 — zmiana z Vue 3;
  wybór i powody w §2),
- wygląd **zgodny z aplikacją iOS** (§2a), projekt ekranów w Claude Design,
- **działa na telefonie** — Rafał będzie z niego korzystał z iPhone'a,
- stoi na **naszej domenie**, ale ma być **ukryty**,
- logowanie **na kilka sposobów**,
- backend rozwijamy o to, czego panel potrzebuje.

---

## 1. Zasady, których plan nie łamie

1. **Panel nie dotyka bazy sam.** Wszystko idzie przez API backendu
   (`/admin/*`), a każdy zapis przez serwisy domenowe — te same, które mają
   `validateDto`, `lockWeekForWrite`, `lockHouseholdRoster`, zamki sesji.
   Kontroler admina, który pisze gołą Prismą, omija dokładnie te niezmienniki,
   na które poszły audyty z 5 i 21.09.
2. **Każda zmiana z panelu zostawia ślad** (`AdminAuditEvent`): kto, co, na
   czym, kiedy, z jakim powodem. Bez wyjątków, także dla „tylko podejrzałem"
   danych wrażliwych.
3. **Dane o zdrowiu są domyślnie zakryte.** Waga, wzrost, rok urodzenia, płeć,
   alergeny, dieta, cel kalorii, pamięć asystenta o osobie — to dane szczególnej
   kategorii (art. 9 RODO). Panel pokazuje je dopiero po świadomym „Odsłoń"
   z powodem, który ląduje w audycie. Agregaty (np. „ile osób omija gluten")
   są w porządku.
4. **Treści rozmów z asystentem panel nie czyta.** Wyjątek: zgłoszenia
   (`AgentReport.messageText` to migawka, którą użytkownik sam wysłał do
   rozpatrzenia). Metadane tury (model, koszt, tokeny, czas, kod błędu,
   nazwy kroków) — tak.
5. **Sekrety integracji żyją w backendzie.** Przeglądarka nie widzi klucza
   Sentry, Anthropic Admin API ani App Store Connect — pyta backend,
   backend pyta dostawcę.
6. **Moduł `src/admin/` jest jednokierunkowy**, jak `src/agent/`: wolno mu
   wołać domenę i obserwowalność, nic w aplikacji nie importuje
   `src/admin/` (reguła `no-restricted-imports`, wyjątek `AppModule`).
7. **`OPS_TOKEN` + curl zostaje** jako wyjście awaryjne (break-glass), gdy
   panel albo Cloudflare leży. Panel nie używa `OPS_TOKEN`.

---

## 2. Architektura

```
przeglądarka ──► Cloudflare Access ──► Worker „scoffie-admin” ──► api.scoffie.app/admin/*
                 (bramka zerowa)       · statyczny build React        (Railway, NestJS)
                                       · /api/* → proxy do backendu   · weryfikuje JWT Access
                                         z nagłówkiem Access JWT      · weryfikuje sesję admina
                                                                      · RBAC + audyt
```

### Front — repo `rpiechowicz/scoffie-admin` (nowe)

**Dlaczego React, a nie Vue** (decyzja z 24.09): kod pisze Claude, a w
React pisze najpewniej. Do tego ekosystem dashboardów jest tam najbogatszy
(shadcn/ui, TanStack), a Claude Design generuje makiety w React, więc
makieta przechodzi w kod prawie wprost. **Bez Next.js, Nuxta i Astro** —
panel siedzi za logowaniem, SEO i renderowanie na serwerze nic mu nie dają,
a SSR na Workerze to sesja po stronie serwera, czyli więcej miejsc na błąd.
Czysty SPA.

Wersje sprawdzone w npm 24.09.2026:

| Warstwa         | Wybór                                                                                                                               | Dlaczego                                                                                                    |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Rdzeń           | React 19.3 + React Compiler 1.0, TypeScript 7, Vite 8 (Rolldown)                                                                    | kompilator zdejmuje ręczne `useMemo`/`useCallback`; TS 7 i Vite 8 to szybki build                           |
| Routing         | TanStack Router (trasy z plików, typowane parametry i `search`)                                                                     | filtry tabel siedzą w URL-u — link do „użytkownicy bez kreatora, 7 dni” da się wkleić                       |
| Dane z API      | TanStack Query 5                                                                                                                    | cache, odświeżanie w tle, prefetch przy najechaniu, optymistyczne akcje                                     |
| Stan interfejsu | bez biblioteki (`useState` / kontekst); Zustand dopiero gdy zaboli                                                                  | stan serwera trzyma Query, filtry trzyma URL — zostaje niewiele                                             |
| Komponenty      | **shadcn/ui** (CLI 4, Tailwind 4, prymitywy Radix) + Sonner (toasty) + Vaul (arkusze od dołu na telefonie) + cmdk (⌘K)              | kod komponentów w repo = pełna kontrola nad wyglądem iOS; Vaul daje arkusz jak w aplikacji                  |
| Tabele          | TanStack Table 9 + TanStack Virtual                                                                                                 | sortowanie, filtry, paginacja z serwera, tysiące wierszy bez przycinania                                    |
| Wykresy         | **Recharts 3 przez shadcn charts** (kafle, trendy, słupki, kołowe); **ECharts 6** ładowany leniwie tylko do heatmapy kohort i lejka | shadcn charts biorą kolory z tych samych tokenów co reszta; ECharts tam, gdzie Recharts nie ma typu wykresu |
| Animacje        | Motion 13 (dawniej Framer Motion)                                                                                                   | sprężyny i przejścia jak w SwiftUI                                                                          |
| Formularze      | React Hook Form + Zod 4                                                                                                             | edytor przepisu jest duży; ten sam schemat Zod waliduje w formularzu                                        |
| Typy API        | `@hey-api/openapi-ts` z `@nestjs/swagger` dla `/admin` → typy + klient + hooki Query                                                | jeden kontrakt, zero ręcznie przepisywanych typów                                                           |
| Ikony           | Lucide (kreska 1,75 — najbliżej SF Symbols)                                                                                         |                                                                                                             |
| Passkeys        | `@simplewebauthn/browser` 14                                                                                                        | parowany z `@simplewebauthn/server` 14 w backendzie                                                         |
| Daty / liczby   | `Intl` + `date-fns`, strefa `Europe/Warsaw`, polski                                                                                 | serwer stoi w UTC                                                                                           |
| Testy           | Vitest + Playwright (w tym profil iPhone)                                                                                           | e2e przechodzi logowanie i główne ekrany na obu szerokościach                                               |

Hosting: **Cloudflare Workers** (jak strona), ale — inaczej niż `scoffie-web`
— z małym runtime'em: Worker (`@cloudflare/vite-plugin`, Wrangler 4) serwuje
build jako static assets i proxuje `/api/*` do backendu. Jedno źródło
pochodzenia (origin) = bez CORS i z ciasteczkami `SameSite=Strict`.
Subdomena podpięta rekordem DNS za pomarańczową chmurką + Route do Workera,
nie przez Custom Domain — sprawdzić przed konfiguracją, czy Custom Domain nie
wystawia certyfikatu z nazwą (patrz §3.2).

**RWD od pierwszego ekranu, nie dorabiane:** na telefonie menu boczne zamienia
się w pływający dolny pasek (jak `SCFloatingTabBar` w aplikacji), tabele w
listę kart, szczegóły i filtry otwierają się w arkuszu od dołu (Vaul), a akcje
są w zasięgu kciuka. Każdy ekran ma w e2e zrzut na 393 px i na 1440 px.

### 2a. Wygląd — ten sam system co iOS

Panel ma wyglądać jak brat aplikacji, nie jak generyczny szablon. Źródło
tokenów: `scoffie-ios/Scoffie/Components/SCDesignSystem.swift` („Cozy
Kitchen”), przepisane 1:1 do zmiennych CSS i motywu Tailwinda. Ciemny motyw
jest pierwszy, jasny jest lustrem; przełącza się za systemem.

| Token                               | Ciemny                            | Jasny                             | Użycie                                                              |
| ----------------------------------- | --------------------------------- | --------------------------------- | ------------------------------------------------------------------- |
| tło strony (`scPageBase`)           | `#0C0806`                         | `#FBF5EA`                         | + miękka poświata terakoty u góry (`SCPageBackground`: 12 % / 10 %) |
| tekst (`scLabel`)                   | `#FBF3E8`                         | `#1A1411`                         |                                                                     |
| tekst drugorzędny (`scMuted`)       | tekst × 58 %                      | tekst × 66 %                      |                                                                     |
| karta (`scTileBg` + `scTileStroke`) | tekst × 4 % + obrys 6 %           | tekst × 6 % + obrys 12 %          | **każda karta taka sama, bez cienia, bez białych kart**             |
| pole / studzienka (`scChipBg`)      | tekst × 8 %                       | tekst × 5 %                       | inputy, segmenty, pigułki                                           |
| linia (`scRule`)                    | tekst × 12 %                      | tekst × 18 %                      |                                                                     |
| terakota (akcent główny)            | `#DB8452`                         | `#B6643C`                         | akcje, kalorie, zaznaczenie                                         |
| szałwia                             | `#87C2A5`                         | `#4C8766`                         | „zrobione”, sukces, węglowodany                                     |
| indygo                              | `#6573CA`                         | `#4B58AF`                         | informacja, białko                                                  |
| masło                               | `#E8CF85`                         | `#A07828`                         | uwaga, tłuszcz                                                      |
| róż / morska / lawenda              | `#E09AA4` / `#6FB9CC` / `#B79BE0` | `#B04E68` / `#287891` / `#7E4FA0` | dodatkowe serie wykresów                                            |
| ember (błąd)                        | `#FE6171`                         | `#BF2D3E`                         | tylko błędy i alarmy, nigdzie indziej                               |

- **Krój**: stos systemowy (`-apple-system, system-ui`) — na iPhonie i Macu to
  prawdziwy SF Pro jak w aplikacji; Inter jako zapas na innych systemach.
  Tytuł strony jak `EditorialPageHeader`: 28–32 px, heavy, tracking −0,5.
  Liczby w tabelach i kaflach `tabular-nums`.
- **Zaokrąglenia** z aplikacji: karty 18, mniejsze kafle 14–16, arkusze 22–26,
  przyciski i pigułki jako kapsuły.
- **Przyciski** jak `SCSoftButton`: kapsuła w tincie akcentu (16 % / 10 %)
  z tekstem w kolorze akcentu, bez gradientu. Pełny kolor tylko dla jednej
  głównej akcji na ekranie.
- **Szkło** (`backdrop-filter`) tylko na elementach pływających — dolny pasek
  i nagłówek przy przewijaniu, jak Liquid Glass w aplikacji.
- **Kolory pór posiłków i makr** te same co w aplikacji (`SCMacroPalette`,
  paleta pór) — wykres makr w panelu ma być rozpoznawalny od razu.
- **Zasada treści z aplikacji**: każda informacja raz, bez objaśniających
  zdań; „życie” przez kolor, ikonę w tincie, zdjęcie dania i etykiety, nie
  przez tekst. Ani szaro-pusto, ani przegadane.
- Ekrany projektuje Rafał w **Claude Design** z promptu w
  `PROMPT-CLAUDE-DESIGN.md`. Jak przy iOS: biała karta albo cień z makiety to
  nie decyzja do przeniesienia — obowiązują tokeny z tej tabeli.

### Backend — moduł `src/admin/`

- trasy `/admin/*`, osobny guard (`AdminAuthGuard`), osobny limiter
  (tracker `admin:<id>`), `statement_timeout` na ciężkich zapytaniach,
- **strona odczytu**: serwisy zapytań z paginacją kursorem; ciężkie agregaty
  liczone w nocy do `AdminDailyStat` (patrz §6), żeby wykresy nie mieliły
  produkcyjnej bazy przy każdym otwarciu i żeby była HISTORIA (dziś MRR sprzed
  miesiąca trzeba by odtwarzać z wierszy, które od tego czasu się zmieniły),
- **strona zapisu**: logika wyciągnięta z `OpsController` i
  `BillingOpsController` do serwisów, które wołają oba kontrolery — nadanie
  planu, grant, revoke, hold/unhold, reconcile, cost-reset już ISTNIEJĄ,
- OpenAPI tylko dla `/admin` (reszta API zostaje bez Swaggera).

---

## 3. Ukrycie na domenie

Nic z tego osobno nie jest zabezpieczeniem — to warstwy. Zabezpieczeniem jest
§4. Ale im mniej widać, tym mniej ktoś próbuje.

1. **Subdomena `dashboard.scoffie.app`** (D2, 24.09). Świadomie czytelna, nie
   zgadywanka: skaner, który ją trafi, zobaczy wyłącznie ekran logowania
   Cloudflare Access. Chroni §4, nie nazwa.
2. **Certyfikat bez nazwy w logach Certificate Transparency.** Każdy
   certyfikat wystawiony dla konkretnej subdomeny ląduje publicznie w
   crt.sh — tam szuka się paneli w pierwszej kolejności. Subdomena za
   pomarańczową chmurką Cloudflare dostaje certyfikat brzegowy z wildcardem
   `*.scoffie.app` (Universal SSL), więc jej nazwa w CT się nie pojawia.
   **Nie** podpinać custom domain bezpośrednio w Railwayu (Railway wystawiłby
   własny certyfikat z nazwą).
3. **Cloudflare Access przed całością.** Bez przejścia bramki nie widać ani
   jednego bajtu aplikacji (ani JS-a, ani nazw tras).
4. **Backend udaje, że `/admin` nie istnieje.** Żądanie bez ważnego JWT
   Access (nagłówek `Cf-Access-Jwt-Assertion`, weryfikacja po JWKS zespołu
   i `aud` aplikacji) albo bez sesji admina dostaje **404**, nie 401/403.
   Ktoś, kto zgadnie `api.scoffie.app/admin/users` z pominięciem Cloudflare,
   nie dowie się, że trasa jest.
5. `X-Robots-Tag: noindex, nofollow`, `robots.txt` z `Disallow: /`, zero
   linków z `scoffie.app`, **bez publicznych source map**, CSP `default-src 'self'`.
6. Nazwa repo i buildu bez znaczenia dla świata (repo prywatne).

---

## 4. Logowanie — kilka sposobów, dwie warstwy

### Warstwa 0 — Cloudflare Access (bramka przed wszystkim)

- Darmowe do 50 osób. Dostawcy tożsamości (D3, 24.09): **Google** (główny),
  **konto Cloudflare** (IdP dostępny od 05.2026, z 2FA konta) i
  **jednorazowy kod na e-mail** (One-time PIN) — tylko awaryjnie.
  **Bez GitHuba** (dodatkowe konto do przejęcia, nic nie wnosi).
- **Apple NIE w bramce**: Access nie ma go wśród gotowych dostawców, a przez
  ogólne OIDC wymaga sekretu klienta będącego JWT ważnym najwyżej pół roku —
  bramka przestałaby cicho działać. Apple jest w warstwie 1, gdzie backend
  sam podpisuje ten JWT kluczem `.p8` przy każdym logowaniu.
- Polityka: dokładna lista adresów (sam adres Rafała, nie domena), czas sesji
  Access **7 dni** (z telefonu codzienne logowanie do Google byłoby męczące;
  częściej pilnuje sesja warstwy 1). **Bez** blokady kraju — zamknęłaby
  Rafała za granicą; zamiast niej alert o logowaniu z nowego kraju. Stan
  urządzenia (WARP) — nie teraz.
- To załatwia boty, skanery i ataki na formularz logowania: formularz
  logowania panelu w ogóle nie jest osiągalny z internetu.

### Warstwa 1 — własna tożsamość admina

**Osobna tabela `AdminUser`, nie rola na `User`.** Powody: konto w aplikacji
można skasować (RODO), przejęte konto Google w aplikacji nie może dawać
panelu, a token dostępu aplikacji (JWT z `sub` użytkownika) nigdy nie może
otworzyć `/admin`. Inne `aud`, inny sekret, inny cykl życia.

Metody (admin wybiera, ile włączy — minimum dwie, żeby zgubienie jednej nie
zamykało drzwi):

| Metoda                                                                                                                           | Rola           | Uwagi                                                                                                                                                  |
| -------------------------------------------------------------------------------------------------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Passkey (WebAuthn)** — Face ID w Safari na iPhonie, Touch ID na Macu (ten sam klucz z pęku kluczy iCloud); opcjonalnie YubiKey | główna         | sama w sobie jest dwuskładnikowa (urządzenie + biometria), odporna na phishing; kilka kluczy na konto; działa w zwykłej przeglądarce, PWA niepotrzebne |
| **Sign in with Apple** (web, Services ID)                                                                                        | alternatywa    | wiązana po `sub`, nie po adresie (ukryty e-mail Apple); sekret klienta JWT podpisuje backend; wymaga drugiego składnika                                |
| **Google OIDC**                                                                                                                  | alternatywa    | wiązana po `sub`, nie po adresie; wymaga drugiego składnika                                                                                            |
| **TOTP** (Google Authenticator lub dowolna aplikacja TOTP)                                                                       | drugi składnik | sekret szyfrowany jak Cookidoo (AES-256-GCM, klucz w env)                                                                                              |
| **Kody odzyskiwania** (10 × jednorazowe, trzymane jako hasze)                                                                    | ostatnia deska | pokazane raz przy włączeniu 2FA; Rafał trzyma je w menedżerze haseł                                                                                    |

Reguła: **passkey = wejście od razu; Apple / Google + TOTP.** Haseł nie ma.

Świadomie **nie ma**: **SMS** (przejęcie numeru na nową kartę SIM, koszt
dostawcy, nic ponad TOTP) i **linku na e-mail w warstwie 1** (poczta to to
samo konto Google — nie byłby niezależnym składnikiem; kod na e-mail zostaje
tylko jako awaryjne wejście przez bramkę). Później, z iOS: zatwierdzenie
logowania w aplikacji Scoffie.

Na co dzień z telefonu: bramka Google raz na 7 dni, potem Face ID mniej
więcej dwa razy dziennie.

### Sesje

- `AdminSession` w bazie; ciasteczko `__Host-scoffie_admin`, `HttpOnly`,
  `Secure`, `SameSite=Strict`; 30 min bezczynności, 12 h twardo.
- Lista aktywnych sesji w panelu (urządzenie, IP, kraj z Cloudflare, ostatnia
  aktywność) i „wyloguj tę / wszystkie".
- **Step-up** — ponowne potwierdzenie passkeyem albo TOTP przed akcjami, które
  bolą: usunięcie konta, cofnięcie subskrypcji, nadanie PRO, zmiana
  konfiguracji w locie, publikacja przepisu do katalogu, odsłonięcie danych
  o zdrowiu. Ważne 5 min.
- **Alert przy każdym logowaniu** — mail przez istniejący outbox
  (`MailMessage`) + `OpsAlertService` (webhook). Nowe urządzenie / nowy kraj =
  alert wyraźniejszy.
- Blokada po 5 nieudanych próbach na 15 min, licznik per admin i per IP.

### Role (na później — dziś jest jeden admin)

`OWNER` (wszystko) · `SUPPORT` (użytkownicy i domy bez danych o zdrowiu
i bez pieniędzy, wnioski RODO) · `CONTENT` (tylko katalog) · `VIEWER`
(pulpit i wykresy). Uprawnienia jako lista napisów (`users.read`,
`users.health.reveal`, `billing.write`, `catalog.publish`, …), rola to tylko
ich zestaw. Łatwo dołożyć osobę na umowie bez dawania jej wszystkiego.

---

## 5. Funkcje panelu — moduł po module

Przy każdym: skąd biorą się dane i co trzeba dobudować.

### 5.1 Pulpit

Jedno spojrzenie rano. Kafle z trendem (vs wczoraj / 7 dni):

- użytkownicy: wszyscy, nowi, aktywni dziś / 7 / 30 dni,
- gospodarstwa: wszystkie, z planem na ten tydzień,
- asystent: tury dziś, koszt dziś vs `AI_GLOBAL_DAILY_BUDGET_USD`, odsetek porażek,
- pieniądze: MRR, aktywne subskrypcje, w łasce płatniczej (GRACE), wyłączone
  auto-odnowienie (ryzyko odejścia),
- zdrowie: commit na produkcji (`/ops/health`), crash-free z Sentry, maile
  FAILED, nieprzetworzone powiadomienia Apple, ostatnia nocna kopia bazy,
- kolejka: nowe zgłoszenia odpowiedzi asystenta.

Dane: wszystko poniżej. Nowe: `AdminDailyStat`, aktywność dzienna (§6).

### 5.2 Użytkownicy

Lista z wyszukiwaniem (imię, e-mail, id), filtry: dostawca logowania
(GOOGLE / APPLE), kreator ukończony / nie, ma subskrypcję, aktywny w 7 dniach.

Karta osoby:

- **tożsamość**: `displayName`, `email` (+ czy `@privaterelay`), `authProvider`,
  `createdAt`, `lastLoginAt`, `onboardingCompletedAt`, kolor awatara,
- **gospodarstwa**: `Membership` z rolą OWNER / MEMBER, link do karty domu,
- **urządzenia**: `PushDevice` (APNs SANDBOX / PRODUCTION, `lastSeenAt`,
  aktywne), **wersja aplikacji i iOS** — tego dziś NIE ma (§7),
- **sesje**: liczba aktywnych rodzin `RefreshToken`, ostatnie powody
  unieważnienia (ROTATED / REUSE / RECOVERED — REUSE to sygnał przejęcia),
  akcja „Wyloguj zewsząd" (logika `logoutEverywhere` już jest),
- **zgody**: oś `ConsentEvent` (TERMS, PRIVACY, AI_ASSISTANT, COOKIDOO, AGE_16;
  wersja dokumentu, `appVersion`), czy zgoda jest aktualna,
- **asystent**: tury, koszt w tym miesiącu i łącznie, zgłoszenia, notatki
  pamięci o tej osobie (liczba; treść za „Odsłoń"),
- **subskrypcje**, które ta osoba kupiła (`Subscription.purchaserUserId`),
- **maile**: `MailMessage` do tej osoby (szablon, status, `sentAt`, błąd),
  czy adres jest na `MailSuppression`,
- **aktywność**: kroki — tylko źródło i czy synchronizuje (`DailyStepCount.source`),
  zjedzone posiłki (`PlanItemConsumption`, liczba),
- **zakryte do „Odsłoń"**: rok urodzenia, wzrost, waga, płeć, cel, dieta,
  alergeny, makra, `excludedIngredientIds`,
- **RODO**: eksport danych (moduł `data-export` już jest — art. 15 / 20),
  usunięcie konta (ta sama ścieżka co z telefonu, z mailem pożegnalnym),
  każde z powodem i step-upem.

Podgląd „jak użytkownik" — **tylko do odczytu** i tylko planu / listy zakupów
(np. do reklamacji „nie widzę obiadu w czwartek"). Bez podszywania się pod
sesję.

### 5.3 Gospodarstwa

Lista: nazwa, liczba domowników, plan (TRIAL / PRO i SKĄD: nadanie operatora
`tierOverride` / subskrypcja domownika / próba), aktywność.

Karta domu:

- domownicy + role, zaproszenia (otwarte, przyjęte, odrzucone, wygasłe),
- plan: które pory ma włączone (`enabledMealTypes`), godziny (`mealSlotTimes`),
  tygodnie z planem, liczba pozycji na tydzień, „Wspólne" vs rozdzielone
  dania (`PlanItemParticipant`),
- lista zakupów: czy używana (odhaczenia, archiwa, dopisane „brakuje mi"),
- ulubione (`RecipeFavorite`), przepisy prywatne domu (liczba — treść to dane
  domu, nie pokazujemy),
- **Cookidoo**: status, `lastErrorCode`, `lastVerifiedAt` — NIGDY dane logowania
  (i tak są write-only),
- asystent: pula bieżąca (licznik vs limit, także migawka limitu z chwili
  zakupu), koszt miesiąca vs `AI_HOUSEHOLD_MONTHLY_COST_USD`, rozmowy (liczba),
  propozycje wg statusu,
- akcje: nadanie PRO / TRIAL / zdjęcie (jest), reset licznika kosztu (jest),
  unieważnienie otwartych zaproszeń.

### 5.4 Asystent — zużycie, limity i czy na nim zarabiam

Serce panelu. Dane są prawie w komplecie: `AiUsage` (koszt w mikrodolarach,
model, wysiłek, tokeny z cache osobno, `apiCalls`, latencja, `stopReason`),
`AgentTurn` (status, `errorCode`, `quotaScopeId`, `quotaRefunded`, czas),
`AiUsageCounter` (liczniki per zakres i okres), `AgentProposal` (statusy).

**Ważne: rentowność liczy się per ZAKRES PULI, nie per dom.** Subskrypcja
należy do osoby, pula wędruje z nią (`sub:<id>`), próba to `trial:<hasz>`,
nadanie operatora to UUID domu. Koszt przypisujemy po `AgentTurn.quotaScopeId`
(i `AgentProposal.quotaScopeId` dla zapisów). Widok „per dom" i „per osoba"
to dodatkowe przekroje, ale wynik finansowy — per subskrypcja.

Widoki:

- **Rentowność per subskrypcja / plan** (Solo 29,99, We dwoje 39,99,
  Rodzina 49,99; roczne): przychód netto (cena ÷ 1,23 VAT × 0,85 po prowizji
  Apple, przeliczony po kursie NBP z dnia) minus koszt modelu = marża; lista
  „pod kreską". Ta sama arytmetyka co `docs/plans/scoffie-ai-agent/cennik-i-limity-2026-09.md`
  i `unit_econ.py` — przenieść do serwisu, nie liczyć drugi raz inaczej.
- **Koszt próby** — ile kosztuje nas osoba na puli próbnej, która nie kupiła
  (= koszt pozyskania klienta), i konwersja próba → zakup.
- **Rozkład kosztu**: histogram kosztu na zakres w miesiącu, top 20
  najdroższych, udział top 5 % w całości.
- **Jakość i sprawność tury**: p50 / p95 czasu, rozkład `apiCalls` (ogon rund
  narzędzi = ucieczki), trafienia w cache (`cacheReadTokens` / wejście),
  koszt per rodzaj tury, powody `stopReason`, kody błędów, LIMITED, zwroty kwoty.
- **Propozycje**: lejek PENDING → APPLIED / UNDONE / STALE / EXPIRED / FAILED.
  Odsetek przyjętych i cofniętych to najlepsza miara „czy asystent trafia".
- **Model / wysiłek**: porównanie kosztu i czasu, gdy zmienia się `AI_MODEL`,
  `AI_MODEL_TOOLS`, `AI_EFFORT` (znaczniki zmian konfiguracji na wykresie).
- **Uzgodnienie z Anthropic** — Admin API (usage & cost report) dzień po dniu
  vs suma `AiUsage.costMicroUsd`. `costMicroUsd` liczy NASZ kod z tabeli cen;
  rozjazd > kilka % = tabela cen w kodzie się zestarzała.
- **Pula globalna**: dzienne zużycie vs `AI_GLOBAL_DAILY_BUDGET_USD`, alert przy 80 %.

Istniejące narzędzie `pnpm agent:report:usage` liczy część tego z terminala —
serwis panelu powinien je zastąpić (ten sam kod, dwa wyjścia).

### 5.5 Zgłoszenia odpowiedzi (moderacja)

`AgentReport` (wymóg App Store 1.2 / 4.7) — dziś tylko się zapisuje.

- kolejka: powód, komentarz, migawka treści, data; metadane tury (model,
  koszt, kroki, kod) po `turnId`,
- **do dobudowania**: `status` (NEW / REVIEWED / ACTIONED / DISMISSED),
  `resolvedAt`, `resolvedByAdminId`, `resolution`, etykieta przyczyny
  (halucynacja składu, alergen, ton, odmowa…),
- akcja „Zamień w scenariusz benchmarku" — eksport do formatu
  `pnpm agent:scenarios`, żeby każde zgłoszenie mogło stać się testem regresji.

### 5.6 Subskrypcje i przychód

Dane: `Subscription` (status, produkt, `environment` Sandbox / Production,
`ownershipType` FAMILY_SHARED, `expiresAt`, `graceExpiresAt`,
`autoRenewStatus`, `revokedAt`, `operatorHoldAt`, migawki limitów,
`lastVerifiedAt`), `AppleNotification` (surowy ładunek, błędy, próby).

- MRR / ARR, nowe, odnowienia, odejścia, reaktywacje — dzień po dniu
  (z `AdminDailyStat`),
- **ryzyko odejścia**: wyłączone auto-odnowienie, łaska płatnicza, długo
  nieuzgadniane (`lastVerifiedAt`),
- zwroty i cofnięcia, Chmura Rodzinna,
- dziennik powiadomień Apple z nieudanymi i akcją „przetwórz ponownie",
- akcje (już są w `BillingOpsController`): reconcile, revoke, hold / unhold,
  grant, podgląd użycia subskrypcji,
- **App Store Connect API** — raporty Sales & Trends i Finance, czyli co Apple
  NAPRAWDĘ wypłaca (prowizja, VAT, kurs); przychód wyliczony z cennika to
  przybliżenie, raport finansowy to prawda,
- kurs USD/PLN z API NBP (darmowe, `api.nbp.pl`) zapisywany codziennie.

### 5.7 Katalog przepisów i składników

Dane: `Recipe` (+ `RecipeIngredient`), `Ingredient` (wartości na 100 g,
`gramsPerPiece`, alergeny, tagi diet), `IngredientAlias`.

- lista z filtrami: pora (`mealType`, `suitableMealTypes`), alergeny, tagi
  diet, aktywne / wycofane, **luki** (bez zdjęcia, zerowe makro, składnik bez
  wartości odżywczych, bez `gramsPerPiece` przy `szt`),
- **edytor przepisu**: tytuł, opis, kroki (`sourceInstructions`), czas,
  trudność, porcje (1–8), pory, zdjęcie (upload do R2), składniki z ilością
  i jednostką → **serwer** przelicza makro, sól, alergeny i tagi diet tymi
  samymi funkcjami co import (`recipe-nutrition.util`, reguły z
  `diet-rules.util` — parytet z iOS),
- szkic → podgląd „jak w aplikacji" → publikacja (step-up); wycofanie
  (`isActive = false`) pokazuje najpierw, w ilu planach przepis stoi,
- **historia wersji** (`RecipeRevision`) i przywracanie,
- **edytor składnika**: wartości na 100 g, aliasy, alergeny, tagi diet;
  zmiana tagu → przeliczenie wszystkich przepisów z tym składnikiem (logika
  `pnpm catalog:ingredients:tags`),
- **popularność**: ile razy w planach (`PlanItem`), ulubione, zjedzone
  (`PlanItemConsumption`), proponowane przez asystenta (`AgentProposal.action`),
  nigdy nieużyte; najczęściej omijane składniki (agregat).

Przepisy prywatne domów (`isCatalog = false`) — tylko liczby, bez treści.

**Decyzja D1 (§9) zamknięta 25.09: baza jest źródłem prawdy**, plik JSON
jej eksportem (nocny PR z `catalog-sync`). Edytor przepisu zapisuje od razu
— tymi samymi funkcjami co import. Zostało: zdjęcie (upload do R2), nowy
przepis z panelu, historia wersji.

### 5.8 Zaangażowanie, lejek, retencja

Z dat, które już są w bazie:

- **lejek**: rejestracja (`User.createdAt`) → kreator (`onboardingCompletedAt`)
  → dom (`Membership`) → pierwszy plan (`WeeklyPlan` / `PlanItem`) → zgoda na
  asystenta (`ConsentEvent` AI_ASSISTANT) → pierwsza tura (`AgentTurn`) →
  wyczerpana próba (`AiUsageCounter`) → zakup (`Subscription.createdAt`),
- **wirusowość**: zaproszenia wysłane / przyjęte na dom, wielkość domów,
- **użycie funkcji**: lista zakupów (odhaczenia, archiwa, „brakuje mi"),
  Kalendarz (zjedzone), kroki (źródło APPLE_HEALTH / GARMIN), Cookidoo,
  pory posiłków (rozkład `enabledMealTypes`), rozkład diet, celów i alergenów
  (tylko agregaty),
- powiadomienia: odsetek wyłączonych kanałów, cisza nocna.

**Retencji w kohortach nie da się policzyć z `lastLoginAt`** (trzyma tylko
ostatnie logowanie). Potrzebna mała tabela aktywności (§6).

### 5.9 Stabilność i jakość (integracje)

- **Sentry** (iOS `scoffie/scoffie-ios` + backend): crash-free users / sessions
  per wydanie (Release Health), nowe i nierozwiązane problemy z 24 h, top
  problemy; na karcie użytkownika jego zdarzenia (iOS ustawia `user.id`,
  więc wyszukiwanie po id działa). Backend wysyła też metryki
  `scoffie.agent.*` — do pokazania obok.
- **Backend**: `/ops/metrics` (HTTP, WebSocket, asystent w procesie, cache,
  stan migracji) — wykres na żywo.
- **Railway** (GraphQL API): ostatnie deploye, status, CPU / pamięć.
- **Postgres**: rozmiar bazy i tabel, połączenia, wolne zapytania
  (`pg_stat_statements`, jeśli włączymy).
- **Kopia bazy**: kiedy ostatnia udana i czy próba odtworzenia przeszła —
  `db-backup` musi zostawiać znacznik (np. plik statusu w R2), panel go czyta.
- **Xcode Cloud / TestFlight** (App Store Connect API): ostatnie buildy,
  wersja w TestFlight, wersja w sklepie.
- **App Store**: oceny i recenzje (`customerReviews`), odpowiedź z panelu.
- **Cloudflare** (Analytics GraphQL): ruch na `scoffie.app`, wejścia na
  landing zaproszeń.

### 5.10 Poczta i powiadomienia

- skrzynka nadawcza `MailMessage`: filtr po statusie / szablonie, błędy,
  „wyślij ponownie", podgląd szablonu z przykładowymi danymi,
- `MailSuppression`: lista, dodanie MANUAL, zdjęcie (z powodem),
- statystyki Resend (dostarczone, odbite, skargi),
- push: urządzenia, **wyślij testowy push na własne urządzenie**.
  Rozsyłki marketingowe — nie w tej roadmapie (wymagają osobnej zgody).

### 5.11 RODO i zgodność

- rejestr wniosków (dostęp, usunięcie, sprostowanie) z terminem 30 dni —
  dziś to ręczny `docs/rodo-wnioski.md`,
- zgody: ile osób ma nieaktualną wersję dokumentu po zmianie polityki,
- retencja: czy chodzą porządki (rozmowy 90 dni, `MailMessage.scrubbedAt`),
- przegląd dziennika audytu panelu (§1.2).

### 5.12 Sterowanie w locie

Dziś przełączniki asystenta i limity to zmienne na Railwayu. Większość i tak
jest czytana PER ŻĄDANIE (`AgentConfigService`, `readThrottleLimit`), więc
podmiana źródła jest tania:

- `RuntimeSetting` w bazie z env jako wartością domyślną; cache 30 s,
- w panelu: `AI_ENABLED` (**wyłącznik awaryjny asystenta**), `AI_CARDS_MODE`,
  limity puli, `AI_MAX_TURN_COST_USD`, `AI_GLOBAL_DAILY_BUDGET_USD`,
  `AI_ALLOWED_USERS`, `THROTTLE_*`,
- każda zmiana: step-up, powód, audyt, alert, znacznik na wykresach,
- sekrety (klucze API, `JWT_*`) NIGDY tutaj — zostają w Railwayu,
- później: flagi funkcji per dom (bety) i komunikat w aplikacji — wymagają
  zmian w iOS.

Zrobione 25.09: `RuntimeSetting` + `/admin/settings` (ekran „Sterowanie”) dla
`AI_ENABLED`, `AI_MAX_TURN_COST_USD`, `AI_GLOBAL_DAILY_BUDGET_USD`, limitów
puli i próby oraz `AI_ALLOWED_USERS` (biała lista w
`src/config/runtime-settings.ts`). Jeszcze nie: `AI_CARDS_MODE`, `THROTTLE_*`,
znacznik zmiany na wykresach.

### 5.13 Alerty i raport dzienny

- centrum alertów w panelu (to, co dziś idzie tylko przez `OpsAlertService`),
- progi: koszt zakresu > X % przychodu, globalny budżet 80 %, nieudane
  powiadomienia Apple, maile FAILED, crash-free < 99 %, REUSE refresh tokenu,
- **mail „Scoffie wczoraj"** o 7:00: nowi, aktywni, przychód, koszt, marża,
  błędy, zgłoszenia — przez istniejący outbox.

---

## 6. Co dobudować w backendzie (schemat i serwisy)

| Nowe                                                                                                             | Po co                                                                                                         |
| ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `AdminUser`, `AdminCredential` (passkeys), `AdminTotp`, `AdminRecoveryCode`, `AdminSession`, `AdminLoginAttempt` | §4                                                                                                            |
| `AdminAuditEvent` (tylko dopisywanie)                                                                            | §1.2 — `adminId`, `action`, `targetType`, `targetId`, `reason`, `diff` bez danych wrażliwych, IP, `requestId` |
| `AdminDailyStat` (dzień × metryka × wymiar)                                                                      | historia i szybkie wykresy, liczone w nocy                                                                    |
| `UserActivityDay (userId, date)`                                                                                 | retencja i kohorty; upsert raz dziennie przy pierwszym żądaniu / połączeniu socketu                           |
| `RecipeRevision`                                                                                                 | historia wersji przepisu                                                                                      |
| `RuntimeSetting`                                                                                                 | §5.12                                                                                                         |
| `FxRate (date, pair, rate)`                                                                                      | przychód w USD po kursie z dnia                                                                               |
| `IntegrationSnapshot`                                                                                            | cache odpowiedzi Sentry / ASC / Railway (limity ich API, szybki pulpit)                                       |
| `AgentReport` + kolumny statusu                                                                                  | §5.5                                                                                                          |
| `PushDevice` / sesja + `appVersion`, `osVersion`                                                                 | §7                                                                                                            |

Serwisy: `AdminAuthService` (+ `@simplewebauthn/server`, `otplib`),
`AdminAuditService`, `AdminStatsJob` (noc), `UnitEconomicsService` (jedno
źródło arytmetyki przychód / koszt), klienci integracji (Sentry, Anthropic
Admin API, App Store Connect, NBP, Railway, Cloudflare, Resend).

Testy e2e: `/admin` bez sesji = 404, bez JWT Access = 404, każda akcja zapisu
ma wpis audytu, rola bez uprawnienia = 404, step-up wymagany tam, gdzie trzeba.

---

## 7. Zmiany w aplikacji iOS

Panel prawie nie wymaga zmian w telefonie. Jedna ważna:

- **Wersja aplikacji i systemu w każdym żądaniu** (nagłówek, np.
  `X-Scoffie-Client: ios/1.4.0 (212); iOS 26.1; iPhone17,3`) + to samo
  w handshake socketu. Dziś wersja trafia tylko do `ConsentEvent`. Bez niej
  nie wiadomo, ile osób siedzi na starym buildzie — a to jest pytanie przy
  każdym kontrakcie „zostaje na jedno wydanie" (np. pole `userId`
  w payloadach socketu, wycofywana kolumna `Invitation.token`).
- Później (§5.12): flagi funkcji i komunikaty w aplikacji.

---

## 8. Etapy

| Etap                        | Zakres                                                                                                                                                                                                                                                                                        | Wynik                                                   |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| **0. Fundament**            | repo `scoffie-admin` (React 19 + Vite 8 + TS + TanStack Router/Query + shadcn/ui z tokenami iOS + układ RWD), Worker z proxy, Cloudflare Access, subdomena; `src/admin/` z 404 dla obcych, `AdminUser` + passkey + Apple + Google + TOTP + kody odzyskiwania, sesje, audyt, alert o logowaniu | można się bezpiecznie zalogować i zobaczyć pusty pulpit |
| **1. Wgląd** (tylko odczyt) | pulpit, użytkownicy, gospodarstwa, subskrypcje, asystent: zużycie i rentowność, kolejka zgłoszeń; nagłówek wersji z iOS                                                                                                                                                                       | wiesz, co się dzieje i czy zarabiasz                    |
| **2. Operacje**             | akcje przeniesione z `/ops` i `/billing/ops` do panelu, wyloguj zewsząd, eksport / usunięcie konta (RODO), statusy zgłoszeń, skrzynka maili i wykluczenia, step-up, „Odsłoń"                                                                                                                  | koniec z curlem na co dzień                             |
| **3. Katalog**              | edytor przepisów i składników, przeliczanie, zdjęcia do R2, wersje, publikacja, popularność                                                                                                                                                                                                   | przepisy bez JSON-a i importu                           |
| **4. Integracje**           | Sentry, Anthropic cost report, App Store Connect (finanse, recenzje, TestFlight, Xcode Cloud), NBP, Railway, Cloudflare, Resend; centrum alertów, mail dzienny                                                                                                                                | jedno miejsce zamiast sześciu kart przeglądarki         |
| **5. Analityka**            | `UserActivityDay`, kohorty, lejek, użycie funkcji, historia z `AdminDailyStat`                                                                                                                                                                                                                | retencja i konwersja w liczbach                         |
| **6. Sterowanie**           | `RuntimeSetting` + wyłącznik asystenta, flagi funkcji, role dla kolejnych osób, komunikaty w aplikacji (z iOS)                                                                                                                                                                                | zmiana limitu bez redeployu                             |

Etapy 1 i 2 dają najwięcej. Etap 3 czeka na decyzję D1.

---

## 9. Decyzje otwarte

- ~~**D1. Źródło prawdy katalogu**~~ — zamknięte 25.09: **A**. Baza jest
  źródłem prawdy, `prisma/catalog/recipes-catalog-full-v2.json` jej eksportem
  (`pnpm catalog:export`), odświeżanym co noc PR-em do `develop` z serwisu
  cron `catalog-sync` (`ops/catalog-sync/`, 03:45 UTC). Panel zapisuje od
  razu (`PUT /admin/catalog/recipes/:id`, step-up, 409 przy konflikcie);
  `recipes:import:json` na niepustym katalogu odmawia nadpisania zmian
  z bazy bez `RECIPE_IMPORT_FROM_JSON_CONFIRM=<data>`.
- ~~**D2. Nazwa subdomeny**~~ — zamknięte 24.09: `dashboard.scoffie.app` (§3).
- ~~**D3. Metody logowania**~~ — zamknięte 24.09: bramka Google / konto
  Cloudflare / kod na e-mail; panel Face ID albo Apple / Google + Google
  Authenticator; kody odzyskiwania; bez SMS i bez PWA (§4).
- ~~**D4. Stos frontu**~~ — zamknięte 24.09: React + shadcn/ui, wybór Claude'a (§2).
- ~~**D5. Czy panel dostanie ktoś poza Rafałem**~~ — zamknięte 24.09: na razie
  nie. Jedna rola `OWNER`, ale uprawnienia w kodzie od początku jako lista
  napisów, więc druga osoba to konfiguracja, nie przebudowa.
- **D6. Aktualizacja dokumentów RODO**: rejestr czynności / DPIA musi
  wymienić panel, Cloudflare Access (podmiot przetwarzający — Cloudflare jest
  już dostawcą strony) i dziennik audytu z jego retencją.
