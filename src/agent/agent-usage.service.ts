import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AgentConversationsService } from './agent-conversations.service';
import {
  AiUsageCountersService,
  HouseholdPlanSource,
  HouseholdPlanTier,
} from './ai-usage-counters.service';

export type QuotaView = {
  used: number;
  limit: number;
  remaining: number;
};

export type AgentUsageView = {
  householdId: string;
  /** `YYYY-MM` UTC (PRO) albo `trial` — okres, którego dotyczą liczby. */
  period: string;
  /** ISO — kiedy kwota wraca; `null` na próbie (pula się nie odnawia). */
  resetsAt: string | null;
  /** Czy pula wraca co miesiąc. */
  renews: boolean;
  /** `TRIAL` = jednorazowa pula na próbę, `PRO` = pula miesięczna. */
  tier: HouseholdPlanTier;
  /** Skąd PRO — telefon pokazuje „Zarządzaj subskrypcją" tylko przy SUBSCRIPTION. */
  source: HouseholdPlanSource;
  /** Nazwa kupionego planu (Solo/Duet/Rodzina); `null` = limity z env. */
  product: string | null;
  messages: QuotaView;
  plans: QuotaView;
  /**
   * Rozkład zużytych wiadomości na domowników w tym okresie — pula jest
   * wspólna, więc ktoś zawsze pyta „kto to zużył". Liczone z tur, które nie
   * oddały kwoty (`quotaRefunded = false`), więc suma zgadza się z `used`.
   */
  byUser: { userId: string; displayName: string; messages: number }[];
};

/**
 * „Ile mi zostało" — do tej pory użytkownik dowiadywał się o limicie
 * dopiero z 429, bez liczby i bez daty. Bez tego nie da się zbudować ani
 * paska „12 z 30 w tym miesiącu", ani paywalla z przydziałem (App Store
 * 3.1.2(c) każe podać ilość).
 *
 * Bez `assertEnabled`: przy wyłączonym asystencie liczby nadal są prawdziwe
 * i telefon może je pokazać obok informacji „niedostępny".
 */
@Injectable()
export class AgentUsageService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly conversations: AgentConversationsService,
    private readonly counters: AiUsageCountersService,
  ) {}

  async usage(
    userId: string,
    householdId: string,
    now: Date = new Date(),
  ): Promise<AgentUsageView> {
    await this.conversations.ensureMembership(userId, householdId);
    const plan = await this.counters.resolvePlan(householdId, now);
    const period = plan.periodKey;
    // Rozkład na domowników: w PRO z bieżącego miesiąca, na próbie z całej
    // puli (jedna na życie gospodarstwa).
    const periodStart = plan.renews
      ? new Date(
          Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0),
        )
      : undefined;
    const [messagesUsed, plansUsed, perUser] = await Promise.all([
      this.counters.read(householdId, period, 'messages'),
      this.counters.read(householdId, period, 'plans'),
      this.prisma.agentTurn.groupBy({
        by: ['userId'],
        where: {
          conversation: { householdId },
          // Liczy się każda tura, która NIE oddała kwoty: udana i nieudana
          // z winy pytania (4xx, odmowa modelu). Tury po timeoucie, Stop
          // i awarii dostawcy kwotę zwróciły i w rozkładzie ich nie ma.
          status: { not: 'RUNNING' },
          quotaRefunded: false,
          ...(periodStart
            ? {
                startedAt: {
                  gte: periodStart,
                  lt: this.counters.monthResetsAt(now),
                },
              }
            : {}),
        },
        _count: { _all: true },
      }),
    ]);
    const names = new Map(
      (
        await this.prisma.user.findMany({
          where: { id: { in: perUser.map((row) => row.userId) } },
          select: { id: true, displayName: true },
        })
      ).map((user) => [user.id, user.displayName]),
    );
    return {
      householdId,
      period,
      resetsAt: plan.resetsAt,
      renews: plan.renews,
      tier: plan.tier,
      source: plan.source,
      product: plan.product,
      messages: quota(messagesUsed, plan.messagesLimit),
      plans: quota(plansUsed, plan.plansLimit),
      byUser: perUser
        .map((row) => ({
          userId: row.userId,
          displayName: names.get(row.userId) ?? 'Były domownik',
          messages: row._count._all,
        }))
        .sort((a, b) => b.messages - a.messages),
    };
  }
}

function quota(used: number, limit: number): QuotaView {
  return { used, limit, remaining: Math.max(0, limit - used) };
}
