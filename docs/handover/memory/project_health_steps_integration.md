---
name: project-health-steps-integration
description: Integracja kroków (Apple Health/Garmin przez HealthKit) — gałąź feature/health-steps w obu repach; co zostało do zweryfikowania ręcznie.
metadata:
  node_type: memory
  type: project
  originSessionId: 07d4f263-e5aa-4641-8925-5354fa37ecd4
  modified: 2026-08-26T13:44:28.776Z
---

Integracja kroków zrobiona 2026-08-26 na gałęzi `feature/health-steps` (backend
i iOS; wypchnięte, NIE zmergowane do develop). Jedno źródło naraz do wyboru w
arkuszu „Zdrowie" (Ustawienia → Integracje): Apple Zdrowie = zdeduplikowana suma
HealthKit, Garmin = próbki filtrowane po bundle `com.garmin.*` (wymaga włączenia
zapisu do Apple Health w Garmin Connect). Backend: tabela `DailyStepCount`
(PK userId+date, `stepsGoal` to snapshot zamrożony przy create), REST
`PUT/GET /integrations/health/steps` w module integrations.

Kluczowe decyzje: bez backfillu (okno max(enabledAt, dziś−6)…dziś), zero-dni
pomijane (nieodróżnialne od odmowy odczytu), PUT dławiony 5 min od PRÓBY,
klucze `settings.health.*` czyszczone przy wylogowaniu (kroki nie mogą przejść
między kontami), cel kroków w `@AppStorage settings.health.stepsGoal`
(domyślnie 10 000, suwak 2000–40000).

**Do zweryfikowania ręcznie (nie da się w symulatorze):** tryb Garmin na
fizycznym iPhonie z Garmin Connect; pełny flow klikalny (logowanie tylko przez
Sign in with Apple). Przy pierwszym archiwum TestFlight automatic signing dopisze
capability HealthKit do App ID, a w App Store Connect trzeba zadeklarować
zbieranie danych zdrowia (App Privacy).

**Haczyk App Store (2026-08-26):** walidacja uploadu (kod 90683) wymaga
`NSHealthUpdateUsageDescription` przy SAMYM entitlemencie HealthKit, nawet gdy
aplikacja tylko czyta — pierwszy release padł na tym w CI; oba opisy siedzą
teraz w `weekly-meals-Info.plist`. Powiązane: [[project-cookidoo-integration-plan]].
