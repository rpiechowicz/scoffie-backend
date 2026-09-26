# Wyniki benchmarków asystenta

Pliki JSON z `pnpm agent:scenarios` (scenariusze: `scripts/lib/agent-benchmark-scenarios.ts`).
**Kosztuje pieniądze** — przebieg na żywym modelu tylko za zgodą Rafała
(`docs/workstreams/assistant-backend-optimization/README.md`). Przebieg na sucho
(`--dry`) jest darmowy i nie wymaga klucza API.

## Stare wyniki — NIE porównywać wprost z nowym przepływem

Wszystkie pliki poniżej powstały, gdy **cały katalog jechał w prompcie** (digest,
~81 tys. tokenów prefiksu odczytywanych z cache przy każdym wywołaniu), przed
`find_recipes`, mapą katalogu (`AI_CATALOG_MODE=search`) i końcem tury po karcie
(`tool_ended_turn`) z 26.09.2026. Nie mają też metadanych przebiegu (commit, tryb
katalogu), a harness nie przekazywał wtedy do narzędzi `planScope` ani `dates`.

| Plik | Kiedy | Tryb kart | Scenariusze × przebiegi | Uwagi |
|---|---|---|---|---|
| `before-A.json` | 07.09 | `off` | 40 × 3 | tryb zapisu bez kart — ścieżka, której produkcja nie używa od 12.09 |
| `after-A-*.json` | 07.09 | `off` | 15 × 1 / 3 × 1 | j.w. |
| `tempo-A-strict.json` | 24.09 | `strict` | 12 × 1 | Sonnet 5 / medium; plan tygodnia jeszcze przez `get_week_plan` |
| `tempo-B-strict.json` | 24.09 | `strict` | 12 × 1 | Sonnet 5 / low |
| `tempo-A-plan-w-prompcie.json` | 24.09 | `strict` | 12 × 1 | plan tygodnia w prompcie — **ostatni pomiar starego trybu** |
| `tempo-kcal-fix.json` | 24.09 | `strict` | 3 × 3 | poprawka „kcal z serwera” |

Pierwszy scenariusz przebiegu płaci zapis całego prefiksu do cache (np.
`g1-wtorek-obiad` $0,34 zamiast ~$0,03) — przy porównaniach patrz na
`cacheWriteTokens` albo odrzucaj pierwszą turę.

## Nowe wyniki (od 26.09.2026)

Każdy plik zapisany przez harness ma `commit`, `worktreeDirty`, `catalogMode`,
`catalogSize`, `cacheWarmHours`, a każdy rekord `stopReasons` (powód zatrzymania
każdej tury). Nazwy: `agent-scenarios-<label>-<data>.json`.

Lokalny pomiar zapytań DB na ścieżkach asystenta (bez modelu):
`pnpm exec ts-node -r tsconfig-paths/register scripts/agent-db-probe.ts --runs 5`.
