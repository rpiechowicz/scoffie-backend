import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { addDays, warsawDateKey } from '../common/warsaw-calendar';
import type { FxInfo } from '../contract';
import {
  EUR_PLN,
  FxBook,
  USD_PLN,
  dateOfKey,
  fxFetchWindows,
  keyOfDate,
  nbpTablesUrl,
  parseNbpTables,
  withReference,
  type RateOnDay,
} from './fx-rates';

/** NBP publikuje tabelę A ok. 12:00; co 4 h wystarczy, żeby złapać ją tego samego dnia. */
const TICK_MS = 4 * 60 * 60_000;
/** Pierwszy przebieg chwilę po starcie — nie w ścieżce rozruchu. */
const FIRST_TICK_MS = 20_000;
const REQUEST_TIMEOUT_MS = 15_000;
/** Ile dni przed okresem doczytać, żeby pierwszy dzień (np. poniedziałek po święcie) miał kurs. */
const LOOKBACK_DAYS = 10;

/**
 * Kursy NBP dla panelu (ROADMAPA §5.6): przychód z Apple w PLN, koszt AI
 * w PLN na ekranie Asystent i w raporcie dziennym. ŚCIEŻKI APLIKACJI (limity
 * kosztów asystenta) kursu nie czytają — liczą w USD.
 *
 * Bez klucza i bez zmiennych: API NBP jest publiczne. Awaria NBP to tylko
 * wpis w logu — „kurs na dzień” spada wtedy na ostatni znany, a przy pustej
 * tabeli na stałą cennika `REFERENCE_USD_PLN`.
 */
@Injectable()
export class FxRateService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(FxRateService.name);
  private timers: NodeJS.Timeout[] = [];
  private running = false;

  constructor(private readonly prisma: PrismaService) {}

  onApplicationBootstrap(): void {
    if (process.env.NODE_ENV === 'test') return;
    const first = setTimeout(() => void this.sync(), FIRST_TICK_MS);
    const loop = setInterval(() => void this.sync(), TICK_MS);
    first.unref();
    loop.unref();
    this.timers = [first, loop];
  }

  onModuleDestroy(): void {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers = [];
  }

  /** Dociąga brakujące notowania. Nigdy nie rzuca; zwraca liczbę nowych wierszy. */
  async sync(
    now: Date = new Date(),
    fetchImpl: typeof fetch = globalThis.fetch,
  ): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      const latest = await this.prisma.fxRate.findFirst({
        where: { pair: USD_PLN },
        orderBy: { date: 'desc' },
        select: { date: true },
      });
      const windows = fxFetchWindows(
        latest ? keyOfDate(latest.date) : null,
        warsawDateKey(now),
      );
      let added = 0;
      for (const range of windows) {
        const res = await fetchImpl(nbpTablesUrl(range.from, range.to), {
          headers: { accept: 'application/json' },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        // 404 = w zakresie nie ma żadnej tabeli (weekend, święto, przed 12:00).
        if (res.status === 404) continue;
        if (!res.ok) {
          this.logger.warn(`NBP: HTTP ${res.status}`);
          return added;
        }
        const rows = parseNbpTables(await res.json());
        if (rows.length === 0) continue;
        const { count } = await this.prisma.fxRate.createMany({
          data: rows.map((row) => ({
            date: dateOfKey(row.date),
            pair: row.pair,
            rate: row.rate,
            source: row.source,
          })),
          skipDuplicates: true,
        });
        added += count;
      }
      return added;
    } catch (error) {
      this.logger.warn(
        `NBP: ${error instanceof Error ? error.message : String(error)}`,
      );
      return 0;
    } finally {
      this.running = false;
    }
  }

  /** Kursy potrzebne do przeliczenia dni `from`…`to` (z zapasem na święta). */
  async book(from: string, to: string, pairs?: string[]): Promise<FxBook> {
    const rows = await this.prisma.fxRate.findMany({
      where: {
        date: {
          gte: dateOfKey(addDays(from, -LOOKBACK_DAYS)),
          lte: dateOfKey(to),
        },
        ...(pairs ? { pair: { in: pairs } } : {}),
      },
      select: { date: true, pair: true, rate: true },
    });
    const list = rows.map((row) => ({
      date: keyOfDate(row.date),
      pair: row.pair,
      rate: row.rate.toNumber(),
    }));
    // Okres zaczyna się po dłuższej przerwie w notowaniach: dociągnij
    // ostatni USD/PLN sprzed okna, żeby nie spaść od razu na stałą.
    if (!list.some((row) => row.pair === USD_PLN && row.date <= from)) {
      const before = await this.latestOn(USD_PLN, from);
      if (before) list.push({ ...before, pair: USD_PLN });
    }
    return new FxBook(list);
  }

  /** USD/PLN na dzień (ostatnie notowanie ≤ dzień) albo stała cennika. */
  async usdPlnOn(day: string): Promise<RateOnDay> {
    try {
      return withReference(await this.latestOn(USD_PLN, day));
    } catch {
      return withReference(null);
    }
  }

  /** Najnowsze USD/PLN i EUR/PLN — karta „Kurs NBP”. */
  async latest(now: Date = new Date()): Promise<FxInfo> {
    const today = warsawDateKey(now);
    const [usd, eur] = await Promise.all([
      this.latestOn(USD_PLN, today),
      this.latestOn(EUR_PLN, today),
    ]);
    const usdPln = withReference(usd);
    return {
      date: usdPln.date,
      usdPln: usdPln.rate,
      eurPln: eur?.rate ?? null,
      source: usdPln.source,
    };
  }

  private async latestOn(
    pair: string,
    day: string,
  ): Promise<{ date: string; rate: number } | null> {
    const row = await this.prisma.fxRate.findFirst({
      where: { pair, date: { lte: dateOfKey(day) } },
      orderBy: { date: 'desc' },
      select: { date: true, rate: true },
    });
    return row
      ? { date: keyOfDate(row.date), rate: row.rate.toNumber() }
      : null;
  }
}
