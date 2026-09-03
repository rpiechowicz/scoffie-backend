#!/usr/bin/env python3
"""Rachunek cennika i limitów asystenta — stan na 3.09.2026.

Wszystkie parametry są jawne i podpisane źródłem. Uruchom:
    python docs/plans/weekly-meals-ai-agent/cennik_i_limity_2026_09.py
Wynik to tabele wklejone do `cennik-i-limity-2026-09.md`.
"""

# ── kurs i prowizje ───────────────────────────────────────────────────────────
FX = 3.7224            # USD→PLN, NBP tabela A z 3.09.2026
VAT = 1.23             # Polska, Apple jest sprzedawcą i odprowadza VAT
APPLE = 0.85           # Small Business Program (15 %), także po 1.10.2026 w UE

def net_usd(price_pln, yearly=False):
    net = price_pln / VAT * APPLE
    return (net / 12 if yearly else net) / FX

# ── cennik modeli ($/MTok) — src/config/model-prices.ts, potwierdzony 3.09.2026
PRICE = {
    'sonnet': dict(inp=2.0, out=10.0),
    'haiku': dict(inp=1.0, out=5.0),
    'opus': dict(inp=5.0, out=25.0),
}
CACHE_READ = 0.1       # odczyt z cache = 0,1× wejścia
CACHE_WRITE_1H = 2.0   # zapis cache 1 h = 2× wejścia (tak liczy kod; 5 min = 1,25×)

# ── ZMIERZONY stały prefiks, katalog 147 przepisów, 17 narzędzi (pnpm agent:measure:tokens, 3.09.2026)
PREFIX = {'sonnet': 30_206, 'haiku': 24_717, 'opus': 30_138}
HOUSEHOLD_BLOCK = 700  # blok gospodarstwa, per dom (szacunek z cost-model.md: 676)

# ── ZMIERZONE tury (Sonnet 5, effort medium, cache zimny — cost-model.md §13 i smoke)
MEASURED = {
    'pytanie o jedną kolację (2 wywołania)': 0.0596,   # w tym 83 % to zapis cache prefiksu
    'dwie kolacje z limitem czasu': 0.1179,
    'plan na 3 dni z alergią (3 wywołania)': 0.1351,
    'plan na cały tydzień, 21 posiłków': 0.2993,
    'żądanie nierozwiązywalne, 12 rund': 0.9958,      # = dzisiejszy sufit AI_MAX_TURN_COST_USD
}

# ── koszt jednej tury WG RODZAJU, cache ciepły (prefiks czytany po 0,1×)
# Składniki: odczyt prefiksu × wywołania + blok domu + historia + wyjście (tekst + thinking)
def turn_cost(model, calls, out_tokens, tail_tokens, history_tokens=3000):
    p = PRICE[model]
    prefix_reads = calls * (PREFIX[model] + HOUSEHOLD_BLOCK + history_tokens) * p['inp'] * CACHE_READ
    tail_writes = tail_tokens * p['inp'] * CACHE_WRITE_1H
    output = out_tokens * p['out']
    return (prefix_reads + tail_writes + output) / 1e6

# rodzaje tur (wywołania API, tokeny wyjścia z thinking, ogon zapisywany do cache)
TURN_KINDS = {
    # nazwa: (calls, out, tail)
    'pytanie / rozmowa': (2, 1_800, 1_200),
    'podmiana / opcje': (4, 3_500, 4_000),
    'plan dnia': (4, 5_000, 5_000),
    'plan tygodnia': (6, 8_000, 9_000),
    'ucieczka (12 rund)': (13, 16_000, 20_000),
}

def kind_cost(model, kind):
    calls, out, tail = TURN_KINDS[kind]
    return turn_cost(model, calls, out, tail)

# ── sufit kosztu tury (AI_MAX_TURN_COST_USD) — sprawdzany między rundami, więc
# ostatnia runda może go przebić o koszt jednego wywołania (≈ +20 %)
def hard_cap(cap):
    return cap * 1.2

print(f'=== 1. Przychód netto z jednej subskrypcji (VAT 23 %, Apple 15 %, USD/PLN {FX:.4f})')
for label, price, yearly in [('29,99 zł/mies.', 29.99, False), ('39,99 zł/mies.', 39.99, False),
                             ('49,99 zł/mies.', 49.99, False), ('249,99 zł/rok', 249.99, True),
                             ('299,99 zł/rok', 299.99, True), ('349,99 zł/rok', 349.99, True)]:
    n = net_usd(price, yearly)
    print(f'  {label:16} → netto ${n:5.2f}/mies. = {n * FX:5.2f} zł/mies.')

print('\n=== 2. Koszt jednej tury (cache ciepły) — Sonnet 5 vs Haiku 4.5, $')
print(f"  {'rodzaj tury':22} {'Sonnet':>8} {'Haiku':>8}")
for kind in TURN_KINDS:
    print(f'  {kind:22} {kind_cost("sonnet", kind):8.3f} {kind_cost("haiku", kind):8.3f}')
print('  zmierzone (Sonnet, cache zimny):')
for k, v in MEASURED.items():
    print(f'    {k:44} ${v:.4f}')
print(f'  zapis prefiksu do cache (raz na godzinę ruchu, wspólny dla wszystkich domów): '
      f'Sonnet ${PREFIX["sonnet"] * PRICE["sonnet"]["inp"] * CACHE_WRITE_1H / 1e6:.3f}, '
      f'Haiku ${PREFIX["haiku"] * PRICE["haiku"]["inp"] * CACHE_WRITE_1H / 1e6:.3f}')

# ── profile miesięczne PRZY PEŁNYM WYKORZYSTANIU limitu (najbardziej restrykcyjnie)
def month_cost(routing, chat_turns, plan_turns, swap_turns):
    """routing: 'sonnet' = wszystko Sonnet; 'haiku+sonnet' = rozmowa Haiku, planowanie Sonnet."""
    chat_model = 'haiku' if routing == 'haiku+sonnet' else 'sonnet'
    return (chat_turns * kind_cost(chat_model, 'pytanie / rozmowa')
            + swap_turns * kind_cost('sonnet', 'podmiana / opcje')
            + plan_turns * kind_cost('sonnet', 'plan tygodnia'))

QUOTAS = {
    # nazwa: (wiadomości/mies., z czego planowania, z czego podmiany, zapisy planu)
    'dziś (200 wiad. / 30 planów)': (200, 30, 40, 30),
    'propozycja PRO (60 wiad. / 8 planów)': (60, 12, 12, 8),
    'propozycja PRO+ (120 wiad. / 16 planów)': (120, 24, 24, 16),
    'próba (5 wiad. / 1 plan)': (5, 1, 1, 1),
}

print('\n=== 3. Miesiąc przy PEŁNYM wykorzystaniu limitu, $ (reszta wiadomości = rozmowa)')
print(f"  {'limit':42} {'wszystko Sonnet':>16} {'Haiku+Sonnet':>13} {'sufit $0,50':>12} {'sufit $1,00':>12}")
for name, (msgs, plans, swaps, _writes) in QUOTAS.items():
    chats = msgs - plans - swaps
    all_s = month_cost('sonnet', chats, plans, swaps)
    routed = month_cost('haiku+sonnet', chats, plans, swaps)
    print(f'  {name:42} {all_s:16.2f} {routed:13.2f} {msgs * hard_cap(0.5):12.2f} {msgs * hard_cap(1.0):12.2f}')

print('\n=== 4. Marża przy pełnym wykorzystaniu (Haiku+Sonnet), % przychodu netto')
prices = [('29,99', net_usd(29.99)), ('39,99', net_usd(39.99)), ('49,99', net_usd(49.99)), ('299,99/rok', net_usd(299.99, True))]
print(f"  {'limit':42}" + ''.join(f'{p[0]:>12}' for p in prices))
for name, (msgs, plans, swaps, _w) in QUOTAS.items():
    if name.startswith('próba'):
        continue
    c = month_cost('haiku+sonnet', msgs - plans - swaps, plans, swaps)
    print(f'  {name:42}' + ''.join(f'{100 * c / n:11.0f}%' for _, n in prices))

print('\n=== 5. Ile kosztuje próba (jedno gospodarstwo)')
msgs, plans, swaps, _ = QUOTAS['próba (5 wiad. / 1 plan)']
print(f'  realnie (Haiku+Sonnet): ${month_cost("haiku+sonnet", msgs - plans - swaps, plans, swaps):.2f}; '
      f'wszystko Sonnet: ${month_cost("sonnet", msgs - plans - swaps, plans, swaps):.2f}; '
      f'sufit $0,50: ${msgs * hard_cap(0.5):.2f}; sufit $1,00: ${msgs * hard_cap(1.0):.2f}')
for conv in (0.10, 0.20, 0.377):
    print(f'  konwersja próba→płatny {conv:.0%}: koszt prób na jednego płacącego ${month_cost("haiku+sonnet", 3, 1, 1) / conv:.2f}')

print('\n=== 6. Próg rentowności (koszty stałe ≈ $45/mies.: Railway, Apple, domena, R2)')
FIXED = 45.0
for label, price, yearly in [('39,99 zł/mies.', 39.99, False), ('299,99 zł/rok', 299.99, True)]:
    n = net_usd(price, yearly)
    for use in (0.5, 1.0):
        msgs, plans, swaps, _ = QUOTAS['propozycja PRO (60 wiad. / 8 planów)']
        c = month_cost('haiku+sonnet', msgs - plans - swaps, plans, swaps) * use
        contrib = n - c
        print(f'  {label} przy {use:.0%} limitu: koszt AI ${c:.2f}, wkład ${contrib:.2f} → {FIXED / contrib:.0f} subskrypcji pokrywa koszty stałe')

print('\n=== 7. Budżet dobowy jako bezpiecznik: AI_GLOBAL_DAILY_BUDGET_USD = 0,8 × przychód dzienny')
for subs in (10, 30, 100, 300):
    rev_day = subs * net_usd(39.99) / 30
    print(f'  {subs:4} subskrypcji × 39,99 zł: przychód ${rev_day:6.2f}/dzień → budżet ${0.8 * rev_day:6.2f}/dzień '
          f'(= ${0.8 * rev_day * 30:.0f}/mies.; najgorszy miesiąc to strata zero, nie bankructwo)')

# ─────────────────────────────────────────────────────────────────────────────
# DOPISANE 3.09.2026 wieczorem: routing modeli i drabina planów per dom.
# ─────────────────────────────────────────────────────────────────────────────

# Zmierzony prefiks po rozbudowie katalogu do 147 przepisów i 17 narzędzi
# (pnpm agent:measure:tokens): Sonnet 30 206, Haiku 24 717 — już w PREFIX.

def routed_month(chat, swap, plans, chat_model='haiku'):
    """Faza CHAT na `chat_model`, faza PLANNER zawsze na Sonnecie.

    Przekazanie pałeczki kosztuje dwie rundy taniego modelu i ZIMNY prefiks
    Sonneta w tej turze — dopóki domów jest mało, prefiks planisty grzeje
    tylko inna tura planująca w tej samej godzinie.
    """
    handoff_tax = 2 * (PREFIX[chat_model] * PRICE[chat_model]['inp'] * CACHE_READ) / 1e6 + 0.0005
    return (chat * kind_cost(chat_model, 'pytanie / rozmowa')
            + swap * (kind_cost('sonnet', 'podmiana / opcje') + handoff_tax)
            + plans * (kind_cost('sonnet', 'plan tygodnia') + handoff_tax))

print('\n=== 8. Routing: ile realnie oszczędza (miesiąc 60 wiad. = 36 rozmów, 12 podmian, 12 planów)')
base = month_cost('sonnet', 36, 12, 12)
routed = routed_month(36, 12, 12)
print(f'  wszystko Sonnet:            ${base:.2f}')
print(f'  routing (rozmowa na Haiku): ${routed:.2f}  → oszczędność {100*(base-routed)/base:.0f} %')
cold_pen = PREFIX['sonnet'] * PRICE['sonnet']['inp'] * CACHE_WRITE_1H / 1e6
print(f'  gdy prefiks Sonneta jest ZIMNY przy każdej turze planującej (< ~10 domów):')
print(f'    +${cold_pen:.3f} na turę planującą → ${routed + 24*cold_pen:.2f} (routing przestaje się opłacać)')
print('  wniosek: routing włączać razem z paywallem, nie wcześniej — przy 30+ domach prefiks jest ciepły.')

print('\n=== 9. Drabina planów: limit jest produktem, liczba osób tylko etykietą')
LADDER = {
    'Solo — 1 osoba':        (29.99, 40, 6),
    'Duet — 2 osoby':        (39.99, 60, 8),
    'Rodzina — 3+ osób':     (59.99, 100, 14),
}
print(f"  {'plan':24} {'cena':>8} {'wiad.':>6} {'plany':>6} {'netto $':>9} {'koszt $':>9} {'marża':>7} {'zł/wiad.':>9}")
for name, (price, msgs, plans) in LADDER.items():
    n = net_usd(price)
    swaps = round(msgs * 0.2)
    plan_turns = round(msgs * 0.2)
    chats = msgs - swaps - plan_turns
    c = routed_month(chats, swaps, plan_turns)
    print(f'  {name:24} {price:8.2f} {msgs:6} {plans:6} {n:9.2f} {c:9.2f} {100*(n-c)/n:6.0f}% {price/msgs:9.2f}')

print('\n=== 10. Ile kosztuje dodatkowy domownik (blok gospodarstwa + kontekst + porcje)')
MEMBER_TOKENS = 130          # wpis w bloku <domownicy>, zmierzony rząd wielkości
for members in (1, 2, 4, 6):
    extra_reads = (members - 1) * MEMBER_TOKENS * 2   # blok domu + get_household_context
    per_plan = extra_reads * PRICE['sonnet']['inp'] * CACHE_READ * 6 / 1e6
    month = 12 * per_plan + 12 * per_plan * 0.7 + 36 * per_plan * 0.3
    print(f'  {members} os.: +${per_plan:.4f} na turze planu → +${month:.2f}/mies. '
          f'({100*month/net_usd(39.99):.1f} % netto z 39,99 zł)')
print('  wniosek: skład domu to 1–3 p.p. marży. Cena za wielkość domu sprzedaje ZUŻYCIE, nie koszt.')
