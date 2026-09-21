---
name: Zaproszenia — hasz tokenu w bazie (KROK 1 GOTOWY, NIEWDROŻONY)
description: Invitation.tokenHash zamiast surowego tokenu — gałąź security/invitation-token-hash; został krok 2 (DROP COLUMN token) po wdrożeniu
type: project
---

Stan 21.09.2026: gałąź `security/invitation-token-hash` (z `develop`), do przeglądu,
NIEWDROŻONA. Pełny opis, kontrakt i plan wdrożenia: `docs/ZAPROSZENIA-HASZ-TOKENU.md`.

Co ustalone:

- `tokenHash = sha256(token)` hex, BEZ peppera (128 losowych bitów nie da się
  zgadnąć; pepper uniemożliwiłby backfill w SQL i gasiłby linki przy rotacji).
- Skrzynka zaproszeń pracuje na `invitation.id`, ale BEZ nowych zdarzeń i bez
  zmian w iOS: `listPendingInvitations` oddaje w polu `token` uchwyt `inv_<id>`,
  który `accept`/`decline`/`preview` przyjmują tylko od adresata (`invitedUserId`).
  Wcześniejszy plan (`acceptInvitationById` + zmiana `InvitationPromptState`)
  odrzucony — wydane buildy iOS mają `token` jako pole wymagane.
- Migracja w dwóch krokach. Krok 1 (w gałęzi): kolumna + backfill w bazie +
  `token` nullable + wyzwalacz dla starej wersji aplikacji. Krok 2 (OSOBNY PR po
  potwierdzeniu na prod): DROP wyzwalacza i kolumny `token`.

**Why:** zrzut tabeli nie może być kompletem działających wejść do domów.

**How to apply:** do czasu kroku 2 surowe tokeny sprzed wdrożenia wciąż leżą
w `token` — nie uznawać tematu za zamknięty, dopóki kolumna istnieje.
