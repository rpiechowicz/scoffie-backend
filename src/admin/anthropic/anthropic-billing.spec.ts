import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { anthropicBalanceAlerts } from '../alerts/alert-rules';
import { AdminAnthropicService } from './admin-anthropic.service';
import {
  AdminAnthropicAnchorDto,
  AdminAnthropicSettingsDto,
} from './admin-anthropic.dto';
import type {
  Bucket,
  CostResult,
  UsageResult,
} from './anthropic-billing.client';
import {
  billingRange,
  buildBilling,
  centsToUsd,
  costByDay,
  runwayDays,
  shareAfter,
  spentSince,
  type AnchorRow,
} from './anthropic-billing';

const NOW = new Date('2026-09-26T10:30:00Z');

const cost = (
  day: string,
  items: [model: string | null, cents: string, costType?: string][],
): Bucket<CostResult> => ({
  starting_at: `${day}T00:00:00Z`,
  ending_at: new Date(Date.parse(`${day}T00:00:00Z`) + 864e5).toISOString(),
  results: items.map(([model, amount, costType]) => ({
    amount,
    model,
    cost_type: costType ?? (model ? 'tokens' : null),
    description: null,
  })),
});

const usage = (
  input: number,
  output = 0,
  extra: Partial<UsageResult> = {},
): UsageResult => ({
  uncached_input_tokens: input,
  cache_read_input_tokens: 0,
  cache_creation: {
    ephemeral_5m_input_tokens: 0,
    ephemeral_1h_input_tokens: 0,
  },
  output_tokens: output,
  ...extra,
});

const hour = (iso: string, results: UsageResult[]): Bucket<UsageResult> => ({
  starting_at: iso,
  ending_at: new Date(Date.parse(iso) + 36e5).toISOString(),
  results,
});

const anchor = (at: string, balanceUsd: number): AnchorRow => ({
  id: '00000000-0000-4000-8000-000000000001',
  at: new Date(at),
  balanceUsd,
  amountUsd: 25,
  note: null,
  createdBy: 'admin@scoffie.app',
});

describe('kredyty Claude — arytmetyka', () => {
  it('centy jako tekst → USD, śmieci → 0', () => {
    expect(centsToUsd('123.45')).toBeCloseTo(1.2345);
    expect(centsToUsd('0')).toBe(0);
    expect(centsToUsd('abc')).toBe(0);
    expect(centsToUsd(undefined)).toBe(0);
  });

  it('sumuje dobę i rozdziela po modelu; koszt bez modelu pod rodzajem', () => {
    const days = costByDay([
      cost('2026-09-25', [
        ['claude-opus-5-5', '300'],
        ['claude-opus-5-5', '100'],
        [null, '50', 'web_search'],
      ]),
    ]);
    const day = days.get('2026-09-25')!;
    expect(day.usd).toBeCloseTo(4.5);
    expect(day.byModel.get('claude-opus-5-5')).toBeCloseTo(4);
    expect(day.byModel.get('web_search')).toBeCloseTo(0.5);
  });

  it('udział doby kotwicy: godziny po kotwicy, godzina przecięta proporcjonalnie', () => {
    const buckets = [
      hour('2026-09-24T08:00:00Z', [usage(1000)]),
      hour('2026-09-24T09:00:00Z', [usage(1000)]),
      hour('2026-09-24T10:00:00Z', [usage(2000)]),
    ];
    // kotwica 9:30 → pół godziny 9 (500) + cała 10 (2000) z 4000
    expect(shareAfter(buckets, new Date('2026-09-24T09:30:00Z'))).toBeCloseTo(
      2500 / 4000,
    );
  });

  it('wyjście waży 5× — udział liczy koszt, nie gołe tokeny', () => {
    const buckets = [
      hour('2026-09-24T08:00:00Z', [usage(1000)]),
      hour('2026-09-24T09:00:00Z', [usage(0, 200)]),
    ];
    expect(shareAfter(buckets, new Date('2026-09-24T09:00:00Z'))).toBeCloseTo(
      0.5,
    );
  });

  it('doba bez tokenów — udział czasu do końca doby', () => {
    expect(shareAfter([], new Date('2026-09-24T18:00:00Z'))).toBeCloseTo(0.25);
  });

  it('wydatki od kotwicy: pełne doby po niej + część doby kotwicy', () => {
    const days = costByDay([
      cost('2026-09-23', [['m', '999']]), // przed kotwicą — nie liczy się
      cost('2026-09-24', [['m', '400']]),
      cost('2026-09-25', [['m', '300']]),
      cost('2026-09-26', [['m', '100']]),
    ]);
    const anchorDay = [
      hour('2026-09-24T09:00:00Z', [usage(1000)]),
      hour('2026-09-24T12:00:00Z', [usage(3000)]),
    ];
    const spent = spentSince(days, new Date('2026-09-24T11:00:00Z'), anchorDay);
    // 3 + 1 + 4 × 3/4
    expect(spent).toBeCloseTo(7);
  });

  it('dni zapasu: saldo / średnia; bez salda albo wydatków — null', () => {
    expect(runwayDays(10, 4)).toBe(2.5);
    expect(runwayDays(-3, 4)).toBe(0);
    expect(runwayDays(null, 4)).toBeNull();
    expect(runwayDays(10, 0)).toBeNull();
  });

  it('zakres zapytań sięga po dobę kotwicy, ale nie dalej niż pół roku', () => {
    const r = billingRange(NOW, new Date('2026-06-01T12:00:00Z'));
    expect(r.costFrom.toISOString()).toBe('2026-06-01T00:00:00.000Z');
    expect(r.to.toISOString()).toBe('2026-09-27T00:00:00.000Z');
    expect(r.anchorDay?.toISOString()).toBe('2026-06-01T00:00:00.000Z');
    const old = billingRange(NOW, new Date('2025-01-01T00:00:00Z'));
    expect(old.costFrom.toISOString()).toBe('2026-03-24T00:00:00.000Z');
    expect(old.anchorDay).toBeNull();
    const none = billingRange(NOW, null);
    expect(none.costFrom.toISOString()).toBe('2026-08-01T00:00:00.000Z');
    expect(none.hourlyFrom.toISOString()).toBe('2026-09-25T11:00:00.000Z');
    expect(none.hourlyTo.toISOString()).toBe('2026-09-26T11:00:00.000Z');
  });

  it('składa ekran: wydatki, 31 dób, modele, saldo i zapas', () => {
    const raw = {
      cost: [
        cost('2026-08-31', [['claude-opus-5-5', '1000']]),
        ...Array.from({ length: 8 }, (_, i) =>
          cost(`2026-09-${String(18 + i).padStart(2, '0')}`, [
            ['claude-opus-5-5', '200'],
          ]),
        ),
        cost('2026-09-26', [
          ['claude-opus-5-5', '50'],
          ['claude-haiku-4-5', '10'],
        ]),
      ],
      usageDaily: [
        {
          starting_at: '2026-09-26T00:00:00Z',
          ending_at: '2026-09-27T00:00:00Z',
          results: [
            usage(100, 50, {
              model: 'claude-opus-5-5',
              cache_read_input_tokens: 300,
            }),
          ],
        },
      ],
      hourly: [hour('2026-09-26T10:00:00Z', [usage(10, 5)])],
      anchorDay: [],
    };
    const b = buildBilling({
      configured: true,
      error: null,
      raw,
      anchors: [anchor('2026-09-25T00:00:00Z', 20)],
      lowBalanceUsd: 5,
      now: NOW,
      fetchedAt: NOW,
    });
    expect(b.spend).toEqual({
      todayUsd: 0.6,
      yesterdayUsd: 2,
      last7Usd: 12.6,
      monthUsd: 16.6,
      prevMonthUsd: 10,
    });
    expect(b.daily).toHaveLength(31);
    expect(b.daily[30]).toEqual({
      date: '2026-09-26',
      usd: 0.6,
      byModel: { 'claude-opus-5-5': 0.5, 'claude-haiku-4-5': 0.1 },
    });
    expect(b.daily[0].date).toBe('2026-08-27');
    expect(b.byModel[0]).toMatchObject({
      model: 'claude-opus-5-5',
      usd: 16.5,
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 300,
    });
    // kotwica o północy 25.09: cała doba 25.09 (2) + dziś (0,6); doba
    // kotwicy bez tokenów → udział czasu = 1
    expect(b.balance).toEqual({
      anchorUsd: 20,
      anchorAt: '2026-09-25T00:00:00.000Z',
      spentSinceUsd: 2.6,
      estimatedUsd: 17.4,
    });
    expect(b.runwayDays).toBe(8.7); // 17,4 / 2 dziennie
    expect(b.tokens).toEqual({ last7: 450, cacheReadShare: 0.75 });
    expect(b.hourly).toEqual([
      {
        at: '2026-09-26T10:00:00.000Z',
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 0,
      },
    ]);
    expect(b.anchors[0].by).toBe('admin@scoffie.app');
  });

  it('błąd Anthropic albo brak danych — bez szacunku salda', () => {
    const b = buildBilling({
      configured: true,
      error: 'Anthropic: HTTP 401',
      raw: null,
      anchors: [anchor('2026-09-25T00:00:00Z', 20)],
      lowBalanceUsd: 5,
      now: NOW,
      fetchedAt: NOW,
    });
    expect(b.balance).toBeNull();
    expect(b.runwayDays).toBeNull();
    expect(b.anchors).toHaveLength(1);
    expect(b.error).toBe('Anthropic: HTTP 401');
  });
});

describe('kredyty Claude — walidacja', () => {
  const errors = (cls: new () => object, body: unknown) =>
    validateSync(plainToInstance(cls, body)).map((e) => e.property);

  it('kotwica: kwoty ≥ 0, do 2 miejsc, z sufitem; notatka ≤ 200', () => {
    expect(errors(AdminAnthropicAnchorDto, { balanceUsd: 25.58 })).toEqual([]);
    expect(
      errors(AdminAnthropicAnchorDto, {
        balanceUsd: 25.58,
        amountUsd: 25,
        note: 'doładowanie',
      }),
    ).toEqual([]);
    expect(errors(AdminAnthropicAnchorDto, { balanceUsd: -1 })).toEqual([
      'balanceUsd',
    ]);
    expect(errors(AdminAnthropicAnchorDto, { balanceUsd: 1.234 })).toEqual([
      'balanceUsd',
    ]);
    expect(errors(AdminAnthropicAnchorDto, { balanceUsd: 1e6 })).toEqual([
      'balanceUsd',
    ]);
    expect(errors(AdminAnthropicAnchorDto, { balanceUsd: '25' })).toEqual([
      'balanceUsd',
    ]);
    expect(
      errors(AdminAnthropicAnchorDto, { balanceUsd: 1, note: 'x'.repeat(201) }),
    ).toEqual(['note']);
  });

  it('próg salda', () => {
    expect(errors(AdminAnthropicSettingsDto, { lowBalanceUsd: 5 })).toEqual([]);
    expect(errors(AdminAnthropicSettingsDto, { lowBalanceUsd: -5 })).toEqual([
      'lowBalanceUsd',
    ]);
  });
});

describe('kredyty Claude — alert', () => {
  const balance = (estimatedUsd: number) => ({
    anchorUsd: 30,
    anchorAt: NOW.toISOString(),
    spentSinceUsd: 30 - estimatedUsd,
    estimatedUsd,
  });

  it('poniżej progu — ostrzeżenie; bez kotwicy milczy', () => {
    expect(
      anthropicBalanceAlerts({
        balance: balance(3),
        lowBalanceUsd: 5,
        runwayDays: 10,
      }),
    ).toEqual([
      expect.objectContaining({
        key: 'anthropic-balance-low',
        severity: 'warning',
        title: 'Kończą się kredyty Claude',
      }),
    ]);
    expect(
      anthropicBalanceAlerts({
        balance: null,
        lowBalanceUsd: 5,
        runwayDays: null,
      }),
    ).toEqual([]);
  });

  it('powyżej progu, ale zapas < 3 dni — alert; zapas < 1 dzień — krytyczny', () => {
    const [short] = anthropicBalanceAlerts({
      balance: balance(20),
      lowBalanceUsd: 5,
      runwayDays: 2.5,
    });
    expect(short.severity).toBe('warning');
    expect(short.detail).toContain('2,5 dnia');
    expect(
      anthropicBalanceAlerts({
        balance: balance(20),
        lowBalanceUsd: 5,
        runwayDays: 0.5,
      })[0].severity,
    ).toBe('critical');
  });

  it('saldo wyczerpane — krytyczny; zdrowe saldo — nic', () => {
    expect(
      anthropicBalanceAlerts({
        balance: balance(-1),
        lowBalanceUsd: 5,
        runwayDays: 0,
      })[0],
    ).toMatchObject({
      severity: 'critical',
      title: 'Kredyty Claude się skończyły',
    });
    expect(
      anthropicBalanceAlerts({
        balance: balance(50),
        lowBalanceUsd: 5,
        runwayDays: 25,
      }),
    ).toEqual([]);
  });
});

describe('AdminAnthropicService', () => {
  const prisma = {
    anthropicCreditAnchor: {
      findMany: jest.fn().mockResolvedValue([]),
    },
    anthropicBillingSetting: {
      findUnique: jest.fn().mockResolvedValue(null),
    },
  };
  const saved = process.env.ANTHROPIC_ADMIN_KEY;
  afterEach(() => {
    if (saved === undefined) delete process.env.ANTHROPIC_ADMIN_KEY;
    else process.env.ANTHROPIC_ADMIN_KEY = saved;
  });

  it('bez klucza — configured:false, bez pytania Anthropic', async () => {
    delete process.env.ANTHROPIC_ADMIN_KEY;
    const fetchImpl = jest.fn();
    const service = new AdminAnthropicService(prisma as never, {} as never);
    const b = await service.billing(NOW, fetchImpl as never);
    expect(b.configured).toBe(false);
    expect(b.lowBalanceUsd).toBe(5);
    expect(b.balance).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('z kluczem — pyta raporty z nagłówkami i pamięta wynik', async () => {
    process.env.ANTHROPIC_ADMIN_KEY = 'sk-ant-admin01-test';
    const fetchImpl = jest
      .fn()
      .mockImplementation(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({ data: [], has_more: false, next_page: null }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
        ),
      );
    const service = new AdminAnthropicService(prisma as never, {} as never);
    const b = await service.billing(NOW, fetchImpl as never);
    expect(b).toMatchObject({ configured: true, error: null });
    // koszty, tokeny dobowe, tokeny godzinowe (bez kotwicy — bez czwartego)
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/v1/organizations/cost_report?');
    expect(url).toContain('group_by%5B%5D=description');
    expect(init.headers).toMatchObject({
      'x-api-key': 'sk-ant-admin01-test',
      'anthropic-version': '2023-06-01',
    });
    await service.billing(NOW, fetchImpl as never);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('401 z Anthropic — błąd w odpowiedzi, nie wyjątek', async () => {
    process.env.ANTHROPIC_ADMIN_KEY = 'sk-ant-admin01-zly';
    const fetchImpl = jest
      .fn()
      .mockImplementation(() =>
        Promise.resolve(new Response('{"error":"nope"}', { status: 401 })),
      );
    const service = new AdminAnthropicService(prisma as never, {} as never);
    const b = await service.billing(NOW, fetchImpl as never);
    expect(b.error).toContain('HTTP 401');
    expect(b.daily).toHaveLength(31);
  });
});
