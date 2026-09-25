import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import type {
  IntegrationState,
  RevenueData,
  RevenuePeriod,
  RevenueSync,
} from '../contract';
import {
  missingAscReports,
  readAscEnv,
  readAscVendorNumber,
} from '../integrations/integrations-env';
import { readOnlyQuery } from '../read-only-query';
import {
  METRIC_SUBSCRIPTION_SELECT,
  mrrAt,
  revenueSpans,
} from '../subscriptions/subscription-metrics';
import { FINANCE_BACKFILL_MONTHS, financeMonths } from './apple-reports';
import { FxRateService } from './fx-rate.service';
import { dateOfKey, keyOfDate } from './fx-rates';
import { buildRevenue, revenueDays } from './revenue';

/**
 * `GET /admin/revenue` — raporty Apple z BAZY (zapisuje je
 * `AppleReportsSyncService`), kurs NBP z `FxRate`, MRR z cennika tą samą
 * arytmetyką co ekran Subskrypcje. Apple nie dostaje tu żadnego zapytania.
 *
 * Przed premierą tabele są puste — odpowiedź ma wtedy zera na każdy dzień,
 * stan synchronizacji i MRR z cennika.
 */
@Injectable()
export class AdminRevenueService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly fx: FxRateService,
  ) {}

  async data(
    period: RevenuePeriod,
    now: Date = new Date(),
  ): Promise<RevenueData> {
    const today = keyOfDate(now);
    const days = revenueDays(today, period);
    const oldestMonth =
      financeMonths(today, FINANCE_BACKFILL_MONTHS).at(-1) ?? today.slice(0, 7);

    const { sales, finance, syncs, lastSale, mrrPln } = await readOnlyQuery(
      this.prisma,
      async (tx) => {
        const sales = await tx.appleSalesDay.findMany({
          where: {
            date: {
              gte: dateOfKey(days[0]),
              lte: dateOfKey(days[days.length - 1]),
            },
          },
          select: {
            date: true,
            sku: true,
            title: true,
            productType: true,
            country: true,
            units: true,
            proceeds: true,
            proceedsCurrency: true,
            customerPrice: true,
            customerCurrency: true,
          },
        });
        const finance = await tx.appleFinanceMonth.findMany({
          where: { month: { gte: oldestMonth } },
          select: { month: true, currency: true, units: true, proceeds: true },
        });
        const syncs = await tx.appleReportSync.findMany();
        const lastSale = await tx.appleSalesDay.findFirst({
          orderBy: { date: 'desc' },
          select: { date: true },
        });
        // Wiersze, które mogą płacić teraz — nadzbiór jak w
        // `AdminSubscriptionsService`, zawężony do chwili `now`.
        const rows = await tx.subscription.findMany({
          where: {
            provider: 'APPLE',
            OR: [
              { status: { in: ['ACTIVE', 'GRACE'] } },
              { expiresAt: { gte: now } },
              { graceExpiresAt: { gte: now } },
            ],
          },
          select: METRIC_SUBSCRIPTION_SELECT,
        });
        return {
          sales,
          finance,
          syncs,
          lastSale,
          mrrPln: mrrAt(revenueSpans(rows, now), now),
        };
      },
    );

    const currencies = new Set<string>(['USD', 'EUR']);
    for (const row of sales) {
      currencies.add(row.proceedsCurrency);
      currencies.add(row.customerCurrency);
    }
    for (const row of finance) currencies.add(row.currency);
    const monthStart = `${oldestMonth}-01`;
    const [book, fx] = await Promise.all([
      this.fx.book(
        monthStart < days[0] ? monthStart : days[0],
        today,
        [...currencies]
          .filter((currency) => currency !== 'PLN')
          .map((currency) => `${currency}/PLN`),
      ),
      this.fx.latest(now),
    ]);

    const built = buildRevenue({
      period,
      today,
      sales: sales.map((row) => ({
        ...row,
        date: keyOfDate(row.date),
        proceeds: row.proceeds.toNumber(),
        customerPrice: row.customerPrice.toNumber(),
      })),
      finance: finance.map((row) => ({
        ...row,
        proceeds: row.proceeds.toNumber(),
      })),
      book,
      mrrPln,
    });

    return {
      ...built,
      state: revenueState(syncs, lastSale ? keyOfDate(lastSale.date) : null),
      fx,
    };
  }
}

/**
 * `off` bez klucza/vendora; `error`, gdy ostatni przebieg sprzedaży albo
 * finansów padł (najczęściej klucz bez roli Finance/Sales); inaczej `ok`
 * z chwilami ostatnich udanych synchronizacji (`null` — jeszcze nie było).
 */
export function revenueState(
  syncs: readonly {
    kind: string;
    lastRunAt: Date;
    lastOkAt: Date | null;
    lastError: string | null;
  }[],
  lastSaleDate: string | null,
  env: NodeJS.ProcessEnv = process.env,
): IntegrationState<RevenueSync> {
  const missing = missingAscReports(readAscEnv(env), readAscVendorNumber(env));
  if (missing.length > 0) return { status: 'off', missing };
  const sales = syncs.find((s) => s.kind === 'sales');
  const finance = syncs.find((s) => s.kind === 'finance');
  const failed = [sales, finance].find((s) => s?.lastError);
  if (failed?.lastError) {
    return {
      status: 'error',
      message: failed.lastError,
      fetchedAt: failed.lastRunAt.toISOString(),
    };
  }
  const lastRun = Math.max(
    0,
    ...[sales, finance].map((s) => s?.lastRunAt.getTime() ?? 0),
  );
  return {
    status: 'ok',
    data: {
      salesSyncedAt: sales?.lastOkAt?.toISOString() ?? null,
      financeSyncedAt: finance?.lastOkAt?.toISOString() ?? null,
      lastSaleDate,
    },
    fetchedAt: new Date(lastRun || Date.now()).toISOString(),
  };
}
