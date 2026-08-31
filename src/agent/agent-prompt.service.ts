import { Injectable } from '@nestjs/common';
import { HouseholdsService } from '../households/households.service';
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
  ) {}

  async build(
    userId: string,
    householdId: string,
    dates: TurnDates,
  ): Promise<AgentPrompt> {
    const [digest, household, members] = await Promise.all([
      this.loadDigest(),
      this.prisma.household.findUnique({
        where: { id: householdId },
        select: { name: true, enabledMealTypes: true },
      }),
      this.households.memberPreferences(userId, householdId),
    ]);

    const system = buildSystemPrompt(digest, {
      householdName: household?.name ?? 'Dom',
      clientToday: dates.clientToday,
      weekStart: dates.weekStart,
      timeZone: dates.timeZone,
      enabledMealTypes: household?.enabledMealTypes ?? [],
      members,
    });

    return {
      system,
      catalogIndex: digest.index,
      catalogVersion: digest.catalogVersion,
    };
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
