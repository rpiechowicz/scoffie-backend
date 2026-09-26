import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma, type AnthropicCreditAnchor } from '@prisma/client';
import { AppException } from '../../common/app-exception';
import { emitLive } from '../../common/live-events';
import { PrismaService } from '../../prisma/prisma.service';
import {
  AdminAuditService,
  type AdminActor,
} from '../audit/admin-audit.service';
import { sqlInstant } from '../common/warsaw-calendar';
import type { AnthropicAnchorCreate, AnthropicBilling } from '../contract';
import { IntegrationCache } from '../integrations/integration-fetch';
import {
  fetchCostReport,
  fetchUsageReport,
  readAnthropicAdminKey,
} from './anthropic-billing.client';
import {
  ANCHORS_SHOWN,
  billingRange,
  buildBilling,
  buildLedger,
  dayKey,
  ledgerRange,
  type AnchorRow,
  type BillingRaw,
} from './anthropic-billing';

/** Anthropic zaleca najwyżej zapytanie na minutę; dane i tak mają ~5 min opóźnienia. */
export const ANTHROPIC_TTL_MS = 5 * 60_000;
export const DEFAULT_LOW_BALANCE_USD = 5;
const SETTINGS_ID = 'default';
const DAY_MS = 24 * 60 * 60_000;

const toAnchor = (row: AnthropicCreditAnchor): AnchorRow => ({
  id: row.id,
  at: row.at,
  balanceUsd: row.balanceUsd.toNumber(),
  amountUsd: row.amountUsd === null ? null : row.amountUsd.toNumber(),
  note: row.note,
  createdBy: row.createdBy,
});

/**
 * Kredyty Claude w panelu. Wydatki i tokeny z Usage & Cost Admin API
 * (`ANTHROPIC_ADMIN_KEY`), saldo szacowane od ostatniej kotwicy wpisanej
 * ręcznie — Anthropic salda nie udostępnia. Raporty w pamięci procesu na
 * 5 min; kotwice czytane z bazy przy każdym żądaniu, więc nowa kotwica
 * zmienia saldo od razu (klucz pamięci zawiera dobę kotwicy).
 */
@Injectable()
export class AdminAnthropicService {
  private cache = new IntegrationCache();

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AdminAuditService,
  ) {}

  async billing(
    now: Date = new Date(),
    fetchImpl: typeof fetch = globalThis.fetch,
  ): Promise<AnthropicBilling> {
    const [rows, lowBalanceUsd, ledger] = await Promise.all([
      this.prisma.anthropicCreditAnchor.findMany({
        orderBy: { at: 'desc' },
        take: ANCHORS_SHOWN,
      }),
      this.lowBalanceUsd(),
      this.ledger(now),
    ]);
    const anchors = rows.map(toAnchor);
    const key = readAnthropicAdminKey();
    if (!key) {
      return buildBilling({
        configured: false,
        error: null,
        raw: null,
        anchors,
        lowBalanceUsd,
        now,
        fetchedAt: now,
        ledger,
      });
    }
    const range = billingRange(now, anchors[0]?.at ?? null);
    const state = await this.cache.get(
      `anthropic:${dayKey(range.costFrom)}:${range.anchorDay ? dayKey(range.anchorDay) : '-'}`,
      ANTHROPIC_TTL_MS,
      () => this.load(key, range, fetchImpl),
    );
    return buildBilling({
      configured: true,
      error: state.status === 'error' ? state.message : null,
      raw: state.status === 'ok' ? state.data : null,
      anchors,
      lowBalanceUsd,
      now,
      fetchedAt: state.status === 'off' ? now : new Date(state.fetchedAt),
      ledger,
    });
  }

  /**
   * Własna księga kosztu (`AiUsage`, per wywołanie modelu) w dobach UTC —
   * do porównania z rachunkiem Anthropic. Nie zależy od klucza; błąd bazy
   * nie może zasłonić reszty ekranu, więc wtedy `null`.
   */
  private async ledger(now: Date): Promise<AnthropicBilling['ledger']> {
    const { from, to } = ledgerRange(now);
    try {
      const rows = await this.prisma.$queryRaw<{ day: string; cost: bigint }[]>(
        Prisma.sql`
          SELECT to_char(u."createdAt", 'YYYY-MM-DD') AS day,
                 COALESCE(SUM(u."costMicroUsd"), 0)::bigint AS cost
          FROM "AiUsage" u
          WHERE u."createdAt" >= ${sqlInstant(from)} AND u."createdAt" < ${sqlInstant(to)}
          GROUP BY 1
        `,
      );
      return buildLedger(
        rows.map((r) => ({ day: r.day, microUsd: Number(r.cost) })),
        now,
      );
    } catch {
      return null;
    }
  }

  private async load(
    key: string,
    range: ReturnType<typeof billingRange>,
    fetchImpl: typeof fetch,
  ): Promise<BillingRaw> {
    const anchorDay = range.anchorDay;
    const [cost, usageDaily, hourly, anchorDayUsage] = await Promise.all([
      fetchCostReport(key, range.costFrom, range.to, fetchImpl),
      fetchUsageReport(key, range.usageFrom, range.to, '1d', true, fetchImpl),
      fetchUsageReport(
        key,
        range.hourlyFrom,
        range.hourlyTo,
        '1h',
        false,
        fetchImpl,
      ),
      anchorDay
        ? fetchUsageReport(
            key,
            anchorDay,
            new Date(
              Math.min(anchorDay.getTime() + DAY_MS, range.hourlyTo.getTime()),
            ),
            '1h',
            false,
            fetchImpl,
          )
        : Promise.resolve([]),
    ]);
    return { cost, usageDaily, hourly, anchorDay: anchorDayUsage };
  }

  async createAnchor(
    actor: AdminActor,
    input: AnthropicAnchorCreate,
  ): Promise<AnthropicBilling> {
    const note = input.note?.trim() || null;
    await this.audit.run(
      actor,
      {
        action: 'anthropic.anchor.create',
        targetType: 'AnthropicCreditAnchor',
        details: {
          balanceUsd: input.balanceUsd,
          amountUsd: input.amountUsd ?? null,
        },
      },
      () =>
        this.prisma.anthropicCreditAnchor.create({
          data: {
            balanceUsd: input.balanceUsd,
            amountUsd: input.amountUsd ?? null,
            note,
            createdBy: actor.adminEmail,
          },
        }),
      (row) => ({ id: row.id }),
    );
    return this.changed();
  }

  async deleteAnchor(actor: AdminActor, id: string): Promise<AnthropicBilling> {
    await this.audit.run(
      actor,
      {
        action: 'anthropic.anchor.delete',
        targetType: 'AnthropicCreditAnchor',
        targetId: id,
      },
      async () => {
        const row = await this.prisma.anthropicCreditAnchor.findUnique({
          where: { id },
        });
        if (!row) {
          throw new AppException(
            'NOT_FOUND',
            'Nie ma takiego wpisu salda.',
            HttpStatus.NOT_FOUND,
          );
        }
        await this.prisma.anthropicCreditAnchor.delete({ where: { id } });
        return row;
      },
      (row) => ({
        balanceUsd: row.balanceUsd.toNumber(),
        at: row.at.toISOString(),
      }),
    );
    return this.changed();
  }

  async setLowBalance(
    actor: AdminActor,
    lowBalanceUsd: number,
  ): Promise<AnthropicBilling> {
    const previous = await this.lowBalanceUsd();
    await this.audit.run(
      actor,
      {
        action: 'anthropic.settings.set',
        targetType: 'AnthropicBillingSetting',
        targetId: SETTINGS_ID,
        details: { lowBalanceUsd, previous },
      },
      () =>
        this.prisma.anthropicBillingSetting.upsert({
          where: { id: SETTINGS_ID },
          create: {
            id: SETTINGS_ID,
            lowBalanceUsd,
            updatedBy: actor.adminEmail,
          },
          update: { lowBalanceUsd, updatedBy: actor.adminEmail },
        }),
    );
    return this.changed();
  }

  private async lowBalanceUsd(): Promise<number> {
    const row = await this.prisma.anthropicBillingSetting.findUnique({
      where: { id: SETTINGS_ID },
    });
    return row ? row.lowBalanceUsd.toNumber() : DEFAULT_LOW_BALANCE_USD;
  }

  /** Po zapisie: świeże raporty przy następnym odczycie, sygnał dla innych kart. */
  private changed(): Promise<AnthropicBilling> {
    this.cache = new IntegrationCache();
    emitLive({ topics: ['assistant'] });
    return this.billing();
  }
}
