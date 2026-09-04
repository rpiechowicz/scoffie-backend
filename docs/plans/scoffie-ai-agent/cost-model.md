# Unit-economics model — Scoffie AI assistant (Claude API, direct)

> **31.08.2026 — digest katalogu jest ZMIERZONY, nie szacowany.** Wszystkie
> liczby digestu w §0–§10 poniżej to pierwotne szacunki; realne wartości z
> `count_tokens` są w §13 i są **o 30 % niższe**. Reszta modelu (schematy
> narzędzi, instrukcje systemowe, bloki gospodarstwa, thinking) pozostaje
> szacunkiem. Wnioski cenowe §7–§11 się nie zmieniają — zapas idzie w naszą stronę.

Model script (all parameters explicit, re-runnable): `/private/tmp/claude-502/-Users-rafi-Desktop-scoffie-ios-App/75609ba4-f8b7-4867-95a1-9fa00f42c5f0/scratchpad/unit_econ.py`

## 0. Inputs and assumptions

| #   | Item                                       | Value                                                                                                                                                                                                                                                                                                                                                            | Source / status                                                                                                                                                             |
| --- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | USD→PLN                                    | **3.6894** (NBP average, 2026-08-25, via mybank.pl); live market ≈3.717                                                                                                                                                                                                                                                                                          | WebSearch today ([mybank.pl](https://mybank.pl/kursy-walut/usd-dolar-amerykanski/), [xe.com](https://www.xe.com/en-us/currencyconverter/convert/?Amount=1&From=USD&To=PLN)) |
| 2   | Prices $/MTok in/out                       | Opus 5 **5/25**; Sonnet 5 **2/10**; Haiku 4.5 **1/5**                                                                                                                                                                                                                                                                                                            | Opus/Sonnet confirmed in claude-api-docs.md §1; Haiku "docs silent" there → lead-supplied figure used                                                                       |
| 3   | Cache pricing                              | read 0.1×in; write 1.25×in (5-min) / 2×in (1-h)                                                                                                                                                                                                                                                                                                                  | claude-api-docs.md §5                                                                                                                                                       |
| 4   | Min cacheable prefix                       | Opus 5 512, Sonnet 5 1024, Haiku 4.5 4096                                                                                                                                                                                                                                                                                                                        | §5 — every prefix below clears all three                                                                                                                                    |
| 5   | Tokenizer uplift T                         | Opus 5 / Sonnet 5 = **1.3×** (new tokenizer, §1); Haiku 4.5 = **1.0×** (docs silent → assume old tokenizer)                                                                                                                                                                                                                                                      | assumption for Haiku                                                                                                                                                        |
| 6   | Polish uplift P                            | **1.3×** on Polish-language components (catalog names/ingredients, household block, user/assistant text, tool results). Not applied to tool schemas, system instructions (assumed written in English), tool-call JSON, thinking                                                                                                                                  | lead's stated assumption                                                                                                                                                    |
| 7   | Thinking tokens (output-billed, no uplift) | Chat turn: low 500 / medium 1,500 / high 4,000. Week plan: 1,500 / 4,000 / 8,000. Regenerate: 700 / 2,000 / 4,500                                                                                                                                                                                                                                                | lead's chat numbers; plan/regen scaled by me (assumption)                                                                                                                   |
| 8   | Prior-turn thinking retained in context    | **Yes on Opus 5 / Sonnet 5** (Opus 4.5+, Sonnet 4.6+ "previous-turn thinking blocks are preserved by default"), billed as cached input on later calls. **Haiku 4.5 strips them** → "every message after the first stripped block falls out of cache" → messages cache re-written each turn that follows tool use                                                 | skill file `shared/prompt-caching.md:233`                                                                                                                                   |
| 9   | Haiku 4.5 configs                          | modelled twice: "(think)" = same thinking budgets as Sonnet + the strip penalty (history re-written at 2×/1.25× every turn); "(no think)" = `thinking` disabled, 0 thinking tokens, no penalty. Haiku has no adaptive/effort ladder in the docs (§1)                                                                                                             | §1, §5                                                                                                                                                                      |
| 10  | Cache layout                               | `tools` → `system[0]` instructions → `system[1]` catalog digest (shared across ALL users, 1-h breakpoint) → `system[2]` household block (per-user) → messages with top-level automatic breakpoint; longer TTL first                                                                                                                                              | §5 recommended layout                                                                                                                                                       |
| 11  | Cache states                               | **warm** = everything hit, only new tail written; **cold-user** = shared prefix hit, household+history written (realistic "resume a conversation after TTL"); **cold-all** = nothing hit. A _brand-new_ conversation has history=0, so its cold cost ≈ warm + 676-token household write (≈$0.003 on Sonnet) — cold only hurts when _resuming_ long conversations | derived                                                                                                                                                                     |
| 12  | Weeks/month                                | 52/12 = 4.333                                                                                                                                                                                                                                                                                                                                                    | —                                                                                                                                                                           |
| 13  | Revenue                                    | net = price / 1.23 (PL VAT) × 0.85 (Apple SBP; also 15 % under EU unified terms for SBP) − 0 RevenueCat (< $2.5k MTR)                                                                                                                                                                                                                                            | market-research.md §1, §2                                                                                                                                                   |
| 14  | Trial-to-paid                              | 37.7 % (H&F median; 5–9-day trials 37.4 %)                                                                                                                                                                                                                                                                                                                       | market-research.md §4                                                                                                                                                       |

## 1. Static prefix (billed tokens)

Formula: `tokens = base × (P if Polish) × T`

| Component                                    | base  | Polish? | Opus 5 / Sonnet 5 (T=1.3) | Haiku 4.5 (T=1.0) |
| -------------------------------------------- | ----- | ------- | ------------------------- | ----------------- |
| Tool schemas (~8 tools)                      | 2,500 | no      | 3,250                     | 2,500             |
| System instructions                          | 1,500 | no      | 1,950                     | 1,500             |
| Catalog digest: 89 × 75 + 150 header = 6,825 | 6,825 | yes     | 11,534                    | 8,873             |
| **Shared prefix S**                          |       |         | **16,734**                | **12,873**        |
| Household/preferences U                      | 400   | yes     | 676                       | 520               |
| **S+U**                                      |       |         | **17,410**                | **13,393**        |

Digest line (75 base): short index (3) + title (8) + mealType/suitableMealTypes (4) + kcal/P/F/C per serving (12) + prepTime (3) + top-5 ingredient names (25) + servings (2) + separators (~10). Fields exist per backend-schema.md §Recipe (`nutritionKcal…` per whole recipe, `servings`=2 for all 89, `suitableMealTypes`, `RecipeIngredient.name`); no tags/cuisine to include (§4 "Absent on Recipe"). **`Recipe.id` is a String, catalog ids are UUID-shaped** (import-bot household `11111111-1111-4111-8111-…`, backend-schema.md) — a UUID is ~20–25 tokens, so the digest must use a short index (R01…R89) resolved in code, else +≈2k tokens. Lead's 60–90/line range ⇒ digest 9.3k–13.8k on Opus/Sonnet; 75 used.

## 2. Per-request accounting (generic formulas)

For a request with N API calls (N = tool calls + 1), user message u, per-tool bundle b_k = thinking_k + tool_use_k + tool_result_k (thinking split evenly: Θ/N per call), visible text v, history H (visible history + retained thinking on Opus/Sonnet):

```
tail_writes = u + Σ b_k + v (+ Θ/N final thinking, Opus/Sonnet only)   # each new block written once
tail_reads  = u·(N−1) + Σ_k b_k·(N−1−k)                                  # re-read on later calls of same turn
output      = v + Σ tool_use_k + Θ
warm:       reads = N·(S+U+H) + tail_reads ;               writes = tail_writes
cold-user:  reads = N·S + (N−1)·(U+H) + tail_reads ;       writes = tail_writes + U + H
cold-all:   reads = (N−1)·(S+U+H) + tail_reads ;           writes = tail_writes + S + U + H
Haiku(think) warm: reads = N·(S+U) + (N−1)·H + tail_reads ; writes = tail_writes + H   # strip penalty
cost = (reads·0.1·p_in + writes·w·p_in + output·p_out) / 1e6 ,  w = 1.25 (5m) | 2 (1h)
```

Request shapes (base tokens; tool_use no P, results P):

| Type                                           | u   | bundles (tool_use, result)                                                                                                              | v   | history base (+prior turns for retained thinking)                       | Θ medium |
| ---------------------------------------------- | --- | --------------------------------------------------------------------------------------------------------------------------------------- | --- | ----------------------------------------------------------------------- | -------- |
| A1 chat, 1 tool (N=2)                          | 60  | (50,300)                                                                                                                                | 300 | 3,000 (3.5) — avg turn of an 8-turn session, 857/turn ⇒ 6,000 at turn 8 | 1,500    |
| A2 chat, 2 tools (N=3)                         | 60  | (50,300),(50,300)                                                                                                                       | 300 | same                                                                    | 1,500    |
| **A = 0.5·A1 + 0.5·A2** (1.5 tools, 2.5 calls) |     |                                                                                                                                         |     |                                                                         |          |
| B week plan (N=6)                              | 100 | get_week_plan (20,200); search_recipes (60,600); validate_plan (800,300); validate_plan retry (800,100); submit_plan 7×3 slots (900,80) | 400 | 1,000 (1)                                                               | 4,000    |
| C regenerate/leftover (N=3)                    | 80  | search_recipes (60,600); submit_slot (150,50)                                                                                           | 250 | 2,000 (2)                                                               | 2,000    |

B output check: v 400×1.69 = 676 + tool_use 2,580×1.3 = 3,354 + Θ 4,000 = **8,030** (lead's 6–10k ✓).

**Worked example (Sonnet 5, A1, medium, warm, 1h):** S+U = 17,410; H = 3,000×1.69 + 3.5×1,500 = 5,070 + 5,250 = 10,320; u = 101; b₁ = 750 + 65 + 507 = 1,322; v = 507; tail_writes = 101 + 1,322 + 507 + 750 = 2,680; tail_reads = 101; reads = 2×27,730 + 101 = 55,561; output = 507 + 65 + 1,500 = 2,072.
cost = (55,561×0.2 + 2,680×4 + 2,072×10)/1e6 = (11,112 + 10,720 + 20,720)/1e6 = **$0.0426**. A2 = $0.0513 ⇒ A = **$0.0469**.

**Worked example (Sonnet 5, B, medium, warm, 1h):** H = 1,690 + 1,500 = 3,190; bundles = 1,031 / 1,759 / 2,214 / 1,876 / 1,972; tail_writes = 169 + 8,852 + 676 + 667 = 10,362; tail_reads = 169×5 + 1,031×4 + 1,759×3 + 2,214×2 + 1,876×1 = 16,547; reads = 6×20,600 + 16,547 = 140,147; cost = (140,147×0.2 + 10,362×4 + 8,030×10)/1e6 = 28,029 + 41,449 + 80,300 = **$0.1498**.

## 3. Cost per request (USD, medium effort)

**A — chat turn (avg turn, 1.5 tools)**

| Model                | warm 5m | warm 1h | cold-user 5m | cold-user 1h | cold-all 5m | cold-all 1h |
| -------------------- | ------- | ------- | ------------ | ------------ | ----------- | ----------- |
| Opus 5               | 0.1062  | 0.1173  | 0.1694       | 0.2217       | 0.2656      | 0.3807      |
| Sonnet 5             | 0.0425  | 0.0469  | 0.0678       | 0.0887       | 0.1062      | 0.1523      |
| Haiku 4.5 (think)    | 0.0212  | 0.0256  | 0.0218       | 0.0266       | 0.0366      | 0.0511      |
| Haiku 4.5 (no think) | 0.0081  | 0.0089  | 0.0132       | 0.0173       | 0.0280      | 0.0418      |

**A at turn 8** (history 6k base + 7 turns retained thinking): Opus 0.1191/0.1302 warm; Sonnet 0.0476/0.0521; Haiku-think 0.0267/0.0340; Haiku-no-think 0.0091/0.0099 (5m/1h). Cold-user 1h at turn 8: Opus 0.333, Sonnet 0.133 → resuming a long chat after TTL costs 2.5–2.8× a warm turn.

**B — week plan**

| Model                | warm 5m | warm 1h | cold-user 5m | cold-user 1h | cold-all 5m | cold-all 1h |
| -------------------- | ------- | ------- | ------------ | ------------ | ----------- | ----------- |
| Opus 5               | 0.3356  | 0.3744  | 0.3578       | 0.4112       | 0.4540      | 0.5701      |
| Sonnet 5             | 0.1342  | 0.1498  | 0.1431       | 0.1645       | 0.1816      | 0.2281      |
| Haiku 4.5 (think)    | 0.0575  | 0.0647  | 0.0581       | 0.0657       | 0.0729      | 0.0901      |
| Haiku 4.5 (no think) | 0.0312  | 0.0349  | 0.0333       | 0.0383       | 0.0481      | 0.0628      |

**C — single-slot regenerate / leftover suggestion**

| Model                | warm 5m | warm 1h | cold-user 5m | cold-user 1h | cold-all 5m | cold-all 1h |
| -------------------- | ------- | ------- | ------------ | ------------ | ----------- | ----------- |
| Opus 5               | 0.1286  | 0.1434  | 0.1692       | 0.2104       | 0.2654      | 0.3694      |
| Sonnet 5             | 0.0515  | 0.0574  | 0.0677       | 0.0842       | 0.1062      | 0.1478      |
| Haiku 4.5 (think)    | 0.0242  | 0.0282  | 0.0248       | 0.0292       | 0.0396      | 0.0537      |
| Haiku 4.5 (no think) | 0.0094  | 0.0105  | 0.0130       | 0.0165       | 0.0278      | 0.0409      |

**Effort sweep (warm 1h)**

| Model                | A low  | A med  | A high | B low  | B med  | B high | C low  | C med  | C high |
| -------------------- | ------ | ------ | ------ | ------ | ------ | ------ | ------ | ------ | ------ |
| Opus 5               | 0.0778 | 0.1173 | 0.2159 | 0.2819 | 0.3744 | 0.5253 | 0.0947 | 0.1434 | 0.2388 |
| Sonnet 5             | 0.0311 | 0.0469 | 0.0864 | 0.1127 | 0.1498 | 0.2101 | 0.0379 | 0.0574 | 0.0955 |
| Haiku 4.5 (think)    | 0.0194 | 0.0256 | 0.0411 | 0.0476 | 0.0647 | 0.0920 | 0.0199 | 0.0282 | 0.0441 |
| Haiku 4.5 (no think) | 0.0089 | —      | —      | 0.0349 | —      | —      | 0.0105 | —      | —      |

**Where the money goes (Sonnet 5, medium, warm 1h):** A1 = prefix reads $0.0070 (16 %) + history reads $0.0041 (10 %) + tail writes/reads $0.0107 (25 %) + **output $0.0207 (49 %)**. B = prefix $0.0209 (14 %) + history $0.0038 (3 %) + tail $0.0448 (30 %) + **output $0.0803 (54 %)**. ⇒ thinking + tool-JSON output and the 1-h write premium on the growing tail dominate; the 17k cached prefix is cheap (slim 40-token digest saves only ~5 %, see §9), consistent with docs "a document in the cached prefix is cheap" (§6 2.2).

Cross-check vs. external benchmarks: MealestroAI on GPT-4o ≈ $0.70 per weekly plan with 23 calls + images (market-research.md §5) vs. $0.15 Sonnet / $0.37 Opus here without images — same order. RevenueCat's "$0.02–$0.18 per AI-active user/month" (§5) assumes 10 × 1k-token requests; this agent runs 2.5–6 calls per action against a 17k prefix with thinking — a different cost class (≈10–70× that benchmark).

## 4. Monthly usage profiles → API cost

Quantities/month (×4.333): Light 17.3 turns, 4.3 plans, 0 regen; Medium 65 turns, 8.7 plans, 17.3 regen; Heavy 173.3 turns, 17.3 plans, 65 regen.

`monthly = turns·A + plans·B + regens·C` (warm, 1h)

| Model                | Light med | Medium med | Heavy med | Light low | Medium low | Heavy low | Light high | Medium high | Heavy high |
| -------------------- | --------- | ---------- | --------- | --------- | ---------- | --------- | ---------- | ----------- | ---------- |
| Opus 5               | 3.66      | 13.35      | 36.14     | 2.57      | 9.14       | 24.53     | 6.02       | 22.73       | 62.05      |
| Sonnet 5             | 1.46      | 5.34       | 14.46     | 1.03      | 3.66       | 9.81      | 2.41       | 9.09        | 24.82      |
| Haiku 4.5 (think)    | 0.72      | 2.72       | 7.40      | 0.54      | 2.02       | 5.49      | 1.11       | 4.23        | 11.58      |
| Haiku 4.5 (no think) | 0.31      | 1.07       | 2.84      | 0.31      | 1.07       | 2.84      | 0.31       | 1.07        | 2.84       |

Medium profile split (Sonnet, medium): turns 65×0.0469 = $3.05 (57 %), plans 8.67×0.1498 = $1.30 (24 %), regens 17.3×0.0574 = $1.00 (19 %). **Chat turns, not plans, are the dominant cost line at Medium/Heavy.**

## 5. Revenue side

`net PLN = price / 1.23 × 0.85`; yearly ÷ 12; USD = PLN / 3.6894

| Price        | net PLN/mo                           | net USD/mo |
| ------------ | ------------------------------------ | ---------- |
| 19,99 zł/mo  | 19.99/1.23 = 16.252 → ×0.85 = 13.814 | 3.744      |
| 29,99 zł/mo  | 24.382 → 20.725                      | 5.617      |
| 49,99 zł/mo  | 40.642 → 34.546                      | 9.364      |
| 149,99 zł/yr | 121.943 → 103.652 → /12 = 8.638      | 2.341      |
| 199,99 zł/yr | 162.593 → 138.204 → 11.517           | 3.122      |
| 299,99 zł/yr | 243.894 → 207.310 → 17.276           | 4.683      |

(RevenueCat 1 % of gross MTR would add ~1.18 % of net once > $2.5k MTR — market-research.md §1; ignored below.)

## 6. Margin: API cost as % of net revenue (warm 1h, medium effort)

| Model / profile         | $/mo  | 19,99 | 29,99 | 49,99 | 149,99/yr | 199,99/yr | 299,99/yr |
| ----------------------- | ----- | ----- | ----- | ----- | --------- | --------- | --------- |
| Opus 5 Light            | 3.66  | 98 %  | 65 %  | 39 %  | 156 %     | 117 %     | 78 %      |
| Opus 5 Medium           | 13.35 | 357 % | 238 % | 143 % | 570 %     | 428 %     | 285 %     |
| Opus 5 Heavy            | 36.14 | 965 % | 643 % | 386 % | 1544 %    | 1158 %    | 772 %     |
| Sonnet 5 Light          | 1.46  | 39 %  | 26 %  | 16 %  | 62 %      | 47 %      | 31 %      |
| Sonnet 5 Medium         | 5.34  | 143 % | 95 %  | 57 %  | 228 %     | 171 %     | 114 %     |
| Sonnet 5 Heavy          | 14.46 | 386 % | 257 % | 154 % | 617 %     | 463 %     | 309 %     |
| Haiku (think) Light     | 0.72  | 19 %  | 13 %  | 8 %   | 31 %      | 23 %      | 15 %      |
| Haiku (think) Medium    | 2.72  | 73 %  | 48 %  | 29 %  | 116 %     | 87 %      | 58 %      |
| Haiku (think) Heavy     | 7.40  | 198 % | 132 % | 79 %  | 316 %     | 237 %     | 158 %     |
| Haiku (no think) Light  | 0.31  | 8 %   | 5 %   | 3 %   | 13 %      | 10 %      | 7 %       |
| Haiku (no think) Medium | 1.07  | 28 %  | 19 %  | 11 %  | 46 %      | 34 %      | 23 %      |
| Haiku (no think) Heavy  | 2.84  | 76 %  | 51 %  | 30 %  | 121 %     | 91 %      | 61 %      |

Blended base (assumed 60 % Light / 30 % Medium / 10 % Heavy), % of net at 19,99 / 29,99 / 49,99: Opus medium $9.81 → 262/175/105 %; Opus low $6.74 → 180/120/72 %; Sonnet medium $3.93 → 105/70/42 %; Sonnet low $2.70 → 72/48/29 %; Haiku-think medium $1.99 → 53/35/21 %; Haiku-no-think $0.79 → 21/14/8 %.

## 7. Break-even usage per price point (warm 1h medium)

Cells: max **plans/mo if only plans** / max **turns/mo if only turns** / max **regens/mo if only regens** / **× Medium profile** affordable (net ÷ Medium monthly cost).

| Model            | 19,99                  | 29,99                  | 49,99                   | 149,99/yr             | 199,99/yr             | 299,99/yr              |
| ---------------- | ---------------------- | ---------------------- | ----------------------- | --------------------- | --------------------- | ---------------------- |
| Opus 5           | 10 / 32 / 26 / 0.28    | 15 / 48 / 39 / 0.42    | 25 / 80 / 65 / 0.70     | 6 / 20 / 16 / 0.18    | 8 / 27 / 22 / 0.23    | 13 / 40 / 33 / 0.35    |
| Sonnet 5         | 25 / 80 / 65 / 0.70    | 38 / 120 / 98 / 1.05   | 63 / 200 / 163 / 1.75   | 16 / 50 / 41 / 0.44   | 21 / 67 / 54 / 0.58   | 31 / 100 / 82 / 0.88   |
| Haiku (think)    | 58 / 146 / 133 / 1.38  | 87 / 219 / 199 / 2.07  | 145 / 365 / 332 / 3.45  | 36 / 91 / 83 / 0.86   | 48 / 122 / 111 / 1.15 | 72 / 183 / 166 / 1.72  |
| Haiku (no think) | 107 / 419 / 355 / 3.51 | 161 / 628 / 533 / 5.27 | 269 / 1048 / 888 / 8.78 | 67 / 262 / 222 / 2.20 | 90 / 349 / 296 / 2.93 | 134 / 524 / 444 / 4.39 |

Reading: Opus 5 at medium never breaks even on a Medium user at any price point; Sonnet 5 breaks even only at 29,99+/mo (1.05× Medium) — i.e. zero margin.

## 8. Cap keeping a Heavy user ≤ 30 % of net

`s = 0.3·net / HeavyCost`; caps = s × (173.3 turns, 17.3 plans, 65 regens). Cells: **turns / plans / regens per month**.

| Model (Heavy $/mo)      | 19,99 ($1.12 budget) | 29,99 ($1.69)   | 49,99 ($2.81)              | 149,99/yr ($0.70) | 199,99/yr ($0.94) | 299,99/yr ($1.41) |
| ----------------------- | -------------------- | --------------- | -------------------------- | ----------------- | ----------------- | ----------------- |
| Opus 5 (36.14)          | 5 / 0.5 / 2          | 8 / 0.8 / 3     | 13 / 1.3 / 5               | 3 / 0.3 / 1       | 4 / 0.4 / 2       | 7 / 0.7 / 3       |
| Sonnet 5 (14.46)        | 13 / 1.3 / 5         | 20 / 2.0 / 8    | 34 / 3.4 / 13              | 8 / 0.8 / 3       | 11 / 1.1 / 4      | 17 / 1.7 / 6      |
| Haiku (think) (7.40)    | 26 / 2.6 / 10        | 39 / 3.9 / 15   | 66 / 6.6 / 25              | 16 / 1.6 / 6      | 22 / 2.2 / 8      | 33 / 3.3 / 12     |
| Haiku (no think) (2.84) | 69 / 6.9 / 26        | 103 / 10.3 / 39 | 172 / 17.2 / 64 (≈ no cap) | 43 / 4.3 / 16     | 57 / 5.7 / 21     | 86 / 8.6 / 32     |

A **plans-only** cap (turns and regens left at Heavy levels) is infeasible for every model/price except Haiku-no-think at 49,99 (16.5 plans): Heavy's 173 turns alone exceed the 30 % budget everywhere else. Any cap must bind on **messages**, not just plans.

**Routing scenarios** (caches are model-scoped — §1/§5 — so plan/regen requests on the second model are priced as cold-user for history; chat model's prefix stays warm):

| Scenario                                                               | Light | Medium | Heavy | Blended | % net 19,99 / 29,99 / 49,99 |
| ---------------------------------------------------------------------- | ----- | ------ | ----- | ------- | --------------------------- |
| S1 Sonnet 5 all medium                                                 | 1.46  | 5.34   | 14.46 | 3.93    | 105 / 70 / 42 %             |
| S2 Sonnet 5 all low                                                    | 1.03  | 3.66   | 9.81  | 2.70    | 72 / 48 / 29 %              |
| S3 Sonnet 5: chat low, plans medium, regens low                        | 1.19  | 3.98   | 10.45 | 2.95    | 79 / 53 / 32 %              |
| **S4 Haiku-no-think chat; Sonnet 5 medium plans; Sonnet 5 low regens** | 0.87  | 3.00   | 8.11  | 2.23    | 60 / 40 / 24 %              |
| S5 Haiku-no-think chat; Opus 5 medium plans; Sonnet low regens         | 1.94  | 5.13   | 12.39 | 3.94    | 105 / 70 / 42 %             |
| S6 Opus 5 all low                                                      | 2.57  | 9.14   | 24.53 | 6.74    | 180 / 120 / 72 %            |
| S7 Opus 5 chat low, plans medium, regens low                           | 2.97  | 9.94   | 26.13 | 7.38    | 197 / 131 / 79 %            |

Only S4 (or S2) gets the blended cost near 30 % — and only at 49,99 zł/mo (or 299,99/yr ≈ net $4.68 → S4 48 %). At 19,99–29,99 nothing except Haiku-only stays under 30 % blended.

## 9. Free-trial exposure (7-day trial = 1 week Medium: 15 turns + 2 plans + 4 regens, warm 1h)

`cost/trial = 15·A + 2·B + 4·C`; `cost/payer = cost/trial ÷ 0.377`

| Model            | $/trial start (medium) | $/acquired payer | % of first-month net at 29,99 | % of H&F 1-yr LTV/payer $35.64 | low-effort trial → per payer |
| ---------------- | ---------------------- | ---------------- | ----------------------------- | ------------------------------ | ---------------------------- |
| Opus 5           | 3.082                  | 8.17             | 146 %                         | 23 %                           | 2.110 → 5.60                 |
| Sonnet 5         | 1.233                  | 3.27             | 58 %                          | 9 %                            | 0.844 → 2.24                 |
| Haiku (think)    | 0.627                  | 1.66             | 30 %                          | 5 %                            | 0.467 → 1.24                 |
| Haiku (no think) | 0.246                  | 0.65             | 12 %                          | 2 %                            | 0.246 → 0.65                 |

Per install (AI-app trial-start rate 8.5 %, market-research.md §4): ×0.085 → Sonnet ≈ $0.10/install. Note the LTV benchmark is for AI apps with 21 % 12-month retention (§4); RC recommends trial allowances "measured in generations rather than days" (§5) — a trial capped at 1 plan + 20 messages on Sonnet-medium costs ≈ $1.09, same order as the 7-day Medium week.

## 10. Sensitivity (Medium profile $/mo; Heavy in brackets)

| Model            | base          | thinking ×2           | cache hit 50 %        | both          | slim digest 40/line | warm 5m TTL | low effort |
| ---------------- | ------------- | --------------------- | --------------------- | ------------- | ------------------- | ----------- | ---------- |
| Opus 5           | 13.35 [36.14] | 19.78 [53.82] (+48 %) | 24.72 [68.01] (+85 %) | 33.08 [91.07] | 12.65               | 12.04       | 9.14       |
| Sonnet 5         | 5.34 [14.46]  | 7.91 [21.53] (+48 %)  | 9.89 [27.20] (+85 %)  | 13.23 [36.43] | 5.06                | 4.82        | 3.66       |
| Haiku (think)    | 2.72 [7.40]   | 3.78 [10.31]          | 3.87 [10.65]          | 4.93 [13.56]  | 2.61                | 2.29        | 2.02       |
| Haiku (no think) | 1.07 [2.84]   | 1.07                  | 2.52 [6.92] (+136 %)  | 2.52          | 0.96                | 0.96        | 1.07       |

"50 % hit" modelled as 0.5·warm + 0.5·cold-all. Thinking ×2 is the more likely miss (Opus/Sonnet "reach for tools and self-verification loops more readily", §1) — it scales output _and_ tail writes (thinking blocks are re-sent at 2× within the turn and retained across turns). A 50 % miss on the **shared** prefix is unrealistic once ≥30 paying users exist: Poisson `hit = 1 − e^(−λ·TTL)` (§6) with 91 req/user/month gives N=10: 72 % (1 h) / 10 % (5 m); N=30: 98 % / 27 %; N=100: ~100 % / 65 % — so the shared prefix must be 1 h TTL. The realistic miss is per-user history when a conversation is resumed after > TTL; hybrid TTL (prefix 1 h, tail 5 m) costs Sonnet $0.0044/turn less than all-1 h but a 5-min-plus pause then costs +$0.0253 (cold-user) — 1 h on the tail wins when > ~1 in 6 turns follows a pause > 5 min, which is typical of a cooking-planning chat.

## 11. Recommendation: metering unit

Meter in **two visible counters, not tokens and not conversations**: (1) **generations** = week plans (weight 3) and regenerates/leftover suggestions (weight 1) — cost ratio plan:regen:turn is stable at 1 : 3.2–3.9 : 1.2 across all four model configs (§3), so a 3/1 weighting tracks cost within ±20 % regardless of which model ends up serving plans; (2) **chat messages** as a separate monthly (plus daily fair-use) cap, routed to the cheap model. Tokens are rejected because per-turn variance is small (turn 8 costs only +11 % over the session average) while Apple 3.1.2(c) requires stating a concrete quantity on the paywall (market-research.md §2) and users cannot forecast tokens; per-conversation limits are rejected because cost per turn grows with history (cold-user resume of a turn-8 chat = 2.8× a warm turn) so conversation cost is unbounded — instead enforce a hard ~20-turn conversation length (start a new one) purely as a cost guard. Plans alone cannot be the unit: at Medium usage they are only 24 % of cost while chat turns are 57 %, and §8 shows a plans-only cap is infeasible at every price point except Haiku at 49,99. Concrete allowances that hold a Heavy user at ≈30 % of net with routing S4 (Haiku-no-think chat $0.0089, Sonnet-medium plan $0.16, Sonnet-low regen ≈$0.06): 49,99 zł/mo → ~150 messages + 6 plans + 8 regens ≈ $2.81; 29,99 zł/mo → ~80 messages + 4 plans + 4 regens ≈ $1.6 (i.e. one plan per week and ~3 messages/day); 19,99 zł/mo only works with ~50 messages + 3 plans. A single "credit" currency (RevenueCat Virtual Currency, §1) is viable only if all actions run on one model; under routing the plan:message cost ratio jumps to ~18:1 and one currency becomes either meaningless for chat or punitive for plans, hence two counters. Purchased top-up credits may not expire (Apple 3.1.1) — sell top-ups only for generations.

## 12. Items outside the ask but material

- **No metering tables exist**: backend-schema.md line 189 — no `AiUsage`, `Conversation`, `Subscription`, `Entitlement`; the ledger (per-request `usage` fields: `input_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`, `output_tokens` — §5) must be persisted per household per action to make any cap enforceable and to validate this model against real traffic (docs: "price the tail, not the median", §6).
- **Haiku 4.5 with thinking on is a trap**: the strip-induced messages-cache rewrite (`prompt-caching.md:233`) makes Haiku-think ≈3× Haiku-no-think per turn; if Haiku is used for chat, run it without thinking.
- **Opus 5 is out of range** at every price point and profile (Light user alone = 65 % of net at 29,99); Opus-only makes sense as a per-plan "premium generation" at 49,99+ or for a top-up SKU.
- **Yearly 149,99 zł (net $2.34/mo)** is below Sonnet's Light-user cost + trial amortisation; do not ship it unless chat is Haiku-only.
- **Two-person household** does not change cost (plannedServings is a plan attribute — backend-schema.md PlanItem; servings=2 everywhere), so one price for 1 and 1+1 households is cost-neutral; a "family/2-adult" tier is a pricing, not a cost, decision.
- Validation on real Mac hardware is blocked (disk/swap); the model can be validated cheaply from the Railway instance by logging `usage` for ~30 real sessions and re-running `unit_econ.py` with measured component sizes (`count_tokens` on the actual digest/tool JSON — §9).

## 13. Pomiar zamiast szacunku — krok 4 Fazy 0 (31.08.2026)

Zmierzone `count_tokens` na **realnym katalogu dev: 89 aktywnych przepisów**
gospodarstwa `22222222-2222-4222-8222-222222222222`, digest zbudowany przez
`src/agent/catalog-digest.ts`, pomiar `pnpm agent:measure:tokens`.
`catalogVersion` mierzonego digestu: `005df8ef1023` (13 514 znaków).

| Model            | nagłówek | CAŁY digest | tok/przepis | wobec szacunku 127 |
| ---------------- | -------- | ----------- | ----------- | ------------------ |
| Claude Sonnet 5  | 210      | **8 112**   | 88,8        | 70 %               |
| Claude Opus 5    | 210      | **8 112**   | 88,8        | 70 %               |
| Claude Haiku 4.5 | 153      | **6 514**   | 71,5        | 56 %               |

**Co się potwierdziło.** „Podatek od polskiego" zmierzył się na **1,27×**
wobec zakładanych 1,3× (§0 poz. 6) — trafnie. Sonnet 5 i Opus 5 mają
**identyczny tokenizer** (co do tokena, na każdej próbce), więc między nimi
wybiera się wyłącznie po cenie i jakości, nigdy po liczbie tokenów — zgodnie
z §1.

**Co było nie tak.** Błąd nie siedział w mnożnikach, tylko w oszacowaniu
samej zawartości linii: przyjęte 75 tokenów bazy to realnie ~55. Stąd
digest 8 112 zamiast 11 534 — **o 3 422 tokeny mniej**.

**Poprawiony stały prefiks** (pozostałe składniki nadal szacowane):

| Składnik             | §1 (szacunek) | po pomiarze                               |
| -------------------- | ------------- | ----------------------------------------- |
| Schematy narzędzi    | 3 250         | 3 250 (szacunek — narzędzia nie istnieją) |
| Instrukcje systemowe | 1 950         | 1 950 (szacunek)                          |
| Digest katalogu      | 11 534        | **8 112 (zmierzone)**                     |
| **Shared prefix S**  | **16 734**    | **13 312**                                |

**Wpływ na rachunek: niewielki, i to jest dobra wiadomość.** Prefiks jedzie
z cache po 0,1× stawki, więc wg własnej analizy wrażliwości (§10, kolumna
„slim digest 40/line") chudszy digest to ~5 % kosztu całości. Jeden odczyt
digestu z cache: Sonnet 5 **$0,00162**, Opus 5 **$0,00406**, Haiku 4.5
**$0,00065**. Rekomendacje z §11 zostają bez zmian.

**Ustalenie uboczne: polskie znaki nie kosztują.** Ta sama linia z ogonkami
i bez różni się o 3 % (90 vs 87 tokenów). Pomysł „zaoszczędzimy, usuwając
diakrytyki z digestu" jest nieopłacalny i psułby nazwy przepisów — zamknięte.

**Schematy narzędzi — zmierzone 31.08.2026** (8 narzędzi, `src/agent/tools/agent-tools.ts`):

| Model            | schematy narzędzi | wobec szacunku 3 250 |
| ---------------- | ----------------- | -------------------- |
| Claude Sonnet 5  | **3 586**         | 110 %                |
| Claude Opus 5    | **3 518**         | 108 %                |
| Claude Haiku 4.5 | **3 395**         | 104 %                |

Tu szacunek okazał się ZANIŻONY, odwrotnie niż przy digeście — narzędzia kosztują ~10 % więcej,
niż zakładano. Ciekawostka wbrew wcześniejszemu ustaleniu: przy digeście Sonnet 5 i Opus 5 dały
identyczną liczbę co do tokena, a przy narzędziach różnią się o 68. Tokenizer tekstu jest ten sam
(digest to potwierdza), więc różnica siedzi w tym, jak API renderuje schematy narzędzi per model —
przy szacowaniu prefiksu nie wolno więc przenosić liczby narzędzi między modelami.

**Poprawiony stały prefiks** (Sonnet 5; jeden składnik nadal szacowany):

| Składnik             | §1 (szacunek) | po pomiarze                     |
| -------------------- | ------------- | ------------------------------- |
| Schematy narzędzi    | 3 250         | **3 586 (zmierzone)**           |
| Instrukcje systemowe | 1 950         | 1 950 (szacunek — nie istnieją) |
| Digest katalogu      | 11 534        | **8 112 (zmierzone)**           |
| **Shared prefix S**  | **16 734**    | **13 648**                      |

**Instrukcje systemowe — zmierzone 31.08.2026** (`AGENT_INSTRUCTIONS`):
Sonnet 5 i Opus 5 **818**, Haiku 4.5 **612** — szacunek mówił 1 950, czyli **42 %**. Napisany
prompt okazał się znacznie zwięźlejszy, niż zakładano.

**STAŁY PREFIKS — komplet zmierzony:**

| Model            | digest | narzędzia | instrukcje | RAZEM      | wobec szacunku 16 734 |
| ---------------- | ------ | --------- | ---------- | ---------- | --------------------- |
| Claude Sonnet 5  | 8 112  | 3 586     | 818        | **12 516** | 75 %                  |
| Claude Opus 5    | 8 112  | 3 518     | 818        | **12 448** | 74 %                  |
| Claude Haiku 4.5 | 6 514  | 3 395     | 612        | **10 521** | 63 %                  |

**Pierwsza prawdziwa tura (`pnpm agent:smoke`, Sonnet 5, effort medium):** pytanie o jedną
kolację, model sam sięgnął po `get_week_plan`, odpowiedział przepisem z katalogu z makrami na
porcję i odniósł się do celu domownika. Dwa wywołania API, 41,8 s, **$0,0596** — z czego 83 %
to ZAPIS cache (12 448 tokenów × 2×), bo to była pierwsza tura. Kolejne tury w tej samej godzinie
czytają ten sam prefiks po 0,1×, czyli ~$0,0025 zamiast $0,0498 na prefiks.

**Digest urósł o alergeny i tagi diet (31.08.2026) — i to SIĘ OPŁACIŁO.**
Doszły pola `A:` i `D:`, więc digest ma teraz **11 601** tokenów zamiast 8 112 (127,3 na przepis,
czyli dokładnie tyle, ile mówił pierwotny szacunek), a stały prefiks **16 015** zamiast 12 516.

Mimo to koszt SPADŁ, bo model przestał zgadywać i ponawiać. Ten sam scenariusz (plan na trzy dni
dla osoby z alergią na laktozę), przed i po:

|             | przed   | po          |
| ----------- | ------- | ----------- |
| wywołań API | 7       | **3**       |
| czas        | 61 s    | **26 s**    |
| koszt tury  | $0,4006 | **$0,1351** |

Wniosek do zapamiętania przy każdej kolejnej decyzji o wielkości prefiksu: prefiks czyta się
z cache po 0,1× stawki, a każda zbędna runda narzędzi kosztuje pełną cenę wejścia i wyjścia.
Dokładanie do prefiksu informacji, która oszczędza choćby JEDNĄ rundę, zwraca się wielokrotnie.

**Koszt zmierzonych scenariuszy** (Sonnet 5, effort medium, cache zimny):
plan na cały tydzień (21 posiłków) **$0,2993**; trzy dni z alergią **$0,1351**; dwie kolacje
z limitem czasu **$0,1179**; nierozwiązywalne żądanie wegańskie **$0,9958** (12 rund + odpowiedź
końcowa — pusta pula kosztuje najwięcej).

**Czego pomiar NADAL nie obejmuje.** Blok gospodarstwa (domownicy, daty) jest zmienny per dom i nie
wchodzi do wspólnego prefiksu — model liczy go osobno (`U` = 676 z szacunku). Druga połowa
walidacji (thinking, historia rozmowy, realne `usage` z wielu tur) wymaga ruchu produkcyjnego;
ledger `AiUsage` już go zapisuje.

**Po rozbudowie katalogu pomiar trzeba powtórzyć.** Digest rośnie liniowo:
planowane +60 przepisów (gałąź `feat/katalog-nowe-przepisy-tm-i-kurczak`)
przesunie go z 8,1k do ~13,5k na Sonnecie/Opusie. Wystarczy `pnpm
agent:measure:tokens` — skrypt czyta katalog z bazy, nic nie jest zaszyte.
