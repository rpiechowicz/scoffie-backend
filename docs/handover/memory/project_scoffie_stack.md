---
name: Scoffie App stack
description: Project layout and dev networking setup for Scoffie App (iOS + NestJS backend)
type: project
originSessionId: bba7eca5-2413-4008-8809-0b93340894e6
---

Fakt: Repo ma dwa projekty – `scoffie-ios` (SwiftUI, Xcode) oraz `scoffie-backend` (NestJS, port 3000, uruchamiany przez Docker Compose).

**Why:** Developerski backend nasłuchuje na localhost:3000 (Docker), a appka iOS działa na fizycznym iPhonie, więc `localhost` nie zadziała – iPhone musi łączyć się po LAN IP Maca.

**How to apply:** Dla dev testów Apple Sign In / API z urządzenia fizycznego ustaw `API_BASE_URL` w `scoffie-ios/Scoffie-Info.plist` na `http://<mac-lan-ip>:3000` oraz dodaj `NSExceptionDomains` w `NSAppTransportSecurity` (ATS nie pozwala na HTTP bez wyjątku; `NSAllowsLocalNetworking` samo nie wystarcza dla adresów 192.168.x.x). Prod URL to `https://api.scoffie.app` (na 2026-04-17 domena jeszcze nie rozwiązuje DNS). Backend `/auth/apple` obsługuje logowanie Apple. IP Maca może się zmieniać – zweryfikować `ipconfig getifaddr en0` przed kolejną sesją.

**Hosting prod:** Backend deployowany na Railway (Hobby plan, $5/mc, ~8 vCPU / 8 GB RAM per replica na 2026-04-21). Przy sugestiach infra/perf pamiętać że to Railway + Docker — nie AWS/GCP/k8s.

**Perf gotcha (potwierdzone 2026-04-21):** `weekly-plans.service.ts` używa `runSerializable` (Prisma `Serializable` isolation) dla WSZYSTKICH mutacji — `setShoppingItemChecked`, `upsertWeekSlot`, itd. Skutek: transakcje na ten sam `householdId` idą sekwencyjnie, a `upsertWeekSlot` dodatkowo wywołuje pełny `rebuildShoppingListSnapshot` w tej samej transakcji. Przy szybkim klikaniu checkboxów / dodawaniu posiłków serwer "nie wyrabia" — ale to nie kwestia mocy maszyny, tylko poziomu izolacji + eager rebuild. iOS `ShoppingListStore.toggleChecked` nie ma debounce, każde tapnięcie = osobny WebSocket event.

**Why:** User pyta "za słaby serwer?" — odpowiedź "nie, to architektura". Upgrade Railway nie pomoże.

**How to apply:** Zanim zasugerujesz większy plan hostingowy albo "Postgres to problem" — najpierw obniż izolację tam gdzie niepotrzebna (`setShoppingItemChecked` wystarczy `ReadCommitted` + unique constraint), rozważ dirty-flag zamiast eager rebuild w `upsertWeekSlot`, dodaj coalescing per `productKey` w iOS storze.
