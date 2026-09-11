---
name: Zaproszenia — hasz tokenu w bazie (DO ZROBIENIA)
description: Zaplanowany krok po linku https z fragmentem — `Invitation.token` leży jawnym tekstem; wyciek bazy to komplet działających zaproszeń
type: project
originSessionId: cf5b81ba-7cdf-47f4-bc17-28cc40b2cb6f
---

Fakt: 11.09.2026 link zaproszenia przeszedł na
`https://scoffie.app/zaproszenie/#<token>` (strona na prod, iOS na gałęzi
`feat/link-zaproszenia`, bez builda). Sam token — 16 losowych bajtów, jedno
użycie (`updateMany … redeemedAt: null`), 7 dni ważności, podgląd i przyjęcie
tylko po JWT — jest wystarczająco mocny. Zostało JEDNO słabe miejsce:
`Invitation.token` w bazie jawnym tekstem.

**Why:** `RefreshToken` już trzyma `tokenHash`, bo wyciek bazy nie ma prawa
wydać działających poświadczeń. Zaproszenie to to samo: kto ma zrzut tabeli,
ma wejście do każdego domu z otwartym zaproszeniem.

**How to apply (plan, ok. pół dnia):**

1. Kolumna `tokenHash String @unique` (SHA-256 hex, jak w `RefreshToken`),
   migracja z backfillem `tokenHash = sha256(token)`, potem `token` do
   usunięcia w drugiej migracji — dwa kroki, żeby deploy nie wywrócił
   otwartych zaproszeń.
2. `createInvitation` oddaje surowy token RAZ (w odpowiedzi), zapisuje hasz.
   `previewInvitation`, `acceptInvitation`, `declineInvitation` szukają po
   `tokenHash: sha256(dto.token)`.
3. HACZYK: skrzynka zaproszeń (`invitedUserId`, `refreshPendingInvitations`
   w iOS) oddaje dziś użytkownikowi SUROWY token (`households.service.ts`
   ok. linii 542 i 594), żeby telefon mógł go potem przyjąć. Po haszowaniu
   tokenu nie ma skąd wziąć — skrzynka musi pracować na `invitation.id`:
   nowe zdarzenia `households:acceptInvitationById` / `declineInvitationById`
   (bramka: `invitedUserId === actor`), iOS `InvitationPromptState` niesie
   `id` zamiast `token` dla zaproszeń ze skrzynki. Link z tokenem zostaje
   ścieżką dla „pierwszego otwarcia".
4. `data-export/user-export.ts` wypisuje zaproszenia — sprawdzić, czy nie
   oddaje `token` (po zmianie i tak go nie będzie).

**Czego NIE robić:** nie wydłużać tokenu (128 bitów wystarcza; 256 tylko
wydłuża link) i nie skracać go „dla urody" — kartę OG i tak widać zamiast
adresu.
