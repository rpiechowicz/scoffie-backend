# Scoffie — przegląd ekosystemu do niezależnej oceny (26.09.2026)

**Dla kogo:** drugi agent / recenzent, który ma spojrzeć na całość chłodnym
okiem. Dokument jest celowo ogólny — szczegóły są w repo (ścieżki niżej).
**Prośba:** oceń krytycznie. Nie potwierdzaj tego, co już postanowiliśmy, tylko
szukaj luk, złych założeń i prostszych rozwiązań. Jeśli coś jest przerostem
formy nad treścią na tym etapie — napisz to wprost.

## 1. Czym jest Scoffie

Aplikacja do planowania posiłków dla gospodarstwa domowego (PL): katalog
przepisów (500, cel: tysiące), plan tygodnia per dom z porcjami i
domownikami, lista zakupów liczona z planu, kalendarz „co dziś jem", cele
kaloryczne i makro, alergeny i diety. Płatna część: **asystent AI**
(subskrypcja Apple: Solo / We dwoje / Rodzina, 29,99–49,99 zł/mies.), który
układa plan i odpowiada na pytania. Stan: aplikacja w App Store, **brak
płacących subskrybentów**, jeden deweloper (Rafał) + agenci.

## 2. Repozytoria i architektura

| Repo | Co | Hosting |
|---|---|---|
| `scoffie-backend` | NestJS 11 + Prisma 6 + Postgres + Socket.IO; REST + WS; asystent AI w `src/agent/`; panel admina (`/admin/*`) | Railway, **jedna instancja** |
| `scoffie-ios` | SwiftUI | App Store (Xcode Cloud) |
| `scoffie-web` | Astro, statyczna strona | Cloudflare Workers |
| `scoffie-cookidoo` | Python, integracja Thermomix | Railway |
| panel admina (front) | React + shadcn (plan w `docs/plans/scoffie-admin/ROADMAPA.md`) | Cloudflare, za Cloudflare Access |

Kluczowe zasady (z `CLAUDE.md` backendu): błędy jako kody, bramki członkostwa
przed odczytem, zamek zapisu tygodnia i jedna kolejność blokad, walidacja
DTO także na WS, RODO (dane o zdrowiu tylko za zgodą, retencje).

**Asystent:** REST `POST /agent/.../messages` → 202 + odpytywanie tury co 1 s;
tura biegnie w procesie API (25–240 s); model Claude Sonnet 5 (adaptive
thinking, effort medium); pętla narzędzi (≈24 narzędzia); model PROPONUJE
(karta), człowiek zatwierdza jednym kliknięciem; alergeny i wykluczenia
pilnuje serwer, nie model. Koszt zapisywany per faza w `AiUsage`, limity
w `AiUsageCounter`.

## 3. Co zrobiliśmy w tej sesji (24–26.09.2026)

1. **Plan panelu administratora** (CRM do zarządzania aplikacją) —
   `docs/plans/scoffie-admin/ROADMAPA.md`. Panel jest od tego czasu w dużej
   części zbudowany na `develop` (logowanie passkey/TOTP, sterowanie w locie,
   przychód, lejek, katalog, alerty).
2. **Wyszukiwarka przepisów dla asystenta** —
   `docs/plans/scoffie-ai-agent/wyszukiwarka-i-tempo-2026-09.md`.
   Wcześniej cały katalog (≈60 tys. tokenów przy 500 przepisach) jechał
   w prompcie każdego wywołania modelu. Teraz w prompcie jest mapa katalogu
   (≈1,8 tys. znaków), a dania model bierze z narzędzia `find_recipes`:
   filtry twarde jedzących (te same reguły co walidator planu), kryteria
   z prośby, ranking (plan tygodnia, ulubione, wspólne składniki,
   popularność), dywersyfikacja. Indeks w pamięci procesu. Przełącznik
   `AI_CATALOG_MODE=digest` przywraca stary tryb bez deployu.
3. **Tempo tury:** karta kończąca turę (propozycja, wybór dań, pytanie) nie
   wymaga już ostatniej rundy modelu, jeśli model napisał zdanie w tej samej
   wiadomości. Podgrzewanie cache prefiksu — zbudowane, **domyślnie
   wyłączone** (przy braku ruchu to koszt bez zysku).
4. **Bez benchmarku na żywym modelu** (decyzja budżetowa). Testy
   jednostkowe i e2e na prawdziwym katalogu przechodzą, ale **zachowanie
   modelu w nowym trybie nie jest zmierzone**. Wszystkie liczby
   oszczędności to szacunki.

## 4. Znane słabe punkty (z audytu kodu 26.09, do weryfikacji)

**Asystent**
- Model sam wypisuje cały tydzień (21–42 pozycje) i sam dopasowuje kalorie —
  to ~50 s i najwięcej tokenów; w pomiarach tygodnie wychodziły 230–590
  kcal/dzień poniżej celu. Pomysł: serwer układa szkic (deterministycznie),
  model tylko go koryguje i objaśnia.
- Historia rozmowy wraca do modelu jako sam tekst, bez stanu kart —
  po „Wybieram: X" / „Zamień w tej propozycji…" model nie widzi poprzedniej
  propozycji i układa ją od nowa (koszt i ryzyko innego wyniku).
- „Co na kolację?" to dwie rundy (`find_recipes` → `offer_options`);
  można jedną, gdyby karta wyboru szukała sama.
- Bilans dnia pytającego nie jest w prompcie → osobna runda
  `get_week_balance` przy pytaniach o kalorie.
- Sprzeczność: dane domowników są już w prompcie, a instrukcje i opisy
  narzędzi każą wołać `get_household_context`.
- `apply_week_plan` (tryb zapisu bez karty) jest praktycznie martwy, a waży
  w schematach; budżet pól opcjonalnych narzędzi wyczerpany (24/24 — limit API).
- Effort `medium` na każdej rundzie, także na prostych odczytach.

**Baza i infrastruktura**
- Każdy telefon pobiera CAŁY katalog po WebSocket (≈1 MB przy 500
  przepisach, ≈10 MB przy 5 tys.) przy starcie i każdym ponownym połączeniu —
  bez wersji, ETag i kompresji.
- Odświeżenie tokenu limitowane per IP (20/min) — ryzyko 429 za NAT-em
  operatora komórkowego po deployu.
- Deploy zabija trwające tury asystenta (biegną w procesie API) i gubi ich
  koszt w księdze; rozmowa jest zablokowana ~4 min.
- Odczyt listy zakupów potrafi ją przebudowywać (zapis w odczycie), N
  telefonów domu robi to po kolei po każdej zmianie planu.
- Cache listy przepisów prawie nie trafia (klucz per dom), czyszczony
  w całości przy każdym polubieniu.
- Streaming odpowiedzi zapisuje cały szkic do bazy co 350 ms; odpytywanie
  tury to ~4 zapytania/s na aktywną turę.
- **Wszystko zakłada JEDNĄ instancję:** Socket.IO bez adaptera Redis,
  limity żądań w pamięci, zatrzymanie tury tylko na własnej instancji,
  zadania `setInterval` w każdej instancji, wsadowanie pushy w pamięci.
- Brak jawnej konfiguracji puli połączeń Prisma i `statement_timeout`;
  kilka brakujących indeksów (m.in. `AgentMessage.turnId`).

**Model / dostawca**
- Rozważamy GPT-6 Sol / Luna i Gemini. Wstępnie: cena Sol = Sonnet 5, więc
  zmiana nie oszczędza; realną dźwignią jest effort i liczba rund. Rezydencja
  danych w UE (dane o zdrowiu) jest dziś niezałatwiona: bezpośrednie API
  Anthropic nie ma regionu UE (Bedrock / Vertex EU tak; OpenAI ma
  `eu.api.openai.com`). Ceny i benchmarki z tej analizy pochodzą ze źródeł
  wtórnych — do potwierdzenia.

## 5. Ogólne plany

- Asystent: zmierzyć nowy tryb (`agent:scenarios`), potem szkic tygodnia po
  stronie serwera, stan kart w historii, mniej rund w typowych pytaniach,
  niższy effort tam, gdzie wolno.
- Aplikacja: katalog na telefon przyrostowo (wersja + zmiany) zamiast
  całości; poprawki limitów auth; tury asystenta odporne na deploy.
- Skala: dopiero gdy będzie potrzebna druga instancja — Redis (adapter
  Socket.IO, limity), kolejka zadań dla tur i jobów, blokady dla cronów.
- Panel admina: dokończenie i utrzymanie; źródło prawdy katalogu = baza.

## 6. Pytania do recenzenta

1. Czy kolejność priorytetów ma sens dla aplikacji BEZ płacących
   użytkowników? Co jest przedwczesną optymalizacją, a co ryzykiem, które
   trzeba zamknąć przed pierwszymi subskrybentami?
2. Czy architektura asystenta (REST + odpytywanie, tura w procesie API,
   pętla narzędzi, karty zatwierdzane przez człowieka) jest właściwa?
   Co zrobiłbyś inaczej od zera?
3. Szkic planu po stronie serwera (optymalizacja pod kalorie, różnorodność,
   wspólne składniki) + model jako „redaktor" — dobry kierunek czy
   komplikacja?
4. Model: zostać przy Claude, testować GPT-6 / Gemini, czy od razu warstwa
   wielu dostawców? Jak rozwiązać rezydencję danych w UE?
5. Czy jedna instancja Railway z Postgresem wystarczy na pierwsze 10 tys.
   użytkowników, jeśli naprawimy punkty z §4?
6. Czego tu brakuje (obserwowalność, testy, bezpieczeństwo, produkt)?

## 7. Gdzie szukać szczegółów

- `scoffie-backend/CLAUDE.md` — konwencje i decyzje.
- `docs/handover/2026-08-28-stan.md` — stan projektu.
- `docs/plans/scoffie-ai-agent/` — asystent: koszty (`cost-model.md`,
  `cennik-i-limity-2026-09.md`), tempo (`tempo-2026-09-24.md`), wyszukiwarka
  (`wyszukiwarka-i-tempo-2026-09.md`), roadmapa (`roadmapa-asystenta-2026-09.md`).
- `docs/plans/scoffie-admin/ROADMAPA.md` — panel admina.
- `scoffie-ios/CLAUDE.md` — aplikacja iOS.
