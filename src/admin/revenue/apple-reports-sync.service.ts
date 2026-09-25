import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { IntegrationError } from '../integrations/integration-fetch';
import {
  missingAscReports,
  readAscReportsEnv,
  readAscVendorNumber,
  type AscEnv,
} from '../integrations/integrations-env';
import {
  FINANCE_BACKFILL_MONTHS,
  FINANCE_REFRESH_MONTHS,
  SALES_BACKFILL_DAYS,
  SALES_REFRESH_DAYS,
  financeMonths,
  parseFinanceReport,
  parseSalesSummary,
  salesReportDates,
} from './apple-reports';
import { fetchAppleReport } from './apple-reports.client';
import { dateOfKey, keyOfDate } from './fx-rates';

export type AppleReportKind = 'sales' | 'finance';

/** Pętla co 3 h; pełny przebieg najwyżej raz na ~20 h (raporty są dzienne). */
const TICK_MS = 3 * 60 * 60_000;
const FIRST_TICK_MS = 60_000;
const FRESH_MS = 20 * 60 * 60_000;
/** Po błędzie (np. klucz bez roli) — nie pukamy do Apple częściej niż co godzinę. */
const RETRY_AFTER_ERROR_MS = 60 * 60_000;

/**
 * Raporty App Store Connect do bazy (ROADMAPA §5.6): sprzedaż dzień po dniu
 * (`AppleSalesDay`) i miesięczne rozliczenia (`AppleFinanceMonth`). Panel
 * czyta tylko bazę — Apple nie dostaje zapytania przy każdym wejściu na ekran.
 *
 * Pierwszy przebieg dociąga rok sprzedaży i 12 miesięcy rozliczeń, potem raz
 * na dobę ostatnie 30 dni i 3 miesiące (Apple poprawia raporty wstecz).
 * Dzień zapisujemy „zastąp w całości” w transakcji — powtórka niczego nie
 * dubluje. Stan (ostatni sukces, ostatni błąd) leży w `AppleReportSync`.
 */
@Injectable()
export class AppleReportsSyncService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(AppleReportsSyncService.name);
  private timers: NodeJS.Timeout[] = [];
  private running = false;

  constructor(private readonly prisma: PrismaService) {}

  onApplicationBootstrap(): void {
    if (process.env.NODE_ENV === 'test') return;
    const first = setTimeout(() => void this.tick(), FIRST_TICK_MS);
    const loop = setInterval(() => void this.tick(), TICK_MS);
    first.unref();
    loop.unref();
    this.timers = [first, loop];
  }

  onModuleDestroy(): void {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers = [];
  }

  /** Jeden przebieg pętli. Nigdy nie rzuca. */
  async tick(
    now: Date = new Date(),
    fetchImpl: typeof fetch = globalThis.fetch,
    force = false,
  ): Promise<void> {
    if (this.running) return;
    const env = readAscReportsEnv();
    const vendor = readAscVendorNumber();
    if (missingAscReports(env, vendor).length > 0) return;
    this.running = true;
    try {
      for (const kind of ['sales', 'finance'] as const) {
        const state = await this.prisma.appleReportSync.findUnique({
          where: { kind },
        });
        if (!force && !due(state, now)) continue;
        await this.run(kind, env, vendor, now, fetchImpl, !state?.lastOkAt);
      }
    } catch (error) {
      this.logger.error(
        `raporty Apple: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      this.running = false;
    }
  }

  private async run(
    kind: AppleReportKind,
    env: AscEnv,
    vendor: string,
    now: Date,
    fetchImpl: typeof fetch,
    backfill: boolean,
  ): Promise<void> {
    let error: string | null = null;
    try {
      if (kind === 'sales') {
        await this.syncSales(env, vendor, now, fetchImpl, backfill);
      } else {
        await this.syncFinance(env, vendor, now, fetchImpl, backfill);
      }
    } catch (caught) {
      error =
        caught instanceof IntegrationError
          ? caught.message
          : 'Nieoczekiwany błąd synchronizacji — szczegóły w logu backendu.';
      if (!(caught instanceof IntegrationError)) {
        this.logger.error(
          `raporty Apple (${kind}): ${caught instanceof Error ? caught.stack : String(caught)}`,
        );
      }
    }
    await this.prisma.appleReportSync.upsert({
      where: { kind },
      create: {
        kind,
        lastRunAt: now,
        lastOkAt: error ? null : now,
        lastError: error,
      },
      update: {
        lastRunAt: now,
        ...(error ? {} : { lastOkAt: now }),
        lastError: error,
      },
    });
  }

  private async syncSales(
    env: AscEnv,
    vendor: string,
    now: Date,
    fetchImpl: typeof fetch,
    backfill: boolean,
  ): Promise<void> {
    const dates = salesReportDates(
      keyOfDate(now),
      backfill ? SALES_BACKFILL_DAYS : SALES_REFRESH_DAYS,
    );
    // Po kolei: limit Apple to ~3600 zapytań na godzinę, a rok wstecz to
    // 365 zapytań raz w życiu. Pierwszy błąd (klucz bez roli) przerywa.
    for (const date of dates) {
      const tsv = await fetchAppleReport(
        env,
        vendor,
        { kind: 'sales', date },
        fetchImpl,
      );
      const rows = tsv ? parseSalesSummary(tsv) : [];
      const day = dateOfKey(date);
      await this.prisma.$transaction([
        this.prisma.appleSalesDay.deleteMany({ where: { date: day } }),
        this.prisma.appleSalesDay.createMany({
          data: rows.map((row) => ({ ...row, date: day })),
        }),
      ]);
    }
  }

  private async syncFinance(
    env: AscEnv,
    vendor: string,
    now: Date,
    fetchImpl: typeof fetch,
    backfill: boolean,
  ): Promise<void> {
    const months = financeMonths(
      keyOfDate(now),
      backfill ? FINANCE_BACKFILL_MONTHS : FINANCE_REFRESH_MONTHS,
    );
    for (const month of months) {
      const tsv = await fetchAppleReport(
        env,
        vendor,
        { kind: 'finance', month },
        fetchImpl,
      );
      const rows = tsv ? parseFinanceReport(tsv) : [];
      await this.prisma.$transaction([
        this.prisma.appleFinanceMonth.deleteMany({ where: { month } }),
        this.prisma.appleFinanceMonth.createMany({
          data: rows.map((row) => ({ ...row, month })),
        }),
      ]);
    }
  }
}

/** Czy pora na przebieg: nigdy nie było, sukces starszy niż ~doba, błąd starszy niż godzina. */
export function due(
  state: {
    lastRunAt: Date;
    lastOkAt: Date | null;
    lastError: string | null;
  } | null,
  now: Date,
): boolean {
  if (!state) return true;
  const since = (at: Date) => now.getTime() - at.getTime();
  if (state.lastError) return since(state.lastRunAt) >= RETRY_AFTER_ERROR_MS;
  return !state.lastOkAt || since(state.lastOkAt) >= FRESH_MS;
}
