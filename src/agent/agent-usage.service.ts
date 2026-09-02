import { Injectable } from '@nestjs/common';
import { readAgentEnv } from '../config/agent-env';
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
    const [messagesUsed, plansUsed] = await Promise.all([
      this.counters.read(householdId, period, 'messages'),
      this.counters.read(householdId, period, 'plans'),
    ]);
    return {
      householdId,
      period,
      resetsAt: this.counters.monthResetsAt(now).toISOString(),
      tier: 'FREE',
      messages: quota(messagesUsed, env.messagesPerMonth),
      plans: quota(plansUsed, env.plansPerMonth),
    };
  }
}

function quota(used: number, limit: number): QuotaView {
  return { used, limit, remaining: Math.max(0, limit - used) };
}
