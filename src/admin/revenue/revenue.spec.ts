import { generateKeyPairSync } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { REFERENCE_USD_PLN } from '../../config/ai-unit-economics';
import { appleReportAlerts } from '../alerts/alert-rules';
import { buildReportPayload } from '../alerts/daily-report';
import {
  financeMonths,
  isInAppPurchase,
  lastDayOfMonth,
  parseFinanceReport,
  parseSalesSummary,
  reportNumber,
  salesReportDates,
} from './apple-reports';
import {
  ASC_REPORTS_FORBIDDEN,
  appleReportUrl,
  decodeReport,
  fetchAppleReport,
} from './apple-reports.client';
import { due } from './apple-reports-sync.service';
import { revenueState } from './admin-revenue.service';
import {
  FX_BACKFILL_DAYS,
  FxBook,
  fxFetchWindows,
  parseNbpTables,
} from './fx-rates';
import { buildRevenue, revenueDays } from './revenue';

/** Nagłówek Sales Summary 1_0 — kolejność i nazwy jak w raporcie Apple. */
const SALES_HEADER = [
  'Provider',
  'Provider Country',
  'SKU',
  'Developer',
  'Title',
  'Version',
  'Product Type Identifier',
  'Units',
  'Developer Proceeds',
  'Begin Date',
  'End Date',
  'Customer Currency',
  'Country Code',
  'Currency of Proceeds',
  'Apple Identifier',
  'Customer Price',
  'Promo Code',
  'Parent Identifier',
  'Subscription',
  'Period',
  'Category',
  'CMB',
  'Device',
  'Supported Platforms',
  'Proceeds Reason',
  'Preserved Pricing',
  'Client',
  'Order Type',
].join('\t');

const sale = (fields: {
  sku: string;
  type: string;
  units: string;
  proceeds: string;
  customerCurrency: string;
  country: string;
  proceedsCurrency: string;
  price: string;
  title?: string;
  reason?: string;
}) =>
  [
    'APPLE',
    'US',
    fields.sku,
    'Rafal Piechowicz',
    fields.title ?? 'Scoffie Pro',
    '',
    fields.type,
    fields.units,
    fields.proceeds,
    '09/23/2026',
    '09/23/2026',
    fields.customerCurrency,
    fields.country,
    fields.proceedsCurrency,
    '6740000001',
    fields.price,
    '',
    'app.scoffie.ios',
    'Renewal',
    '1 Month',
    'Food & Drink',
    '',
    'iPhone',
    'iOS',
    fields.reason ?? '',
    '',
    '',
    '',
  ].join('\t');

const SALES_TSV = [
  SALES_HEADER,
  // pobranie aplikacji — bez pieniędzy, poza raportem przychodu
  sale({
    sku: 'app.scoffie.ios',
    type: '1F',
    units: '12',
    proceeds: '0',
    customerCurrency: 'PLN',
    country: 'PL',
    proceedsCurrency: 'PLN',
    price: '0',
    title: 'Scoffie',
  }),
  sale({
    sku: 'scoffie.pro.monthly',
    type: 'IAY',
    units: '3',
    proceeds: '19.35',
    customerCurrency: 'PLN',
    country: 'PL',
    proceedsCurrency: 'PLN',
    price: '27.99',
  }),
  // ten sam klucz, inny powód prowizji (po roku 15 %) — sumuje się
  sale({
    sku: 'scoffie.pro.monthly',
    type: 'IAY',
    units: '1',
    proceeds: '19.35',
    customerCurrency: 'PLN',
    country: 'PL',
    proceedsCurrency: 'PLN',
    price: '27.99',
    reason: 'Rate After One Year',
  }),
  // zwrot
  sale({
    sku: 'scoffie.pro.monthly',
    type: 'IAY',
    units: '-1',
    proceeds: '19.35',
    customerCurrency: 'PLN',
    country: 'PL',
    proceedsCurrency: 'PLN',
    price: '27.99',
  }),
  sale({
    sku: 'scoffie.pro.yearly',
    type: 'IAY',
    units: '2',
    proceeds: '41.99',
    customerCurrency: 'EUR',
    country: 'DE',
    proceedsCurrency: 'EUR',
    price: '59.99',
  }),
  '',
].join('\n');

describe('parseSalesSummary', () => {
  it('bierze tylko zakupy w aplikacji, sumuje wiersze klucza i mnoży kwoty przez sztuki', () => {
    const rows = parseSalesSummary(SALES_TSV);
    expect(rows).toHaveLength(2);
    const pl = rows.find((r) => r.country === 'PL');
    expect(pl).toMatchObject({
      sku: 'scoffie.pro.monthly',
      productType: 'IAY',
      units: 3, // 3 + 1 − 1
      proceeds: 58.05, // 3 × 19.35
      proceedsCurrency: 'PLN',
      customerPrice: 83.97,
      customerCurrency: 'PLN',
    });
    const de = rows.find((r) => r.country === 'DE');
    expect(de).toMatchObject({
      units: 2,
      proceeds: 83.98,
      proceedsCurrency: 'EUR',
    });
  });

  it('pusty plik i sam nagłówek to zero wierszy; brak kolumny — czytelny błąd', () => {
    expect(parseSalesSummary('')).toEqual([]);
    expect(parseSalesSummary(`${SALES_HEADER}\n`)).toEqual([]);
    expect(() => parseSalesSummary('SKU\tUnits\nx\t1\n')).toThrow(
      /nieznany format raportu Sales Summary/,
    );
  });

  it('rodzaje produktu i liczby Apple', () => {
    expect(isInAppPurchase('IAY')).toBe(true);
    expect(isInAppPurchase('IAY-M')).toBe(true);
    expect(isInAppPurchase('FI1')).toBe(true);
    expect(isInAppPurchase('1F')).toBe(false);
    expect(isInAppPurchase('7')).toBe(false);
    expect(reportNumber('1,234.50')).toBe(1234.5);
    expect(reportNumber('')).toBe(0);
    expect(reportNumber('abc')).toBe(0);
  });
});

describe('parseFinanceReport', () => {
  const header = [
    'Start Date',
    'End Date',
    'UPC',
    'ISRC/ISBN',
    'Vendor Identifier',
    'Quantity',
    'Partner Share',
    'Extended Partner Share',
    'Partner Share Currency',
    'Sales or Return',
    'Apple Identifier',
    'Artist/Show/Developer/Author',
    'Title',
    'Label/Studio/Network/Developer/Publisher',
    'Grid',
    'Product Type Identifier',
    'ISAN/Other Identifier',
    'Country Of Sale',
    'Pre-order Flag',
    'Promo Code',
    'Customer Price',
    'Customer Currency',
  ].join('\t');
  const row = (qty: string, share: string, ext: string, cur: string) =>
    [
      '08/31/2026',
      '09/27/2026',
      '',
      '',
      'scoffie.pro.monthly',
      qty,
      share,
      ext,
      cur,
      Number(qty) < 0 ? 'R' : 'S',
      '6740000001',
      'Rafal Piechowicz',
      'Scoffie Pro',
      '',
      '',
      'IAY',
      '',
      'PL',
      '',
      '',
      '27.99',
      'PLN',
    ].join('\t');

  it('sumuje po walucie, pomija wiersze podsumowań i powtórzony nagłówek', () => {
    const tsv = [
      header,
      row('10', '19.35', '193.50', 'PLN'),
      row('-1', '19.35', '-19.35', 'PLN'),
      row('2', '4.99', '9.98', 'EUR'),
      '',
      'Total_Rows\t3',
      'Total_Amount\t184.13',
      header,
      row('1', '3.00', '3.00', 'USD'),
    ].join('\n');
    expect(parseFinanceReport(tsv)).toEqual([
      { currency: 'EUR', units: 2, proceeds: 9.98 },
      { currency: 'PLN', units: 9, proceeds: 174.15 },
      { currency: 'USD', units: 1, proceeds: 3 },
    ]);
  });
});

describe('okresy raportów', () => {
  it('dni od wczoraj wstecz, miesiące od poprzedniego', () => {
    expect(salesReportDates('2026-03-02', 3)).toEqual([
      '2026-03-01',
      '2026-02-28',
      '2026-02-27',
    ]);
    expect(financeMonths('2026-01-15', 3)).toEqual([
      '2025-12',
      '2025-11',
      '2025-10',
    ]);
    expect(lastDayOfMonth('2026-02')).toBe('2026-02-28');
    expect(lastDayOfMonth('2025-12')).toBe('2025-12-31');
    expect(revenueDays('2026-09-25', '30')).toHaveLength(30);
    expect(revenueDays('2026-09-25', '30').at(-1)).toBe('2026-09-24');
  });
});

describe('NBP', () => {
  it('parsuje tabelę A i odrzuca śmieci', () => {
    const rows = parseNbpTables([
      {
        table: 'A',
        no: '186/A/NBP/2026',
        effectiveDate: '2026-09-24',
        rates: [
          { currency: 'dolar amerykański', code: 'USD', mid: 3.6512 },
          { currency: 'euro', code: 'EUR', mid: 4.2711 },
          { code: 'XX', mid: 1 },
          { code: 'GBP', mid: 0 },
        ],
      },
      { effectiveDate: 'wczoraj', rates: [{ code: 'USD', mid: 3 }] },
    ]);
    expect(rows).toEqual([
      {
        date: '2026-09-24',
        pair: 'USD/PLN',
        rate: 3.6512,
        source: '186/A/NBP/2026',
      },
      {
        date: '2026-09-24',
        pair: 'EUR/PLN',
        rate: 4.2711,
        source: '186/A/NBP/2026',
      },
    ]);
    expect(parseNbpTables({ status: 404 })).toEqual([]);
  });

  it('okna pobrania: pusta tabela — rok w kawałkach ≤ 93 dni; potem od dnia po ostatnim', () => {
    const backfill = fxFetchWindows(null, '2026-09-25');
    expect(backfill[0].from).toBe('2025-09-20');
    expect(backfill.at(-1)?.to).toBe('2026-09-25');
    expect(backfill.length).toBe(Math.ceil((FX_BACKFILL_DAYS + 1) / 93));
    expect(fxFetchWindows('2026-09-23', '2026-09-25')).toEqual([
      { from: '2026-09-24', to: '2026-09-25' },
    ]);
    expect(fxFetchWindows('2026-09-25', '2026-09-25')).toEqual([]);
  });

  it('kurs na dzień: ostatnie notowanie ≤ dzień, bez notowania — stała cennika', () => {
    const book = new FxBook([
      { date: '2026-09-25', pair: 'USD/PLN', rate: 3.7 },
      { date: '2026-09-24', pair: 'USD/PLN', rate: 3.6 },
      { date: '2026-09-24', pair: 'EUR/PLN', rate: 4.3 },
    ]);
    // sobota → piątek
    expect(book.usdPln('2026-09-26')).toEqual({
      rate: 3.7,
      date: '2026-09-25',
      source: 'NBP',
    });
    expect(book.usdPln('2026-09-24').rate).toBe(3.6);
    expect(book.usdPln('2026-09-01')).toEqual({
      rate: REFERENCE_USD_PLN,
      date: null,
      source: 'REFERENCE',
    });
    expect(book.toPln('PLN', '2020-01-01')).toBe(1);
    expect(book.toPln('EUR', '2026-09-30')).toBe(4.3);
    expect(book.toPln('SAR', '2026-09-30')).toBeNull();
  });
});

describe('buildRevenue', () => {
  const book = new FxBook([
    { date: '2026-09-21', pair: 'USD/PLN', rate: 4 },
    { date: '2026-09-21', pair: 'EUR/PLN', rate: 4.25 },
    { date: '2026-08-29', pair: 'EUR/PLN', rate: 4.2 },
    { date: '2026-08-29', pair: 'USD/PLN', rate: 3.9 },
  ]);
  const base = {
    title: 'Scoffie Pro',
    productType: 'IAY',
    customerPrice: 0,
    customerCurrency: 'PLN',
  };

  it('przelicza waluty po kursie z dnia, liczy zwroty i zostawia waluty bez kursu', () => {
    const data = buildRevenue({
      period: '30',
      today: '2026-09-25',
      sales: [
        {
          ...base,
          date: '2026-09-22',
          sku: 'm',
          country: 'PL',
          units: 3,
          proceeds: 60,
          proceedsCurrency: 'PLN',
          customerPrice: 84,
          customerCurrency: 'PLN',
        },
        {
          ...base,
          date: '2026-09-22',
          sku: 'y',
          country: 'DE',
          units: 2,
          proceeds: 10,
          proceedsCurrency: 'EUR',
        },
        {
          ...base,
          date: '2026-09-23',
          sku: 'm',
          country: 'PL',
          units: -1,
          proceeds: -20,
          proceedsCurrency: 'PLN',
        },
        {
          ...base,
          date: '2026-09-23',
          sku: 'm',
          country: 'SA',
          units: 1,
          proceeds: 5,
          proceedsCurrency: 'SAR',
        },
        // spoza okresu (dziś — raport niepełny)
        {
          ...base,
          date: '2026-09-25',
          sku: 'm',
          country: 'PL',
          units: 9,
          proceeds: 900,
          proceedsCurrency: 'PLN',
        },
      ],
      finance: [
        { month: '2026-07', currency: 'PLN', units: 1, proceeds: 10 },
        { month: '2026-08', currency: 'EUR', units: 2, proceeds: 10 },
        { month: '2026-08', currency: 'TWD', units: 1, proceeds: 30 },
      ],
      book,
      mrrPln: 123,
    });

    expect(data.days).toHaveLength(30);
    const d22 = data.days.find((d) => d.date === '2026-09-22');
    expect(d22).toEqual({
      date: '2026-09-22',
      units: 5,
      proceedsPln: 102.5,
      proceedsUsd: 25.63,
    });
    expect(data.totals).toMatchObject({
      units: 5, // 3 + 2 − 1 + 1
      refunds: 1,
      proceedsPln: 82.5, // 60 + 42.5 − 20 (+ SAR bez kursu)
      avgPerDayPln: 2.75,
      customerPricePln: 84,
    });
    expect(data.unconverted).toEqual(['SAR']);
    expect(
      data.byProduct.map((p) => [p.sku, p.units, p.refunds, p.proceedsPln]),
    ).toEqual([
      ['y', 2, 0, 42.5],
      ['m', 3, 1, 40],
    ]);
    expect(data.byCountry[0]).toEqual({
      country: 'DE',
      units: 2,
      proceedsPln: 42.5,
    });
    expect(data.finance).toEqual([
      {
        month: '2026-08',
        currency: 'EUR',
        units: 2,
        proceeds: 10,
        proceedsPln: 42,
      },
      {
        month: '2026-08',
        currency: 'TWD',
        units: 1,
        proceeds: 30,
        proceedsPln: null,
      },
      {
        month: '2026-07',
        currency: 'PLN',
        units: 1,
        proceeds: 10,
        proceedsPln: 10,
      },
    ]);
    expect(data.estimatedMrrPln).toBe(123);
    expect(data.estimatedNetMrrPln).toBe(85); // 123 / 1.23 × 0.85
  });

  it('przed premierą: zera na każdy dzień, bez wywrotki', () => {
    const data = buildRevenue({
      period: '90',
      today: '2026-09-25',
      sales: [],
      finance: [],
      book: new FxBook([]),
      mrrPln: 0,
    });
    expect(data.days).toHaveLength(90);
    expect(data.days.every((d) => d.units === 0 && d.proceedsPln === 0)).toBe(
      true,
    );
    expect(data.totals.avgPerDayPln).toBe(0);
    expect(data.byProduct).toEqual([]);
    expect(data.finance).toEqual([]);
  });
});

describe('klient raportów Apple', () => {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const env = {
    keyId: 'KEY123',
    issuerId: 'issuer',
    privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    bundleId: 'app.scoffie.ios',
  };
  const respond = (status: number, body: BodyInit | null = null) =>
    jest.fn(() =>
      Promise.resolve(new Response(body, { status })),
    ) as unknown as typeof fetch;

  it('adres raportu sprzedaży i finansowego', () => {
    const sales = new URL(
      appleReportUrl('8888', { kind: 'sales', date: '2026-09-24' }),
    );
    expect(sales.pathname).toBe('/v1/salesReports');
    expect(sales.searchParams.get('filter[reportType]')).toBe('SALES');
    expect(sales.searchParams.get('filter[reportSubType]')).toBe('SUMMARY');
    expect(sales.searchParams.get('filter[frequency]')).toBe('DAILY');
    expect(sales.searchParams.get('filter[vendorNumber]')).toBe('8888');
    expect(sales.searchParams.get('filter[reportDate]')).toBe('2026-09-24');
    const finance = new URL(
      appleReportUrl('8888', { kind: 'finance', month: '2026-08' }),
    );
    expect(finance.pathname).toBe('/v1/financeReports');
    expect(finance.searchParams.get('filter[regionCode]')).toBe('ZZ');
    expect(finance.searchParams.get('filter[reportType]')).toBe('FINANCIAL');
  });

  it('gzip → tekst; 404 = brak sprzedaży (null), nie błąd', async () => {
    const gz = gzipSync(Buffer.from(SALES_TSV));
    const fetchImpl = respond(200, new Uint8Array(gz));
    const text = await fetchAppleReport(
      env,
      '8888',
      { kind: 'sales', date: '2026-09-24' },
      fetchImpl,
    );
    expect(parseSalesSummary(text ?? '')).toHaveLength(2);
    const [, init] = (fetchImpl as unknown as jest.Mock).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect((init.headers as Record<string, string>).authorization).toMatch(
      /^Bearer ey/,
    );

    await expect(
      fetchAppleReport(
        env,
        '8888',
        { kind: 'sales', date: '2026-09-24' },
        respond(404, '{"errors":[]}'),
      ),
    ).resolves.toBeNull();
    expect(decodeReport(Buffer.from('SKU\n'))).toBe('SKU\n');
  });

  it('401/403 — komunikat o roli Finance/Sales; inne błędy z kodem', async () => {
    await expect(
      fetchAppleReport(
        env,
        '8888',
        { kind: 'sales', date: '2026-09-24' },
        respond(403),
      ),
    ).rejects.toThrow(ASC_REPORTS_FORBIDDEN);
    await expect(
      fetchAppleReport(
        env,
        '8888',
        { kind: 'finance', month: '2026-08' },
        respond(401),
      ),
    ).rejects.toThrow(/HTTP 401.*nadaj rolę Finance albo Sales/);
    await expect(
      fetchAppleReport(
        env,
        '8888',
        { kind: 'sales', date: '2026-09-24' },
        respond(
          400,
          JSON.stringify({ errors: [{ detail: 'Invalid vendor number' }] }),
        ),
      ),
    ).rejects.toThrow('App Store Connect: HTTP 400 · Invalid vendor number');
  });
});

describe('stan synchronizacji', () => {
  const now = new Date('2026-09-25T10:00:00Z');
  const hours = (h: number) => new Date(now.getTime() - h * 3_600_000);
  const configured = {
    ADMIN_ASC_KEY_ID: 'KEY',
    ADMIN_ASC_PRIVATE_KEY: 'MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQg',
    APPLE_ISSUER_ID: 'issuer',
    ADMIN_ASC_VENDOR_NUMBER: '8888',
  } as NodeJS.ProcessEnv;

  it('kiedy przebieg: nigdy, po dobie od sukcesu, po godzinie od błędu', () => {
    expect(due(null, now)).toBe(true);
    expect(
      due({ lastRunAt: hours(2), lastOkAt: hours(2), lastError: null }, now),
    ).toBe(false);
    expect(
      due({ lastRunAt: hours(21), lastOkAt: hours(21), lastError: null }, now),
    ).toBe(true);
    expect(
      due({ lastRunAt: hours(0.5), lastOkAt: null, lastError: 'x' }, now),
    ).toBe(false);
    expect(
      due({ lastRunAt: hours(1.5), lastOkAt: null, lastError: 'x' }, now),
    ).toBe(true);
  });

  it('off bez vendora, error z ostatniego błędu, ok z chwilami synchronizacji', () => {
    const { ADMIN_ASC_VENDOR_NUMBER: _vendor, ...noVendor } = configured;
    expect(revenueState([], null, noVendor)).toEqual({
      status: 'off',
      missing: ['ADMIN_ASC_VENDOR_NUMBER'],
    });
    expect(
      revenueState(
        [
          {
            kind: 'sales',
            lastRunAt: hours(1),
            lastOkAt: null,
            lastError: 'HTTP 403 — rola',
          },
          {
            kind: 'finance',
            lastRunAt: hours(1),
            lastOkAt: hours(1),
            lastError: null,
          },
        ],
        null,
        configured,
      ),
    ).toEqual({
      status: 'error',
      message: 'HTTP 403 — rola',
      fetchedAt: hours(1).toISOString(),
    });
    expect(
      revenueState(
        [
          {
            kind: 'sales',
            lastRunAt: hours(2),
            lastOkAt: hours(2),
            lastError: null,
          },
        ],
        '2026-09-23',
        configured,
      ),
    ).toEqual({
      status: 'ok',
      data: {
        salesSyncedAt: hours(2).toISOString(),
        financeSyncedAt: null,
        lastSaleDate: '2026-09-23',
      },
      fetchedAt: hours(2).toISOString(),
    });
  });

  it('alert: błąd synchronizacji otwiera ostrzeżenie per rodzaj raportu', () => {
    expect(
      appleReportAlerts([
        { kind: 'sales', lastError: 'HTTP 403' },
        { kind: 'finance', lastError: null },
      ]),
    ).toEqual([
      expect.objectContaining({
        key: 'apple-reports:sales',
        kind: 'apple-reports',
        severity: 'warning',
        detail: 'HTTP 403',
      }),
    ]);
  });
});

describe('raport dzienny — kurs', () => {
  it('koszt AI w złotych po kursie NBP, bez kursu — stała cennika', () => {
    const now = new Date('2026-09-25T08:00:00Z');
    const days = [
      {
        key: '2026-09-23',
        start: new Date('2026-09-22T22:00:00Z'),
        end: new Date('2026-09-23T22:00:00Z'),
      },
      {
        key: '2026-09-24',
        start: new Date('2026-09-23T22:00:00Z'),
        end: new Date('2026-09-24T22:00:00Z'),
      },
    ];
    const stat = { aiCostUsd: 10 } as never;
    const input = {
      days,
      now,
      panelUrl: 'https://admin.scoffie.app',
      stats: [stat, stat],
      subscriptions: [],
      counts: [
        { assistantUsers: 0, mailsSent: 0, mailsFailed: 0, reports: 0 },
        { assistantUsers: 0, mailsSent: 0, mailsFailed: 0, reports: 0 },
      ],
      openAlerts: 0,
      sentryNew24h: null,
      backup: null,
    };
    const pln = (usdPln?: number) =>
      buildReportPayload({ ...input, usdPln })
        .sections.flatMap((s) => s.metrics)
        .find((m) => m.label === 'Koszt AI w złotych')?.value;
    expect(pln(4)).toBe(40);
    expect(pln(undefined)).toBe(Math.round(10 * REFERENCE_USD_PLN * 100) / 100);
  });
});
