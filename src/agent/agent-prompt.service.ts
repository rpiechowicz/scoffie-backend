import { Injectable, Logger } from '@nestjs/common';
import { HouseholdsService } from '../households/households.service';
import { WeeklyPlansService } from '../weekly-plans/weekly-plans.service';
import { ConsentsService } from '../consents/consents.service';
import { readAgentEnv } from '../config/agent-env';
import { AgentMemoryService } from './agent-memory.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  buildSystemPrompt,
  clientClock,
  sharedSystemBlocks,
  SystemBlock,
} from './agent-system-prompt';
import {
  AgentCatalogService,
  CatalogSnapshot,
} from './search/agent-catalog.service';
import { weekRangeLabel } from './cards/agent-cards';
import { memoized, TURN_KEYS, TurnMemo } from './turn-memo';
import {
  projectWeekPlanForModel,
  WeekPlanForModel,
} from './week-plan-projection';

export type TurnDates = {
  weekStart: string;
  clientToday: string;
  timeZone: string;
};

export type AgentPrompt = {
  system: SystemBlock[];
  /**
   * „Uwzględniłem: …" — z czym model liczy tę turę, gotowe napisy dla
   * telefonu. To jest to samo, co chipy nad polem, tylko po fakcie: tydzień,
   * dla kogo, cel pytającego, ilu domowników zostało poza (bez zgody).
   */
  usedContext: string[];
  /** `R07` → `recipeId`; narzędzia rozwiązują po nim odpowiedzi modelu. */
  catalogIndex: Record<string, string>;
  catalogVersion: string;
  /**
   * Domownicy, których model może zobaczyć po identyfikatorze (zgoda
   * `AI_ASSISTANT`) — ten sam filtr dla bloku gospodarstwa, planu w prompcie
   * i kart z poprzednich tur w historii.
   */
  visibleUserIds: string[];
};

/**
 * Składa prompt systemowy tury: instrukcje, katalog i kontekst gospodarstwa.
 *
 * Osobny serwis, a nie metoda runnera, z dwóch powodów: runner ma pilnować
 * cyklu życia tury (limit czasu, kwota, domknięcie), a składanie promptu to
 * zupełnie inna robota — i to ta, którą najczęściej będziemy zmieniać.
 *
 * Katalog (indeks `R007`, mapa, digest) bierze z `AgentCatalogService`, który
 * trzyma go w pamięci i przebudowuje tylko przy zmianie katalogu — przy 500
 * przepisach budowa per tura była pięciuset wierszami ze składnikami na
 * każde pytanie. Do promptu idzie MAPA katalogu (`AI_CATALOG_MODE=search`)
 * albo cały digest (`digest`).
 */
@Injectable()
export class AgentPromptService {
  private readonly logger = new Logger(AgentPromptService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly households: HouseholdsService,
    private readonly memory: AgentMemoryService,
    private readonly consents: ConsentsService,
    private readonly weeklyPlans: WeeklyPlansService,
    private readonly catalog: AgentCatalogService,
  ) {}

  /**
   * Blok katalogu według trybu — ten sam tekst dla tury i dla podgrzewacza
   * cache, więc oba trafiają w jeden wpis prefiksu.
   */
  static catalogBlock(snapshot: CatalogSnapshot): { text: string } {
    return readAgentEnv().catalogMode === 'digest'
      ? { text: snapshot.digest.text }
      : { text: snapshot.map };
  }

  /** Wspólny prefiks instalacji (instrukcje + katalog) — dla podgrzewacza cache. */
  async sharedPrefix(): Promise<SystemBlock[]> {
    return sharedSystemBlocks(
      AgentPromptService.catalogBlock(await this.catalog.snapshot()),
    );
  }

  async build(
    userId: string,
    householdId: string,
    dates: TurnDates,
    proposalMode: boolean,
    handoff = false,
    /** Pamięć tury: te same odczyty domu użyją potem narzędzia i planer. */
    memo?: TurnMemo,
  ): Promise<AgentPrompt> {
    const [snapshot, household, allMembers, rawPlan] = await Promise.all([
      this.catalog.snapshot(memo),
      memoized(memo, TURN_KEYS.household(householdId), () =>
        this.prisma.household.findUnique({
          where: { id: householdId },
          select: { name: true, enabledMealTypes: true },
        }),
      ),
      memoized(memo, TURN_KEYS.members(userId, householdId), () =>
        this.households.memberPreferences(userId, householdId),
      ),
      this.loadWeekPlan(userId, householdId, dates.weekStart),
    ]);

    // Do modelu (czyli do USA) idą dane TYLKO tych domowników, którzy sami
    // wyrazili zgodę — alergie i dieta to dane o zdrowiu (art. 9 RODO), a
    // zgoda jednej osoby nie obejmuje partnera. Ograniczenia pozostałych
    // pilnuje kod przy zapisie (`applyWeekPlan`), więc plan nadal ich nie
    // skrzywdzi; model po prostu o nich nie wie.
    const { members, withheld } = await memoized(
      memo,
      TURN_KEYS.visible(userId, householdId),
      () => this.membersForModel(allMembers),
    );
    // Notatka „Kubie nie dawać orzechów" o Kubie bez zgody to ta sama dana, co
    // jego profil — nie idzie do modelu, dopóki Kuba nie kliknie. Filtr
    // dostaje TOŻSAMOŚCI, nie imiona: dopasowanie imienia w tekście nie działa
    // w polszczyźnie i nie łapie notatek bez imienia (audyt 12.09.2026).
    const memory = await this.memory.promptBlock(householdId, {
      consentedUserIds: new Set(members.map((member) => member.userId)),
      allConsented: withheld === 0,
    });

    // Ta sama projekcja i ten sam filtr zgód, co w `get_week_plan`: indeks
    // katalogu zamiast UUID przepisu, domownik bez zgody jako liczba.
    const weekPlan: WeekPlanForModel | null = rawPlan
      ? projectWeekPlanForModel(
          rawPlan,
          new Map(
            Object.entries(snapshot.digest.index).map(([ref, id]) => [id, ref]),
          ),
          new Set(members.map((member) => member.userId)),
        )
      : null;

    const system = buildSystemPrompt(
      AgentPromptService.catalogBlock(snapshot),
      {
        memory,
        householdName: household?.name ?? 'Dom',
        clientToday: dates.clientToday,
        weekStart: dates.weekStart,
        timeZone: dates.timeZone,
        clientTime: clientClock(dates.timeZone),
        enabledMealTypes: household?.enabledMealTypes ?? [],
        members,
        membersWithheld: withheld,
        proposalMode,
        handoff,
        weekPlan,
      },
    );

    const asking = allMembers.find((member) => member.userId === userId);
    const usedContext = [
      `Tydzień ${weekRangeLabel(dates.weekStart)}`,
      `Cały dom · ${allMembers.length}`,
      ...(asking?.targets.calorieGoal
        ? [`Cel ${asking.targets.calorieGoal} kcal`]
        : []),
      ...(withheld > 0 ? [`${withheld} bez zgody na asystenta`] : []),
      ...(memory ? ['notatki z poprzednich rozmów'] : []),
    ];

    return {
      system,
      usedContext,
      catalogIndex: snapshot.digest.index,
      catalogVersion: snapshot.digest.catalogVersion,
      visibleUserIds: members.map((member) => member.userId),
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

  /**
   * Plan planowanego tygodnia do bloku gospodarstwa — patrz `weekPlanLines`.
   *
   * Błąd odczytu NIE wywraca tury: bez planu w prompcie model sięgnie po
   * `get_week_plan`, czyli zachowa się dokładnie tak, jak przed tą zmianą.
   */
  private async loadWeekPlan(
    userId: string,
    householdId: string,
    weekStart: string,
  ): Promise<Parameters<typeof projectWeekPlanForModel>[0] | null> {
    try {
      return await this.weeklyPlans.getByHouseholdAndWeek(
        userId,
        householdId,
        weekStart,
      );
    } catch (error) {
      this.logger.warn(
        `plan tygodnia do promptu niedostępny (${
          error instanceof Error ? error.name : 'nieznany błąd'
        }) — model sięgnie po get_week_plan`,
      );
      return null;
    }
  }
}
