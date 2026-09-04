# Runbook incydentu — Weekly Meals (backend + Cookidoo)

Jeden dokument na „coś się dzieje": co sprawdzić w tej kolejności, co wolno
zrobić bez namysłu, a co wymaga decyzji. Runbooki wdrożeniowe konkretnych
zmian są w `docs/plans/**/PROD-RUNBOOK.md` — to nie one.

## 0. Zanim cokolwiek zrobisz (2 minuty)

1. `GET https://<backend>/ops/health` → `status`, `commit`. Odpowiada? Jaki commit?
2. Railway → serwis **Backend** → Deployments: ostatni deploy zielony? Logi z ostatnich 15 minut.
3. `GET /ops/metrics` z nagłówkiem `x-ops-token` → `migrations`, `agent`, `http`.
4. Sentry (projekt EU) → Issues z ostatniej godziny.
5. Zapisz godzinę (UTC) i commit — przyda się do PITR i do raportu.

## 1. Serwis nie odpowiada / 502 z Railway

| Objaw | Najczęstsza przyczyna | Co robić |
|---|---|---|
| Deploy czerwony, kontener restartuje się w kółko | `safe-migrate` padł (migracja) albo `assert-env` odmówił startu (brak/zły sekret) | Logi deployu: szukaj `[safe-migrate]` albo `assert-env`. Migracja: patrz §3. Env: uzupełnij zmienną, Redeploy. |
| Deploy zielony, `/ops/health` nie odpowiada | Proces wisi (OOM, pętla) | Railway → Restart. Jeśli wraca: rollback do poprzedniego deployu (Deployments → ⋯ → Rollback). |
| `/ops/health` OK, aplikacja „Problem z połączeniem" | WebSocket (Socket.IO) albo CORS | `/ops/metrics → ws` (handshakes/odmowy). Sprawdź `CORS_ORIGIN`, `WS_AUTH_MODE`. |
| Wszystko OK, ale wolno | Baza (locki, PITR w toku) albo Anthropic | Railway → Postgres → Metrics; `/ops/metrics → agent.upstream`. |

**Rollback deployu** (bez zmian w bazie): Railway → Deployments → poprzedni zielony → Rollback.
Rollback po migracji, która zmieniła schemat, jest osobną decyzją — patrz §3.

## 2. Baza danych

- **Padła / niedostępna**: Railway → Postgres → Restart. Backend sam się podniesie (healthcheck).
- **Uszkodzone dane / omyłkowe kasowanie**:
  1. Zatrzymaj źródło (wyłącz serwis Backend albo ustaw `AI_ENABLED=false`, jeśli to asystent).
  2. Railway PITR: Postgres → Backups → Point-in-time → wybierz minutę PRZED zdarzeniem (UTC!).
  3. Alternatywa: nocna kopia z R2 — `docs/DEPLOYMENT.md` § Backups (pobierz `.dump.age`, `age -d`, `pg_restore --clean --if-exists --no-owner`).
  4. Po odtworzeniu: `GET /ops/metrics → migrations` musi być „wszystkie zastosowane".
- **Kopia nocna czerwona** (alert z webhooka): otwórz run `DB backup` w GitHub Actions. Brak `BACKUP_AGE_PUBLIC_KEY` = kopia celowo NIE wysłana — uzupełnij sekret i odpal workflow ręcznie.

## 3. Migracja padła przy deployu

Kontener kończy się kodem 1, Railway zostawia stary deploy — użytkownicy nic nie widzą, ale nowy kod nie działa.

1. Logi deployu → linia `[safe-migrate]` z nazwą migracji i błędem Postgresa.
2. Migracja idempotentna (np. `ADD COLUMN IF NOT EXISTS`) → Redeploy.
3. Migracja zostawiła stan „failed" → `pnpm exec prisma migrate resolve --rolled-back <nazwa>` w konsoli kontenera (Railway → serwis → Shell) i Redeploy, ALBO `--applied`, jeśli zmiana faktycznie weszła.
4. Nie da się naprawić szybko → rollback deployu (kod) i, jeśli migracja częściowo zmieniła schemat, PITR sprzed deployu.

## 4. Asystent AI

| Objaw | Co sprawdzić | Dźwignie |
|---|---|---|
| 503 `AI_BUDGET_PAUSED` | `/ops/metrics → agent.budget` | To bezpiecznik, nie awaria. Podnieś `AI_GLOBAL_DAILY_BUDGET_USD` tylko świadomie. |
| 503 `AI_UPSTREAM_PAUSED` | Bezpiecznik dostawcy otwarty (status Anthropic) | Czekać; bezpiecznik zamyka się sam. |
| Koszty rosną bez sensu | `/ops/metrics → agent.cost`, tabela `AiUsage` | `AI_MAX_TURN_COST_USD`, `AI_MAX_CONCURRENT_TURNS_PER_HOUSEHOLD`, w ostateczności `AI_ENABLED=false`. |
| Dziwne odpowiedzi / podejrzenie prompt injection | Zgłoszenia (`AgentReport`), treść rozmowy przez `pnpm rodo:export` | `AI_ALLOWED_USERS` zawęża dostęp bez deployu. |

Wyłączenie asystenta = `AI_ENABLED=false` (restart serwisu). Aplikacja pokazuje „niedostępny", nic więcej się nie psuje.

## 5. Wyciek sekretu / podejrzenie włamania

1. **Odetnij**: zrotuj sekret wg `docs/ROTACJA-SEKRETOW.md` (kolejność ma znaczenie).
2. Wymuś ponowne logowanie wszystkich: nowy `JWT_SECRET` + nowy `REFRESH_TOKEN_PEPPER` (unieważnia access i refresh tokeny).
3. Klucz Anthropic: unieważnij w konsoli, nowy do Railway; sprawdź koszty z ostatnich 24 h.
4. R2: unieważnij token, nowy do GitHub Secrets / Railway.
5. Zbierz ślady: logi Railway (eksport), `AiUsage`, `RefreshToken.revokedAt`, Sentry.
6. Ocena RODO (72 h na zgłoszenie do UODO, jeśli dotyczy danych osobowych) — `docs/rejestr-czynnosci-i-dpia.md` § naruszenia.

## 6. Cookidoo (mikroserwis)

- Healthcheck serwisu w Railway; backend przy braku serwisu odpowiada `COOKIDOO_UNAVAILABLE`, reszta aplikacji działa.
- Zmiana API cookidoo.pl: `cookidoo-api` przypięty w `requirements.txt`; podbicie wersji + redeploy. Do tego czasu `COOKIDOO_INTEGRATION_ENABLED=false` chowa integrację.

## 7. Po incydencie

- Krótki zapis: co, kiedy (UTC), jak wykryto, co zrobiono, co zapobiegnie — do `docs/handover/memory/`.
- Jeśli dotknęło danych użytkowników: wpis w rejestrze naruszeń, decyzja o powiadomieniu.
- Sondy: alert z webhooka i uptime muszą były zadziałać — jeśli nie, to też jest do naprawy.
