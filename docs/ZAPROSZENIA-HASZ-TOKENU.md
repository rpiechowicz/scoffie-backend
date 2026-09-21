# Zaproszenia — w bazie tylko hasz tokenu

Stan: 21.09.2026, gałąź `security/invitation-token-hash`. **Niewdrożone.**

## Po co

`Invitation.token` leżał w bazie jawnym tekstem. Link zapraszający jest anonimowy
i ważny do 30 dni, więc zrzut tabeli (backup, replika, podgląd w panelu Railway)
był kompletem działających wejść do każdego domu z otwartym zaproszeniem.
Od tej zmiany w bazie leży wyłącznie `tokenHash`, a surowy token istnieje tylko
w linku i w jednej odpowiedzi — na `households:createInvitation`.

## Jak haszujemy

`tokenHash = hex(sha256(utf8(token)))`, kolumna `@unique`; token bez zmian:
`randomBytes(16)` → 32 znaki hex (128 bitów). Kod: `src/households/invitation-token.util.ts`.

**Bez peppera, świadomie.** Pepper (jak `REFRESH_TOKEN_PEPPER`) chroni wejścia, które
da się zgadnąć; tu wejściem jest 128 losowych bitów, więc haszu nie da się odwrócić
przeszukiwaniem i sekret nic nie dokłada. Kosztowałby natomiast:

- istniejących wierszy nie dałoby się przeliczyć w migracji SQL (baza nie zna
  sekretów) — potrzebny byłby jednorazowy skrypt z dostępem do sekretu i do
  surowych tokenów naraz;
- rotacja peppera gasiłaby po cichu wszystkie otwarte linki;
- nowa zmienna = `assert-env`, `.env.example`, `ROTACJA-SEKRETOW.md`, Railway.

Wolne haszowanie (bcrypt/argon2) też nie ma tu sensu: spowalnia zgadywanie,
a 2^128 nie zgaduje się wcale; za to uniemożliwia wyszukanie wiersza po haszu.

## Kontrakt (WebSocket)

| Zdarzenie                           | Zmiana                                                                                                           |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `households:createInvitation`       | Kształt bez zmian; `token` to surowy token (jedyny moment, gdy jest dostępny). Odpowiedź nie niesie `tokenHash`. |
| `households:previewInvitation`      | `token` w odpowiedzi to echo wejścia, nie wartość z bazy.                                                        |
| `households:listPendingInvitations` | Nowe pole `id`. Pole `token` ZOSTAJE, ale niesie **uchwyt skrzynki** `inv_<id zaproszenia>`, nie token z linku.  |
| `accept` / `decline` / `preview`    | `data.token` przyjmuje token z linku ALBO uchwyt skrzynki.                                                       |

Uchwyt skrzynki nie jest sekretem: działa wyłącznie dla adresata
(`invitedUserId === aktor`), dla każdego innego zaproszenie „nie istnieje".
Adresatem zostaje się tylko przez podgląd z PRAWDZIWYM tokenem. Dzięki temu
**wydane buildy iOS działają bez zmian** (`BackendPendingInvitationDTO.token`
jest u nich polem wymaganym i odsyłają je bez zaglądania do środka). iOS może
kiedyś przejść na `id`, ale nie musi.

Poczta: jedyny mail związany z zaproszeniem to `household-joined` po przyjęciu;
jego `dedupeKey` to `joined:<invitation.id>` — tokenu nie używał i nie używa.
Eksport danych (`data-export/user-export.ts`) nie wybiera ani `token`, ani `tokenHash`.
Push `HOUSEHOLD_INVITATION` niesie `householdId`, nie token.

## Migracja — dwa kroki

### Krok 1 („expand") — `20260921100000_hasz_tokenu_zaproszenia`, w tej gałęzi

- dodaje `tokenHash`, przelicza istniejące wiersze W BAZIE
  (`encode(sha256(convert_to(token,'UTF8')),'hex')`) — tokeny nie opuszczają
  Postgresa, nie trafiają do logów ani skryptów; otwarte linki działają dalej;
- `token` staje się nullable i zostaje na jedno wdrożenie; nowy kod go nie czyta
  ani nie zapisuje (nowe wiersze mają `token = NULL`);
- wyzwalacz `invitation_fill_token_hash` uzupełnia hasz przy INSERT-ach STAREJ
  wersji aplikacji (okno deployu, rollback).

Rollback aplikacji po kroku 1 jest bezpieczny, z jednym zastrzeżeniem: zaproszeń
utworzonych już przez nową wersję stara nie znajdzie (nie mają `token`) —
właściciel wystawia link ponownie.

### Krok 2 („contract") — OSOBNY PR, po potwierdzeniu, że krok 1 działa na prod

Dopóki go nie ma, surowe tokeny zaproszeń sprzed wdrożenia nadal leżą w kolumnie
`token` (i w backupach z tego okresu). Krok 2 to usunięcie `token` ze
`schema.prisma` i migracja:

```sql
DROP TRIGGER "invitation_fill_token_hash" ON "Invitation";
DROP FUNCTION "invitation_fill_token_hash"();
ALTER TABLE "Invitation" DROP COLUMN "token";
```

Nie dokładać jej do tej gałęzi — `migrate deploy` przy starcie puściłby oba kroki
naraz i stara wersja padałaby w oknie deployu na każdym zapytaniu o zaproszenie.

### Kolejność wdrożenia (nic z tego nie zostało uruchomione)

1. PR → `develop`, e2e zielone. Backup/PITR Railway jak przy każdej migracji.
2. `develop` → `main`; safe-migrate przy starcie puszcza krok 1.
3. Sprawdzenie na prod (odczyt): `SELECT count(*) FROM "Invitation" WHERE "tokenHash" IS NULL` = 0;
   link wystawiony PRZED wdrożeniem nadal się podgląda; nowy wiersz ma `token IS NULL`.
4. Po dobie bez rollbacku: PR z krokiem 2.
5. Backupy sprzed kroku 2 zawierają surowe tokeny — przestają być groźne najpóźniej
   30 dni po wdrożeniu kroku 1 (maksymalny termin zaproszenia). Jeśli to za długo:
   po kroku 1 można jednorazowo zgasić otwarte zaproszenia sprzed wdrożenia
   (`UPDATE … SET "expiresAt" = now() WHERE token IS NOT NULL AND "redeemedAt" IS NULL`)
   — decyzja właściciela, koszt: właściciele wystawiają linki ponownie.

## Testy

- `src/households/invitation-token.util.spec.ts`, `households.service.spec.ts`;
- `test/invitation-token-hash.e2e-spec.ts` — na żywej bazie, czyta wiersz surowym
  SQL-em (`row_to_json`), czyli to, co zobaczy ktoś ze zrzutem.
