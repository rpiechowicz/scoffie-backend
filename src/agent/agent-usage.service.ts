import { Injectable } from '@nestjs/common';
import { readAgentEnv } from '../config/agent-env';
import { PrismaService } from '../prisma/prisma.service';
import { AgentConversationsService } from './agent-conversations.service';
import { AiUsageCountersService } from './ai-usage-counters.service';

export type QuotaView = {
  used: number;
  limit: number;
  remaining: number;
};

export type AgentUsageView = {
  householdId: string;
  /** `YYYY-MM` UTC — okres, którego dotyczą liczby. */
  period: string;
  /** ISO — kiedy kwota wraca (północ UTC pierwszego dnia miesiąca). */
  resetsAt: string;
  /**
   * Dziś zawsze `FREE`: limity to jedna wartość z env dla wszystkich.
   * Pole istnieje od razu, żeby telefon nie musiał zmieniać kontraktu, gdy
   * dojdzie plan płatny.
   */
  tier: 'FREE';
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
    const env = readAgentEnv();
    const period = this.counters.monthKey(now);
    const periodStart = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0),
    );
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
          startedAt: { gte: periodStart, lt: this.counters.monthResetsAt(now) },
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
      resetsAt: this.counters.monthResetsAt(now).toISOString(),
      tier: 'FREE',
      messages: quota(messagesUsed, env.messagesPerMonth),
      plans: quota(plansUsed, env.plansPerMonth),
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
