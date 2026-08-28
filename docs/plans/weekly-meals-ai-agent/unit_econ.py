#!/usr/bin/env python3
"""Unit-economics model for Weekly Meals AI assistant. All token numbers are explicit parameters."""
import math

FX = 3.6894          # PLN per USD, NBP 2026-08-25
POLISH = 1.3         # Polish text token uplift vs English (assumption)
WEEKS_PER_MONTH = 52 / 12

# model: tokenizer uplift T (new tokenizer for Opus5/Sonnet5), $/MTok in, out; thinking retained across turns?
MODELS = {
    'Opus 5':            dict(T=1.3, pin=5.0, pout=25.0, retain=True,  think=1.0, strip_pen=False),
    'Sonnet 5':          dict(T=1.3, pin=2.0, pout=10.0, retain=True,  think=1.0, strip_pen=False),
    'Haiku 4.5 (think)': dict(T=1.0, pin=1.0, pout=5.0,  retain=False, think=1.0, strip_pen=True),
    'Haiku 4.5 (no think)': dict(T=1.0, pin=1.0, pout=5.0, retain=False, think=0.0, strip_pen=False),
}
MIN_CACHE = {'Opus 5': 512, 'Sonnet 5': 1024, 'Haiku 4.5 (think)': 4096, 'Haiku 4.5 (no think)': 4096}

# static prefix, base tokens (old tokenizer, English-equivalent)
TOOLS = 2500
SYSTEM = 1500
DIGEST_PER_LINE = 75
DIGEST = 89 * DIGEST_PER_LINE + 150
HOUSEHOLD = 400

def tok(base, polish, T):
    return base * (POLISH if polish else 1.0) * T

def prefix(m, digest=DIGEST):
    T = MODELS[m]['T']
    shared = tok(TOOLS, False, T) + tok(SYSTEM, False, T) + tok(digest, True, T)
    user = tok(HOUSEHOLD, True, T)
    return shared, user

# request shapes: bundles = list of (tool_use base, tool_result base); thinking totals per effort (final tokens, no uplift)
REQ = {
    'A1': dict(user=60, bundles=[(50, 300)], visible=300, history=3000, prior_turns=3.5,
               think={'low': 500, 'medium': 1500, 'high': 4000}),
    'A2': dict(user=60, bundles=[(50, 300), (50, 300)], visible=300, history=3000, prior_turns=3.5,
               think={'low': 500, 'medium': 1500, 'high': 4000}),
    'A1_t8': dict(user=60, bundles=[(50, 300)], visible=300, history=6000, prior_turns=7,
               think={'low': 500, 'medium': 1500, 'high': 4000}),
    'A2_t8': dict(user=60, bundles=[(50, 300), (50, 300)], visible=300, history=6000, prior_turns=7,
               think={'low': 500, 'medium': 1500, 'high': 4000}),
    'B': dict(user=100, bundles=[(20, 200), (60, 600), (800, 300), (800, 100), (900, 80)], visible=400,
              history=1000, prior_turns=1, think={'low': 1500, 'medium': 4000, 'high': 8000}),
    'C': dict(user=80, bundles=[(60, 600), (150, 50)], visible=250, history=2000, prior_turns=2,
              think={'low': 700, 'medium': 2000, 'high': 4500}),
}
CHAT_THINK = {'low': 500, 'medium': 1500, 'high': 4000}  # per prior chat turn (for retained thinking)

def cost(m, req, effort, state='warm', ttl='1h', think_mult=1.0, digest=DIGEST, detail=False):
    M = MODELS[m]
    T = M['T']
    pin, pout = M['pin'], M['pout']
    pread = 0.1 * pin
    pwrite = (2.0 if ttl == '1h' else 1.25) * pin
    R = REQ[req]
    N = len(R['bundles']) + 1
    shared, userp = prefix(m, digest)
    think_total = R['think'][effort] * think_mult * M['think']
    th = think_total / N
    hist_vis = tok(R['history'], True, T)
    retained = R['prior_turns'] * CHAT_THINK[effort] * think_mult * M['think'] if M['retain'] else 0.0
    history = hist_vis + retained
    user = tok(R['user'], True, T)
    visible = tok(R['visible'], True, T)
    bundles = []
    for (tu, tr) in R['bundles']:
        bundles.append(th + tok(tu, False, T) + tok(tr, True, T))
    tail_writes = user + sum(bundles) + visible + (th if M['retain'] else 0.0)
    tail_reads = user * (N - 1) + sum(b * (N - 1 - k) for k, b in enumerate(bundles, start=1))
    output = visible + sum(tok(tu, False, T) for tu, _ in R['bundles']) + think_total
    # prefix + history accounting
    reads = tail_reads
    writes = tail_writes
    if state == 'warm':
        reads += N * (shared + userp)
        if M['strip_pen']:
            reads += (N - 1) * history
            writes += history
        else:
            reads += N * history
    elif state == 'cold_user':
        reads += N * shared + (N - 1) * (userp + history)
        writes += userp + history
    elif state == 'cold_all':
        reads += (N - 1) * (shared + userp + history)
        writes += shared + userp + history
    usd = (reads * pread + writes * pwrite + output * pout) / 1e6
    if detail:
        return dict(N=N, shared=shared, userp=userp, hist_vis=hist_vis, retained=retained, history=history,
                    user=user, visible=visible, bundles=bundles, tail_writes=tail_writes, tail_reads=tail_reads,
                    output=output, reads=reads, writes=writes, usd=usd, pread=pread, pwrite=pwrite, pout=pout)
    return usd

def chat(m, effort, state='warm', ttl='1h', t8=False, **kw):
    a, b = ('A1_t8', 'A2_t8') if t8 else ('A1', 'A2')
    return 0.5 * cost(m, a, effort, state, ttl, **kw) + 0.5 * cost(m, b, effort, state, ttl, **kw)

def fmt(x, d=4):
    return f"{x:.{d}f}"

print("FX", FX)
print("\n## Static prefix (final billed tokens)")
for m in ['Opus 5', 'Haiku 4.5 (think)']:
    s, u = prefix(m)
    print(m, "shared", round(s), "user", round(u), "total", round(s + u), "digest", round(tok(DIGEST, True, MODELS[m]['T'])))

print("\n## Detail A1 medium warm 1h per model")
for m in MODELS:
    d = cost(m, 'A1', 'medium', 'warm', '1h', detail=True)
    print(m, {k: (round(v, 1) if isinstance(v, float) else v) for k, v in d.items() if k != 'bundles'}, [round(b) for b in d['bundles']])
print("\n## Detail A2 medium warm 1h Sonnet")
d = cost('Sonnet 5', 'A2', 'medium', 'warm', '1h', detail=True)
print({k: (round(v, 1) if isinstance(v, float) else v) for k, v in d.items() if k != 'bundles'}, [round(b) for b in d['bundles']])
print("\n## Detail B medium warm 1h per model")
for m in MODELS:
    d = cost(m, 'B', 'medium', 'warm', '1h', detail=True)
    print(m, {k: (round(v, 1) if isinstance(v, float) else v) for k, v in d.items() if k != 'bundles'}, [round(b) for b in d['bundles']])
print("\n## Detail C medium warm 1h per model")
for m in MODELS:
    d = cost(m, 'C', 'medium', 'warm', '1h', detail=True)
    print(m, {k: (round(v, 1) if isinstance(v, float) else v) for k, v in d.items() if k != 'bundles'}, [round(b) for b in d['bundles']])

print("\n## Table: per-request cost USD, medium effort")
hdr = "| Model | warm 5m | warm 1h | cold-user 5m | cold-user 1h | cold-all 5m | cold-all 1h |"
for label, fn in [('A chat turn (avg turn, 1.5 tools)', lambda m, st, tt: chat(m, 'medium', st, tt)),
                  ('A chat turn at turn 8', lambda m, st, tt: chat(m, 'medium', st, tt, t8=True)),
                  ('B week plan', lambda m, st, tt: cost(m, 'B', 'medium', st, tt)),
                  ('C regenerate/leftover', lambda m, st, tt: cost(m, 'C', 'medium', st, tt))]:
    print("\n###", label)
    print(hdr)
    print("|---|---|---|---|---|---|---|")
    for m in MODELS:
        row = [fmt(fn(m, st, tt)) for st in ['warm', 'cold_user', 'cold_all'] for tt in ['5m', '1h']]
        print(f"| {m} | " + " | ".join(row) + " |")

print("\n## Table: effort sweep, warm 1h")
print("| Model | A low | A med | A high | B low | B med | B high | C low | C med | C high |")
for m in MODELS:
    row = []
    for e in ['low', 'medium', 'high']:
        row.append(fmt(chat(m, e)))
    for e in ['low', 'medium', 'high']:
        row.append(fmt(cost(m, 'B', e)))
    for e in ['low', 'medium', 'high']:
        row.append(fmt(cost(m, 'C', e)))
    print(f"| {m} | " + " | ".join(row) + " |")

PROFILES = {
    'Light': dict(turns=4, plans=1, regens=0),
    'Medium': dict(turns=15, plans=2, regens=4),
    'Heavy': dict(turns=40, plans=4, regens=15),
}

def monthly(m, prof, effort='medium', state='warm', ttl='1h', **kw):
    p = PROFILES[prof]
    w = WEEKS_PER_MONTH
    return (p['turns'] * w * chat(m, effort, state, ttl, **kw)
            + p['plans'] * w * cost(m, 'B', effort, state, ttl, **kw)
            + p['regens'] * w * cost(m, 'C', effort, state, ttl, **kw))

def monthly_mix(m, prof, effort='medium', hit=1.0, ttl='1h', **kw):
    return hit * monthly(m, prof, effort, 'warm', ttl, **kw) + (1 - hit) * monthly(m, prof, effort, 'cold_all', ttl, **kw)

print("\n## Monthly quantities")
for prof, p in PROFILES.items():
    print(prof, {k: round(v * WEEKS_PER_MONTH, 2) for k, v in p.items()})

print("\n## Monthly API cost USD per profile per model (warm, 1h, medium)")
print("| Model | Light | Medium | Heavy |")
for m in MODELS:
    print(f"| {m} | " + " | ".join(fmt(monthly(m, pr), 3) for pr in PROFILES) + " |")
print("\n## Monthly API cost USD (warm, 1h, LOW effort)")
print("| Model | Light | Medium | Heavy |")
for m in MODELS:
    print(f"| {m} | " + " | ".join(fmt(monthly(m, pr, 'low'), 3) for pr in PROFILES) + " |")
print("\n## Monthly API cost USD (warm, 1h, HIGH effort)")
print("| Model | Light | Medium | Heavy |")
for m in MODELS:
    print(f"| {m} | " + " | ".join(fmt(monthly(m, pr, 'high'), 3) for pr in PROFILES) + " |")

# revenue
PRICES_M = [19.99, 29.99, 49.99]
PRICES_Y = [149.99, 199.99, 299.99]
def net_pln_monthly(price, yearly=False):
    net = price / 1.23 * 0.85
    return net / 12 if yearly else net
print("\n## Revenue per price point")
print("| Price | net PLN/mo | net USD/mo |")
REV = {}
for p in PRICES_M:
    n = net_pln_monthly(p)
    REV[f"{p:.2f} zł/mo"] = n / FX
    print(f"| {p:.2f} zł/mo | {n:.3f} | {n / FX:.3f} |")
for p in PRICES_Y:
    n = net_pln_monthly(p, True)
    REV[f"{p:.2f} zł/yr"] = n / FX
    print(f"| {p:.2f} zł/yr | {n:.3f} | {n / FX:.3f} |")

print("\n## Margin: API cost as % of net revenue (warm 1h medium)")
for key, netusd in REV.items():
    print(f"\n### {key} -> net ${netusd:.3f}/mo")
    print("| Model | Light $ (%) | Medium $ (%) | Heavy $ (%) |")
    for m in MODELS:
        cells = []
        for pr in PROFILES:
            c = monthly(m, pr)
            cells.append(f"{c:.2f} ({100 * c / netusd:.0f}%)")
        print(f"| {m} | " + " | ".join(cells) + " |")

print("\n## Break-even usage per price point (warm 1h medium): max plans/mo if only plans; max turns/mo if only turns; Medium-profile multiples")
for key, netusd in REV.items():
    print(f"\n### {key} -> net ${netusd:.3f}/mo")
    print("| Model | plans/mo | turns/mo | regens/mo | x Medium profile |")
    for m in MODELS:
        cp, ct, cr = cost(m, 'B', 'medium'), chat(m, 'medium'), cost(m, 'C', 'medium')
        print(f"| {m} | {netusd / cp:.0f} | {netusd / ct:.0f} | {netusd / cr:.0f} | {netusd / monthly(m, 'Medium'):.2f} |")

print("\n## Heavy-user cap at 30% of net (proportional scaling of Heavy mix 40:4:15 per week)")
for key, netusd in REV.items():
    budget = 0.3 * netusd
    print(f"\n### {key} -> budget ${budget:.3f}/mo")
    print("| Model | Heavy cost | scale s | turns/mo cap | plans/mo cap | regens/mo cap | plans-only cap (turns at Heavy) |")
    for m in MODELS:
        hc = monthly(m, 'Heavy')
        s = min(1.0, budget / hc)
        w = WEEKS_PER_MONTH
        turns_cost = 40 * w * chat(m, 'medium')
        rem = budget - turns_cost - 15 * w * cost(m, 'C', 'medium')
        plans_only = rem / cost(m, 'B', 'medium') if rem > 0 else 0
        print(f"| {m} | {hc:.2f} | {s:.2f} | {40 * w * s:.0f} | {4 * w * s:.1f} | {15 * w * s:.0f} | {plans_only:.1f} |")

print("\n## Trial exposure: 7-day trial at Medium usage (15 turns, 2 plans, 4 regens), warm 1h medium")
print("| Model | cost/trial start | cost per acquired payer (÷0.377) | low effort trial | per payer |")
for m in MODELS:
    ct = 15 * chat(m, 'medium') + 2 * cost(m, 'B', 'medium') + 4 * cost(m, 'C', 'medium')
    cl = 15 * chat(m, 'low') + 2 * cost(m, 'B', 'low') + 4 * cost(m, 'C', 'low')
    print(f"| {m} | {ct:.3f} | {ct / 0.377:.3f} | {cl:.3f} | {cl / 0.377:.3f} |")

print("\n## Sensitivity: Medium profile monthly USD")
print("| Model | base | thinking x2 | cache hit 50% | thinking x2 + hit 50% | slim digest 40/line | 5m TTL warm | low effort |")
for m in MODELS:
    base = monthly(m, 'Medium')
    t2 = monthly(m, 'Medium', think_mult=2.0)
    h50 = monthly_mix(m, 'Medium', hit=0.5)
    both = monthly_mix(m, 'Medium', hit=0.5, think_mult=2.0)
    slim = monthly(m, 'Medium', digest=89 * 40 + 150)
    ttl5 = monthly(m, 'Medium', ttl='5m')
    low = monthly(m, 'Medium', 'low')
    print(f"| {m} | {base:.2f} | {t2:.2f} | {h50:.2f} | {both:.2f} | {slim:.2f} | {ttl5:.2f} | {low:.2f} |")

print("\n## Sensitivity: Heavy profile monthly USD")
print("| Model | base | thinking x2 | cache hit 50% | both |")
for m in MODELS:
    print(f"| {m} | {monthly(m, 'Heavy'):.2f} | {monthly(m, 'Heavy', think_mult=2.0):.2f} | {monthly_mix(m, 'Heavy', hit=0.5):.2f} | {monthly_mix(m, 'Heavy', hit=0.5, think_mult=2.0):.2f} |")

print("\n## Cost split per request (Sonnet 5, medium, warm 1h): prefix reads / history reads / tail / output")
for req in ['A1', 'A2', 'B', 'C']:
    d = cost('Sonnet 5', req, 'medium', detail=True)
    N = d['N']
    pr = N * (d['shared'] + d['userp']) * d['pread'] / 1e6
    hr = N * d['history'] * d['pread'] / 1e6
    tl = (d['tail_reads'] * d['pread'] + d['tail_writes'] * d['pwrite']) / 1e6
    out = d['output'] * d['pout'] / 1e6
    print(req, f"prefix {pr:.4f} history {hr:.4f} tail {tl:.4f} output {out:.4f} total {d['usd']:.4f}")
for m in ['Opus 5', 'Haiku 4.5 (no think)']:
    for req in ['A1', 'B']:
        d = cost(m, req, 'medium', detail=True)
        N = d['N']
        pr = N * (d['shared'] + d['userp']) * d['pread'] / 1e6
        hr = N * d['history'] * d['pread'] / 1e6
        tl = (d['tail_reads'] * d['pread'] + d['tail_writes'] * d['pwrite']) / 1e6
        out = d['output'] * d['pout'] / 1e6
        print(m, req, f"prefix {pr:.4f} history {hr:.4f} tail {tl:.4f} output {out:.4f} total {d['usd']:.4f}")

print("\n## Per-unit costs summary (warm 1h medium): turn / plan / regen")
for m in MODELS:
    print(m, fmt(chat(m, 'medium')), fmt(cost(m, 'B', 'medium')), fmt(cost(m, 'C', 'medium')), " low:", fmt(chat(m, 'low')), fmt(cost(m, 'B', 'low')), fmt(cost(m, 'C', 'low')))

print("\n## Routing scenarios, monthly USD per profile (plans on the second model are cold_user for history since caches are model-scoped)")
SCEN = {
    'S1 Sonnet5 all medium': lambda pr: monthly('Sonnet 5', pr, 'medium'),
    'S2 Sonnet5 all low': lambda pr: monthly('Sonnet 5', pr, 'low'),
    'S3 Sonnet5: chat low, plans medium, regens low': lambda pr: (PROFILES[pr]['turns'] * WEEKS_PER_MONTH * chat('Sonnet 5', 'low') + PROFILES[pr]['plans'] * WEEKS_PER_MONTH * cost('Sonnet 5', 'B', 'medium') + PROFILES[pr]['regens'] * WEEKS_PER_MONTH * cost('Sonnet 5', 'C', 'low')),
    'S4 Haiku(no think) chat, Sonnet5 medium plans (cold_user), Sonnet5 low regens (cold_user)': lambda pr: (PROFILES[pr]['turns'] * WEEKS_PER_MONTH * chat('Haiku 4.5 (no think)', 'medium') + PROFILES[pr]['plans'] * WEEKS_PER_MONTH * cost('Sonnet 5', 'B', 'medium', 'cold_user') + PROFILES[pr]['regens'] * WEEKS_PER_MONTH * cost('Sonnet 5', 'C', 'low', 'cold_user')),
    'S5 Haiku(no think) chat, Opus5 medium plans (cold_user), Sonnet5 low regens (cold_user)': lambda pr: (PROFILES[pr]['turns'] * WEEKS_PER_MONTH * chat('Haiku 4.5 (no think)', 'medium') + PROFILES[pr]['plans'] * WEEKS_PER_MONTH * cost('Opus 5', 'B', 'medium', 'cold_user') + PROFILES[pr]['regens'] * WEEKS_PER_MONTH * cost('Sonnet 5', 'C', 'low', 'cold_user')),
    'S6 Opus5 all low': lambda pr: monthly('Opus 5', pr, 'low'),
    'S7 Opus5 chat low, plans medium, regens low': lambda pr: (PROFILES[pr]['turns'] * WEEKS_PER_MONTH * chat('Opus 5', 'low') + PROFILES[pr]['plans'] * WEEKS_PER_MONTH * cost('Opus 5', 'B', 'medium') + PROFILES[pr]['regens'] * WEEKS_PER_MONTH * cost('Opus 5', 'C', 'low')),
}
MIX = {'Light': 0.6, 'Medium': 0.3, 'Heavy': 0.1}
net2999 = REV['29.99 zł/mo']; net4999 = REV['49.99 zł/mo']; net1999 = REV['19.99 zł/mo']
print("| Scenario | Light | Medium | Heavy | Blended 60/30/10 | blended % of 19.99 | % of 29.99 | % of 49.99 |")
for name, f in SCEN.items():
    vals = {pr: f(pr) for pr in PROFILES}
    bl = sum(MIX[pr] * vals[pr] for pr in PROFILES)
    print(f"| {name} | {vals['Light']:.2f} | {vals['Medium']:.2f} | {vals['Heavy']:.2f} | {bl:.2f} | {100*bl/net1999:.0f}% | {100*bl/net2999:.0f}% | {100*bl/net4999:.0f}% |")

print("\n## Blended cost (60/30/10) per single-model config, medium & low")
for m in MODELS:
    for e in ['medium', 'low']:
        bl = sum(MIX[pr] * monthly(m, pr, e) for pr in PROFILES)
        print(f"{m} {e}: blended {bl:.2f} -> {100*bl/net1999:.0f}% / {100*bl/net2999:.0f}% / {100*bl/net4999:.0f}% of net at 19.99/29.99/49.99")

print("\n## Credit weights: cost ratios turn:plan:regen (warm 1h)")
for m in MODELS:
    for e in ['low', 'medium']:
        t, p, r = chat(m, e), cost(m, 'B', e), cost(m, 'C', e)
        print(f"{m} {e}: 1 : {p/t:.2f} : {r/t:.2f}")

print("\n## Shared-prefix hit probability (Poisson, 1 - exp(-lambda*TTL)) for N paying users at Medium usage (~91 requests/user/month, ~2.5 API calls each)")
for N in [10, 30, 100]:
    req_per_hour = N * 91 / (30 * 24)
    for ttl_h in [5/60, 1.0]:
        print(f"N={N}: lambda={req_per_hour:.2f}/h, TTL={ttl_h:.2f}h -> hit={1 - math.exp(-req_per_hour * ttl_h):.2f}")

print("\n## Hybrid TTL: prefix 1h + tail 5m: warm turn within 5 min == warm-5m column; resume after >5min but <1h == cold_user with 5m write price")
for m in MODELS:
    print(m, "A warm5m", fmt(chat(m, 'medium', 'warm', '5m')), "A cold_user 5m", fmt(chat(m, 'medium', 'cold_user', '5m')), "delta 1h-vs-5m write per turn", fmt(chat(m, 'medium', 'warm', '1h') - chat(m, 'medium', 'warm', '5m')), "miss penalty", fmt(chat(m, 'medium', 'cold_user', '5m') - chat(m, 'medium', 'warm', '5m')))

print("\n## Trial: per-payer cost as % of first-month net at 29.99 and of 1-year H&F LTV ($35.64)")
for m in MODELS:
    ct = 15 * chat(m, 'medium') + 2 * cost(m, 'B', 'medium') + 4 * cost(m, 'C', 'medium')
    pp = ct / 0.377
    print(f"{m}: per payer {pp:.2f} = {100*pp/net2999:.0f}% of first-month net (29.99) ; {100*pp/35.64:.0f}% of $35.64 LTV")
