import { Injectable } from '@nestjs/common';
import { HouseholdsService } from '../households/households.service';
import { ConsentsService } from '../consents/consents.service';
import { readAgentEnv } from '../config/agent-env';
import { AgentMemoryService } from './agent-memory.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  buildCatalogDigest,
  CatalogDigest,
  loadDigestRecipes,
} from './catalog-digest';
import { buildSystemPrompt, SystemBlock } from './agent-system-prompt';

/**
 * Gospodarstwo katalogowe — to samo, co `RECIPE_IMPORT_HOUSEHOLD_ID`.
 * Czytane z env, bo na dev i na produkcji ma inne id.
 */
const DEFAULT_CATALOG_HOUSEHOLD = '22222222-2222-4222-8222-222222222222';

export type TurnDates = {
  weekStart: string;
  clientToday: string;
  timeZone: string;
};

export type AgentPrompt = {
  system: SystemBlock[];
  /** `R07` → `recipeId`; narzędzia rozwiązują po nim odpowiedzi modelu. */
  catalogIndex: Record<string, string>;
  catalogVersion: string;
};

/**
 * Składa prompt systemowy tury: instrukcje, katalog i kontekst gospodarstwa.
 *
 * Osobny serwis, a nie metoda runnera, z dwóch powodów: runner ma pilnować
 * cyklu życia tury (limit czasu, kwota, domknięcie), a składanie promptu to
 * zupełnie inna robota — i to ta, którą najczęściej będziemy zmieniać.
 *
 * Digest budujemy per tura. Przy 89 przepisach to jedno zapytanie i kilka
 * milisekund, a próba trzymania go w pamięci wymagałaby unieważniania przy
 * każdej zmianie katalogu — czyli dokładnie tej złożoności, której `catalogVersion`
 * ma nas oszczędzić. Gdy katalog urośnie, tu jest miejsce na cache.
 */
@Injectable()
export class AgentPromptService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly households: HouseholdsService,
    private readonly memory: AgentMemoryService,
    private readonly consents: ConsentsService,
  ) {}

  async build(
    userId: string,
    householdId: string,
    dates: TurnDates,
    proposalMode: boolean,
    scopeUserIds: readonly string[] = [],
  ): Promise<AgentPrompt> {
    const [digest, household, allMembers, memory] = await Promise.all([
      this.loadDigest(),
      this.prisma.household.findUnique({
        where: { id: householdId },
        select: { name: true, enabledMealTypes: true },
      }),
      this.households.memberPreferences(userId, householdId),
      this.memory.promptBlock(householdId),
    ]);

    // Do modelu (czyli do USA) idą dane TYLKO tych domowników, którzy sami
    // wyrazili zgodę — alergie i dieta to dane o zdrowiu (art. 9 RODO), a
    // zgoda jednej osoby nie obejmuje partnera. Ograniczenia pozostałych
    // pilnuje kod przy zapisie (`applyWeekPlan`), więc plan nadal ich nie
    // skrzywdzi; model po prostu o nich nie wie.
    const { members, withheld } = await this.membersForModel(allMembers);

    const system = buildSystemPrompt(digest, {
      memory,
      householdName: household?.name ?? 'Dom',
      clientToday: dates.clientToday,
      weekStart: dates.weekStart,
      timeZone: dates.timeZone,
      enabledMealTypes: household?.enabledMealTypes ?? [],
      members,
      membersWithheld: withheld,
      proposalMode,
      // Imiona, nie identyfikatory: prompt czyta człowiek i model, a oba
      // rozumieją „Ania" lepiej niż UUID. Identyfikatory model i tak ma
      // w bloku domowników obok.
      scopeNames: members
        .filter((member) => scopeUserIds.includes(member.userId))
        .map((member) => member.displayName),
    });

    return {
      system,
      catalogIndex: digest.index,
      catalogVersion: digest.catalogVersion,
    };
  }

  /**
   * Filtr zgód dla listy domowników idącej do modelu. Przy wyłączonej
   * bramce (`AI_CONSENT_REQUIRED` puste) — jak dotąd, wszyscy.
   */
  async membersForModel<T extends { userId: string }>(
    members: readonly T[],
  ): Promise<{ members: T[]; withheld: number }> {
    if (!readAgentEnv().consentRequired) {
      return { members: [...members], withheld: 0 };
    }
    const consented = await this.consents.usersWithValid(
      members.map((member) => member.userId),
      'AI_ASSISTANT',
    );
    const kept = members.filter((member) => consented.has(member.userId));
    return { members: kept, withheld: members.length - kept.length };
  }

  private async loadDigest(): Promise<CatalogDigest> {
    const householdId =
      (process.env.RECIPE_IMPORT_HOUSEHOLD_ID ?? '').trim() ||
      DEFAULT_CATALOG_HOUSEHOLD;
    return buildCatalogDigest(
      await loadDigestRecipes(this.prisma, householdId),
    );
  }
}
