import { Injectable } from '@nestjs/common';
import { readAgentEnv } from '../config/agent-env';
import { HouseholdsService } from '../households/households.service';
import { validateDto } from '../common/validate-dto';
import { AgentConversationsService } from './agent-conversations.service';
import { AgentPromptService } from './agent-prompt.service';
import { AgentUsageService, AgentUsageView } from './agent-usage.service';
import { goalLabel } from './cards/household-split-card';
import { weekRangeLabel } from './cards/agent-cards';
import { ContextQueryDto } from './dto/context-query.dto';

export type AgentContextMember = {
  userId: string;
  displayName: string;
  /** „2 100 kcal · bez laktozy” — ta sama etykieta co na karcie HOUSEHOLD_SPLIT. */
  goalLabel: string;
  calorieGoal: number;
  /** Czy dane tej osoby idą do modelu (zgoda albo bramka wyłączona). */
  consented: boolean;
  isSelf: boolean;
};

export type AgentContextView = {
  householdId: string;
  weekStart: string | null;
  /** „31 sierpnia – 6 września”; `null` bez `weekStart`. */
  weekLabel: string | null;
  members: AgentContextMember[];
  memberCount: number;
  /** Cel pytającego — to nim liczą się paski celu na kartach. */
  targetKcalPerDay: number | null;
  usage: AgentUsageView;
  /** Czy tura zaczyna na tańszym modelu (klient rysuje „biorę się za plan”). */
  handoff: boolean;
};

/**
 * Jedno wywołanie zamiast trzech cache'ów w telefonie.
 *
 * Chipy nad polem mają mówić, z czym asystent POLICZY odpowiedź — więc muszą
 * brać te same dane, którymi serwer składa prompt: ten sam filtr zgód, ta
 * sama etykieta celu, ten sam licznik. Bez `assertEnabled`: przy wyłączonym
 * asystencie ekran nadal ma co pokazać obok „niedostępny".
 */
@Injectable()
export class AgentContextService {
  constructor(
    private readonly households: HouseholdsService,
    private readonly prompts: AgentPromptService,
    private readonly usage: AgentUsageService,
    private readonly conversations: AgentConversationsService,
  ) {}

  async context(
    userId: string,
    dto: ContextQueryDto,
  ): Promise<AgentContextView> {
    const query = await validateDto(ContextQueryDto, dto);
    await this.conversations.ensureMembership(userId, query.householdId);
    const [all, usage] = await Promise.all([
      this.households.memberPreferences(userId, query.householdId),
      this.usage.usage(userId, query.householdId),
    ]);
    const { members: consented } = await this.prompts.membersForModel(all);
    const consentedIds = new Set(consented.map((member) => member.userId));
    const asking = all.find((member) => member.userId === userId);

    return {
      householdId: query.householdId,
      weekStart: query.weekStart ?? null,
      weekLabel: query.weekStart ? weekRangeLabel(query.weekStart) : null,
      members: all.map((member) => ({
        userId: member.userId,
        displayName: member.displayName,
        goalLabel: goalLabel({
          calorieGoal: member.targets.calorieGoal,
          dietPreference: member.dietPreference,
          allergens: member.allergens,
        }),
        calorieGoal: member.targets.calorieGoal,
        consented: consentedIds.has(member.userId),
        isSelf: member.userId === userId,
      })),
      memberCount: all.length,
      targetKcalPerDay: asking?.targets.calorieGoal ?? null,
      usage,
      handoff: readAgentEnv().toolsModel !== null,
    };
  }
}
