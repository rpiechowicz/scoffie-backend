import { generateKeyPairSync } from 'crypto';
import { gzipSync } from 'zlib';
import { Test, TestingModule } from '@nestjs/testing';
import { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { PrismaService } from '../src/prisma/prisma.service';
import type { ProfitData, RevenueData } from '../src/admin/contract';
import { AppleReportsSyncService } from '../src/admin/revenue/apple-reports-sync.service';
import { FxRateService } from '../src/admin/revenue/fx-rate.service';
import { REFERENCE_USD_PLN } from '../src/config/ai-unit-economics';
import {
  cleanupAdmins,
  createAdminSession,
  useAdminDevGate,
  type AdminE2ESession,
} from './admin-e2e.helper';

/**
 * Wypłaty z Apple (`/admin/revenue`) na żywej bazie: synchronizacja
 * raportów i kursów NBP przez PRAWDZIWE serwisy, ale na podstawionym
 * `fetch` (sieć w e2e = test zależny od cudzego API), potem odczyt trasą.
 */
describe('Panel — przychód z Apple (/admin/revenue)', () => {
  let moduleRef: TestingModule;
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let restoreGate: () => void;
  let admin: AdminE2ESession;

  const originals = { ...process.env };
  const server = () => app.getHttpServer();
  const get = (path: string) =>
    request(server()).get(path).set('Cookie', admin.cookie);

  const now = new Date();
  const dayKey = (offset: number) =>
    new Date(now.getTime() + offset * 86_400_000).toISOString().slice(0, 10);
  const yesterday = dayKey(-1);
  const twoDaysAgo = dayKey(-2);

  const salesHeader = [
    'Provider',
    'SKU',
    'Title',
    'Product Type Identifier',
    'Units',
    'Developer Proceeds',
    'Customer Currency',
    'Country Code',
    'Currency of Proceeds',
    'Customer Price',
  ].join('\t');
  const salesTsv: Record<string, string> = {
    [yesterday]: [
      salesHeader,
      'APPLE\tscoffie.pro.monthly\tScoffie Pro\tIAY\t4\t19.35\tPLN\tPL\tPLN\t27.99',
      'APPLE\tscoffie.pro.yearly\tScoffie Pro roczny\tIAY\t1\t50.00\tUSD\tUS\tUSD\t69.99',
      'APPLE\tapp.scoffie.ios\tScoffie\t1F\t30\t0\tPLN\tPL\tPLN\t0',
    ].join('\n'),
    [twoDaysAgo]: [
      salesHeader,
      'APPLE\tscoffie.pro.monthly\tScoffie Pro\tIAY\t-1\t19.35\tPLN\tPL\tPLN\t27.99',
    ].join('\n'),
  };
  const financeMonth = (() => {
    const d = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1),
    );
    return d.toISOString().slice(0, 7);
  })();

  const financeHeader = [
    'Start Date',
    'Quantity',
    'Extended Partner Share',
    'Partner Share Currency',
  ].join('\t');

  /** Apple: sprzedaż za dwa dni, finanse za jeden miesiąc, reszta 404. */
  const appleFetch = (status = 200) =>
    ((input: string | URL) => {
      if (status !== 200) {
        return Promise.resolve(new Response(null, { status }));
      }
      const url = new URL(input.toString());
      const date = url.searchParams.get('filter[reportDate]') ?? '';
      let tsv: string | undefined;
      if (url.pathname.endsWith('/salesReports')) tsv = salesTsv[date];
      else if (date === financeMonth) {
        tsv = `${financeHeader}\n08/01/2026\t10\t193.50\tPLN\n08/01/2026\t2\t40.00\tUSD\nTotal_Rows\t2\n`;
      }
      return Promise.resolve(
        tsv
          ? new Response(new Uint8Array(gzipSync(Buffer.from(tsv))), {
              status: 200,
            })
          : new Response('{"errors":[{"status":"404"}]}', { status: 404 }),
      );
    }) as unknown as typeof fetch;

  /** NBP: USD 4.00 i EUR 4.25 z przedwczoraj (wczoraj bez notowania). */
  const nbpFetch = (() =>
    Promise.resolve(
      new Response(
        JSON.stringify([
          {
            table: 'A',
            no: '001/A/NBP/TEST',
            effectiveDate: twoDaysAgo,
            rates: [
              { code: 'USD', mid: 4 },
              { code: 'EUR', mid: 4.25 },
            ],
          },
        ]),
        { status: 200 },
      ),
    )) as unknown as typeof fetch;

  const cleanTables = async () => {
    await prisma.appleSalesDay.deleteMany({});
    await prisma.appleFinanceMonth.deleteMany({});
    await prisma.appleReportSync.deleteMany({});
    await prisma.fxRate.deleteMany({ where: { source: '001/A/NBP/TEST' } });
  };

  beforeAll(async () => {
    for (const key of [
      'ADMIN_ASC_KEY_ID',
      'ADMIN_ASC_PRIVATE_KEY',
      'ADMIN_ASC_VENDOR_NUMBER',
      'APPLE_ISSUER_ID',
      'ADMIN_ASC_ISSUER_ID',
    ]) {
      delete process.env[key];
    }
    restoreGate = useAdminDevGate();
    moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    configureApp(app);
    await app.init();
    prisma = moduleRef.get(PrismaService);
    admin = await createAdminSession(prisma);
    await cleanTables();
  });

  afterAll(async () => {
    await cleanTables();
    await cleanupAdmins(prisma);
    await app.close();
    restoreGate();
    process.env = originals;
  });

  it('bez sesji 404, zły okres 400', async () => {
    await request(server()).get('/admin/revenue').expect(404);
    await get('/admin/revenue?period=7').expect(400);
  });

  it('bez klucza i vendora: stan off, zera na każdy dzień, kurs z cennika', async () => {
    const body = (await get('/admin/revenue').expect(200)).body as RevenueData;
    expect(body.state).toEqual({
      status: 'off',
      missing: [
        'ADMIN_ASC_KEY_ID',
        'ADMIN_ASC_PRIVATE_KEY',
        'APPLE_ISSUER_ID',
        'ADMIN_ASC_VENDOR_NUMBER',
      ],
    });
    expect(body.period).toBe('30');
    expect(body.days).toHaveLength(30);
    expect(body.totals.proceedsPln).toBe(0);
    expect(body.fx).toMatchObject({
      source: 'REFERENCE',
      usdPln: REFERENCE_USD_PLN,
    });
  });

  it('synchronizacja na podstawionym fetch → trasa liczy PLN po kursie NBP', async () => {
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    process.env.ADMIN_ASC_KEY_ID = 'E2EKEY';
    process.env.ADMIN_ASC_PRIVATE_KEY = privateKey
      .export({ type: 'pkcs8', format: 'pem' })
      .toString();
    process.env.APPLE_ISSUER_ID = 'e2e-issuer';
    process.env.ADMIN_ASC_VENDOR_NUMBER = '88888888';

    expect(await moduleRef.get(FxRateService).sync(now, nbpFetch)).toBe(2);
    await moduleRef.get(AppleReportsSyncService).tick(now, appleFetch());

    const body = (await get('/admin/revenue?period=30').expect(200))
      .body as RevenueData;
    expect(body.state.status).toBe('ok');
    if (body.state.status === 'ok') {
      expect(body.state.data.lastSaleDate).toBe(yesterday);
      expect(body.state.data.salesSyncedAt).not.toBeNull();
      expect(body.state.data.financeSyncedAt).not.toBeNull();
    }
    expect(body.fx).toEqual({
      date: twoDaysAgo,
      usdPln: 4,
      eurPln: 4.25,
      source: 'NBP',
    });
    const y = body.days.find((d) => d.date === yesterday);
    // 4 × 19.35 PLN + 1 × 50 USD × 4.00 (kurs z przedwczoraj)
    expect(y).toEqual({
      date: yesterday,
      units: 5,
      proceedsPln: 277.4,
      proceedsUsd: 69.35,
    });
    expect(body.totals).toMatchObject({
      units: 4,
      refunds: 1,
      proceedsPln: 258.05,
    });
    expect(body.byProduct.map((p) => p.sku)).toEqual([
      'scoffie.pro.yearly',
      'scoffie.pro.monthly',
    ]);
    expect(body.byCountry.map((c) => c.country)).toEqual(['US', 'PL']);
    expect(body.finance).toEqual([
      {
        month: financeMonth,
        currency: 'PLN',
        units: 10,
        proceeds: 193.5,
        proceedsPln: 193.5,
      },
      {
        month: financeMonth,
        currency: 'USD',
        units: 2,
        proceeds: 40,
        // kurs z ostatniego dnia miesiąca — w teście tylko notowanie z tego
        // miesiąca, więc zwykle stała cennika
        proceedsPln: expect.any(Number),
      },
    ]);
    expect(body.unconverted).toEqual([]);

    // Rentowność asystenta czyta ten sam kurs NBP.
    const profit = (await get('/admin/assistant/profit').expect(200))
      .body as ProfitData;
    expect(profit.fxUsdPln).toBe(4);
    expect(profit.fxDate).toBe(twoDaysAgo);
  });

  it('ponowna synchronizacja nie dubluje; klucz bez roli → stan error z komunikatem', async () => {
    await moduleRef.get(AppleReportsSyncService).tick(now, appleFetch(), true);
    expect(await prisma.appleSalesDay.count()).toBe(3);

    await moduleRef
      .get(AppleReportsSyncService)
      .tick(now, appleFetch(403), true);
    const body = (await get('/admin/revenue?period=90').expect(200))
      .body as RevenueData;
    expect(body.state).toMatchObject({
      status: 'error',
      message: expect.stringContaining('nadaj rolę Finance albo Sales'),
    });
    // Dane z bazy zostają — błąd klucza niczego nie kasuje.
    expect(body.days).toHaveLength(90);
    expect(body.totals.units).toBe(4);
  });
});
