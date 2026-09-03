import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { AgentProposal, Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { HouseholdsService } from '../../households/households.service';
import {
  PlanViolation,
  WeeklyPlansService,
} from '../../weekly-plans/weekly-plans.service';
import { WeeklyPlansGateway } from '../../weekly-plans/weekly-plans.gateway';
import { ApplyWeekSlotDto } from '../../weekly-plans/dto/apply-week-plan.dto';
import { ensureMembership } from '../../weekly-plans/utils/auth-checks.util';
import { AppException } from '../../common/app-exception';
import { assertUuid } from '../../common/uuid';
import { readAgentEnv } from '../../config/agent-env';
import { AgentCardState, PlanRemovalReason } from '../cards/agent-cards';
import {
  appliedMessageText,
  buildAppliedCard,
  weekStartLabel,
} from '../cards/applied-card';
import { buildPlanWeekCard } from '../cards/plan-week-card';
import { buildPlanDayCard } from '../cards/plan-day-card';
import { buildSwapCard } from '../cards/swap-card';
import {
  buildHouseholdSplitCard,
  goalLabel,
} from '../cards/household-split-card';
import { DayOfWeek, MealType } from '@prisma/client';
import {
  dateForDay,
  HouseholdSplitPortion,
  SwapCardSide,
} from '../cards/agent-cards';
import { AiUsageCountersService } from '../ai-usage-counters.service';
import { weekBaselineHash } from './proposal-baseline';
import type { MessageView } from '../agent-conversations.service';

export type CreateWeekProposalInput = {
  userId: string;
  householdId: string;
  conversationId: string;
  turnId: string;
  weekStart: string;
  slots: ApplyWeekSlotDto[];
  /** Jedno zdanie modelu „dlaczego tak” — trafia w podtytuł karty. */
  note?: string;
  /** Powody usunięć (jedno słowo) — dopasowywane do policzonych zniknięć. */
  removalReasons?: PlanRemovalReason[];
};

export type CreateDayProposalInput = Omit<CreateWeekProposalInput, 'slots'> & {
  dayOfWeek: DayOfWeek;
  /** Stan docelowy WYŁĄCZNIE tego dnia; `dayOfWeek` dokłada serwis. */
  slots: Omit<ApplyWeekSlotDto, 'dayOfWeek'>[];
};

export type CreateSwapProposalInput = Omit<
  CreateWeekProposalInput,
  'slots' | 'note'
> & {
  dayOfWeek: DayOfWeek;
  mealType: MealType;
  recipeId: string;
  /** Czego chciał użytkownik — trafia w tytuł, gdy nie ma czym się pochwalić. */
  reason?: string;
  /** Dane nowego dania; rozwiązuje je executor, bo to on zna katalog. */
  to: SwapCardSide;
  /** Dane dania, które stoi tam teraz; `null`, gdy slot jest pusty. */
  from: SwapCardSide | null;
  /**
   * Dla kogo jest podmiana. Puste = dla całego domu.
   *
   * To rozróżnienie decyduje o tym, czy podmiana WYMIENIA slot, czy tylko
   * wydziela z niego jedną porcję — patrz `createSwapProposal`.
   */
  participantIds: string[];
};

export type CreateSplitProposalInput = Omit<
  CreateWeekProposalInput,
  'slots' | 'note'
> & {
  dayOfWeek: DayOfWeek;
  mealType: MealType;
  recipeId: string;
  /** Danie: nazwa, czas i kalorie na porcję — rozwiązuje je executor. */
  dish: SwapCardSide;
  /** Kto je i jak podać; `note` jest jedyną częścią od modelu. */
  portions: { userId: string; note: string | null }[];
};

/**
 * Wynik dla MODELU — świadomie ubogi.
 *
 * Model nie dostaje całej karty: dostałby wtedy pokusę przepisania jej
 * w odpowiedzi, a użytkownik zapłaciłby za te same liczby dwa razy — raz
 * w tokenach, drugi raz czytaniem tego samego dwa razy pod rząd.
 */
export type CreateWeekProposalResult =
  | { proposed: false; violations: PlanViolation[] }
  | {
      proposed: true;
      proposalId: string;
      summary: {
        meals: number;
        created: number;
        updated: number;
        removed: number;
        averageKcalPerDay: number;
        targetKcalPerDay: number | null;
      };
    };

/**
 * Propozycje asystenta — od policzenia do zatwierdzenia.
 *
 * Sedno modelu: tura NIC nie zapisuje. Model liczy tydzień i odkłada go jako
 * propozycję; plan zmienia się dopiero wtedy, gdy człowiek kliknie przycisk
 * w karcie. Zapis nie kosztuje wtedy ani jednego tokenu, bo nie ma w nim
 * udziału modelu.
 */
@Injectable()
export class AgentProposalsService {
  private readonly logger = new Logger(AgentProposalsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly weeklyPlans: WeeklyPlansService,
    private readonly households: HouseholdsService,
    private readonly counters: AiUsageCountersService,
    private readonly plansGateway: WeeklyPlansGateway,
  ) {}

  /**
   * Policz tydzień, złóż kartę i odłóż propozycję.
   *
   * Walidację robi domena tą samą ścieżką co zapis, więc alergen domownika
   * albo danie nie do tego posiłku zatrzymują się TUTAJ — model dostaje listę
   * naruszeń i poprawia się sam, zamiast pokazywać użytkownikowi propozycję,
   * której i tak nie da się zapisać.
   */
  async createWeekPlanProposal(
    input: CreateWeekProposalInput,
  ): Promise<CreateWeekProposalResult> {
    const preview = await this.weeklyPlans.previewWeekPlan(
      input.userId,
      input.householdId,
      input.weekStart,
      { slots: input.slots },
    );
    if (preview.violations.length > 0 || preview.slots === null) {
      return { proposed: false, violations: preview.violations };
    }

    const baseline = await this.weeklyPlans.snapshotWeekAsSlots(
      input.userId,
      input.householdId,
      input.weekStart,
    );

    const env = readAgentEnv();
    const proposalId = randomUUID();
    const expiresAt = new Date(Date.now() + env.proposalTtlMs);

    const card = buildPlanWeekCard({
      proposalId,
      weekStart: input.weekStart,
      preview,
      note: input.note,
      removalReasons: input.removalReasons,
      targetKcalPerDay: await this.targetKcalFor(
        input.userId,
        input.householdId,
      ),
      expiresAt,
      forUserId: input.userId,
      enabledMealTypes: await this.enabledMealTypesFor(input.householdId),
    });

    await this.prisma.agentProposal.create({
      data: {
        id: proposalId,
        conversationId: input.conversationId,
        turnId: input.turnId,
        userId: input.userId,
        householdId: input.householdId,
        kind: 'PLAN_WEEK',
        weekStart: new Date(`${input.weekStart}T00:00:00.000Z`),
        // Stan docelowy zostaje po stronie serwera. Klient przysyła sam
        // identyfikator propozycji, więc nie ma jak podmienić tego, co się
        // zapisze — nawet gdyby ktoś ruszył ruch w locie.
        action: { slots: input.slots } as unknown as Prisma.InputJsonValue,
        card: card as unknown as Prisma.InputJsonValue,
        baselineHash: weekBaselineHash(baseline),
        expiresAt,
      },
    });

    return {
      proposed: true,
      proposalId,
      summary: card.summary,
    };
  }

  /**
   * Propozycja jednego dnia.
   *
   * Model podaje sam dzień, ale zapis i tak przyjmuje CAŁY tydzień jako stan
   * docelowy — więc dzień doklejamy do migawki reszty tygodnia i liczymy to
   * jedną, znaną ścieżką. Dzięki temu propozycja dnia dziedziczy wszystko, co
   * mamy: walidację alergenów, odcisk stanu, zatwierdzanie i cofanie. Gdyby
   * dzień szedł osobnym zapisem, każda z tych rzeczy istniałaby w dwóch
   * wersjach — i to ta rzadziej używana rozjeżdżałaby się po cichu.
   */
  async createDayPlanProposal(
    input: CreateDayProposalInput,
  ): Promise<CreateWeekProposalResult> {
    const baseline = await this.weeklyPlans.snapshotWeekAsSlots(
      input.userId,
      input.householdId,
      input.weekStart,
    );
    // Reszta tygodnia zostaje dokładnie taka, jaka była. To jest różnica
    // między „zaplanuj wtorek" a „zaplanuj tydzień, w którym jest wtorek".
    const merged: ApplyWeekSlotDto[] = [
      ...baseline.filter((slot) => slot.dayOfWeek !== input.dayOfWeek),
      ...input.slots.map((slot) => ({ ...slot, dayOfWeek: input.dayOfWeek })),
    ];

    const preview = await this.weeklyPlans.previewWeekPlan(
      input.userId,
      input.householdId,
      input.weekStart,
      { slots: merged },
    );
    if (preview.violations.length > 0 || preview.slots === null) {
      return { proposed: false, violations: preview.violations };
    }

    const env = readAgentEnv();
    const proposalId = randomUUID();
    const expiresAt = new Date(Date.now() + env.proposalTtlMs);
    const date = dateForDay(input.weekStart, input.dayOfWeek);

    const card = buildPlanDayCard({
      proposalId,
      weekStart: input.weekStart,
      dayOfWeek: input.dayOfWeek,
      date,
      preview,
      note: input.note,
      removalReasons: input.removalReasons,
      targetKcalPerDay: await this.targetKcalFor(
        input.userId,
        input.householdId,
      ),
      expiresAt,
      forUserId: input.userId,
      enabledMealTypes: await this.enabledMealTypesFor(input.householdId),
    });

    await this.prisma.agentProposal.create({
      data: {
        id: proposalId,
        conversationId: input.conversationId,
        turnId: input.turnId,
        userId: input.userId,
        householdId: input.householdId,
        kind: 'PLAN_DAY',
        weekStart: new Date(`${input.weekStart}T00:00:00.000Z`),
        action: { slots: merged } as unknown as Prisma.InputJsonValue,
        card: card as unknown as Prisma.InputJsonValue,
        baselineHash: weekBaselineHash(baseline),
        expiresAt,
      },
    });

    return {
      proposed: true,
      proposalId,
      summary: {
        meals: card.summary.meals,
        created: preview.changes.created,
        updated: preview.changes.updated,
        removed: preview.changes.deleted,
        averageKcalPerDay: card.summary.kcalTotal,
        targetKcalPerDay: card.summary.targetKcalPerDay,
      },
    };
  }

  /**
   * Podmiana jednego dania.
   *
   * Slot potrafi mieć kilka pozycji naraz (dom, w którym każdy je co innego).
   * Podmiana wymienia CAŁY slot na jedno danie — inaczej „podmień kolację”
   * znaczyłoby raz jedno, raz drugie, w zależności od tego, czy ktoś w tym
   * tygodniu rozdzielił porcje. Rozdzielaniem zajmuje się osobna karta.
   */
  async createSwapProposal(
    input: CreateSwapProposalInput,
  ): Promise<CreateWeekProposalResult> {
    const baseline = await this.weeklyPlans.snapshotWeekAsSlots(
      input.userId,
      input.householdId,
      input.weekStart,
    );
    const isSlot = (slot: { dayOfWeek: string; mealType: string }) =>
      slot.dayOfWeek === input.dayOfWeek && slot.mealType === input.mealType;
    const untouched = baseline.filter((slot) => !isSlot(slot));
    const standing = baseline.filter(isSlot);

    let merged: ApplyWeekSlotDto[];
    if (input.participantIds.length === 0) {
      // Podmiana dla całego domu WYMIENIA slot — inaczej „podmień kolację"
      // znaczyłoby raz jedno, raz drugie, zależnie od tego, czy ktoś w tym
      // tygodniu rozdzielił porcje.
      merged = [
        ...untouched,
        {
          dayOfWeek: input.dayOfWeek,
          mealType: input.mealType,
          recipeId: input.recipeId,
        } as ApplyWeekSlotDto,
      ];
    } else {
      // Podmiana DLA KOGOŚ nie ma prawa zabrać jedzenia reszcie domu.
      // Z dotychczasowych pozycji wypisujemy wyłącznie te osoby, a pozycję
      // kasujemy dopiero wtedy, gdy nie zostaje przy niej nikt. Pusta lista
      // uczestników znaczy „wszyscy", więc najpierw trzeba ją rozwinąć —
      // bez tego wypisanie jednej osoby nie miałoby z czego odjąć.
      const everyone = await this.householdMemberIds(
        input.userId,
        input.householdId,
      );
      const leaving = new Set(input.participantIds);
      const narrowed = standing
        .map((slot) => {
          const current = slot.participantIds?.length
            ? slot.participantIds
            : everyone;
          const remaining = current.filter((userId) => !leaving.has(userId));
          return remaining.length > 0
            ? ({ ...slot, participantIds: remaining } as ApplyWeekSlotDto)
            : null;
        })
        .filter((slot): slot is ApplyWeekSlotDto => slot !== null);

      merged = [
        ...untouched,
        ...narrowed,
        {
          dayOfWeek: input.dayOfWeek,
          mealType: input.mealType,
          recipeId: input.recipeId,
          participantIds: input.participantIds,
        } as ApplyWeekSlotDto,
      ];
    }

    const preview = await this.weeklyPlans.previewWeekPlan(
      input.userId,
      input.householdId,
      input.weekStart,
      { slots: merged },
    );
    if (preview.violations.length > 0 || preview.slots === null) {
      return { proposed: false, violations: preview.violations };
    }

    const env = readAgentEnv();
    const proposalId = randomUUID();
    const expiresAt = new Date(Date.now() + env.proposalTtlMs);

    const card = buildSwapCard({
      forNames: await this.displayNames(
        input.userId,
        input.householdId,
        input.participantIds,
      ),
      proposalId,
      weekStart: input.weekStart,
      date: dateForDay(input.weekStart, input.dayOfWeek),
      dayOfWeek: input.dayOfWeek,
      mealType: input.mealType,
      from: input.from,
      to: input.to,
      ...(input.reason ? { reason: input.reason } : {}),
      expiresAt,
    });

    await this.prisma.agentProposal.create({
      data: {
        id: proposalId,
        conversationId: input.conversationId,
        turnId: input.turnId,
        userId: input.userId,
        householdId: input.householdId,
        kind: 'SWAP',
        weekStart: new Date(`${input.weekStart}T00:00:00.000Z`),
        action: { slots: merged } as unknown as Prisma.InputJsonValue,
        card: card as unknown as Prisma.InputJsonValue,
        baselineHash: weekBaselineHash(baseline),
        expiresAt,
      },
    });

    return {
      proposed: true,
      proposalId,
      summary: {
        meals: 1,
        created: preview.changes.created,
        updated: preview.changes.updated,
        removed: preview.changes.deleted,
        averageKcalPerDay: input.to.kcalPerServing,
        targetKcalPerDay: null,
      },
    };
  }

  /**
   * Jedno danie, kilka talerzy.
   *
   * Zapis jest zwyczajny — jedna pozycja w slocie z listą uczestników. Cała
   * wartość karty siedzi w tym, czego plan nie pokaże: obok każdego imienia
   * stoi JEGO cel i JEGO ograniczenia, wzięte z profilu. Model dokłada
   * wyłącznie sposób podania, bo to jedyna rzecz, której w profilu nie ma.
   */
  async createHouseholdSplitProposal(
    input: CreateSplitProposalInput,
  ): Promise<CreateWeekProposalResult> {
    const members = await this.households.memberPreferences(
      input.userId,
      input.householdId,
    );
    const known = new Map(members.map((member) => [member.userId, member]));
    const unknown = input.portions
      .map((portion) => portion.userId)
      .filter((userId) => !known.has(userId));
    if (unknown.length > 0) {
      throw new AppException(
        'PLAN_PARTICIPANT_NOT_IN_HOUSEHOLD',
        'Któraś z tych osób nie należy do gospodarstwa.',
        HttpStatus.BAD_REQUEST,
        unknown,
      );
    }

    const participantIds = input.portions.map((portion) => portion.userId);
    const baseline = await this.weeklyPlans.snapshotWeekAsSlots(
      input.userId,
      input.householdId,
      input.weekStart,
    );
    const merged: ApplyWeekSlotDto[] = [
      ...baseline.filter(
        (slot) =>
          slot.dayOfWeek !== input.dayOfWeek ||
          slot.mealType !== input.mealType,
      ),
      {
        dayOfWeek: input.dayOfWeek,
        mealType: input.mealType,
        recipeId: input.recipeId,
        participantIds,
      } as ApplyWeekSlotDto,
    ];

    const preview = await this.weeklyPlans.previewWeekPlan(
      input.userId,
      input.householdId,
      input.weekStart,
      { slots: merged },
    );
    if (preview.violations.length > 0 || preview.slots === null) {
      return { proposed: false, violations: preview.violations };
    }

    const env = readAgentEnv();
    const proposalId = randomUUID();
    const expiresAt = new Date(Date.now() + env.proposalTtlMs);

    // Porcja skalowana CELEM: przy 2 100 i 1 200 kcal ten sam gulasz to nie
    // te same talerze. Średnia celów = jedna porcja z przepisu; kto ma cel
    // wyżej, dostaje proporcjonalnie więcej. Zaokrąglenie do 10 kcal, bo
    // dokładniej i tak nikt nie nakłada.
    const goals = input.portions.map(
      (portion) => known.get(portion.userId)!.targets.calorieGoal,
    );
    const meanGoal =
      goals.length > 0 && goals.every((goal) => goal > 0)
        ? goals.reduce((sum, goal) => sum + goal, 0) / goals.length
        : 0;
    const portions: HouseholdSplitPortion[] = input.portions.map((portion) => {
      const member = known.get(portion.userId)!;
      const kcal =
        meanGoal > 0
          ? Math.max(
              10,
              Math.round(
                (input.dish.kcalPerServing * member.targets.calorieGoal) /
                  meanGoal /
                  10,
              ) * 10,
            )
          : input.dish.kcalPerServing;
      return {
        userId: member.userId,
        displayName: member.displayName,
        goalLabel: goalLabel({
          calorieGoal: member.targets.calorieGoal,
          dietPreference: member.dietPreference,
          allergens: member.allergens,
        }),
        note: portion.note,
        kcal,
      };
    });

    const card = buildHouseholdSplitCard({
      proposalId,
      weekStart: input.weekStart,
      date: dateForDay(input.weekStart, input.dayOfWeek),
      dayOfWeek: input.dayOfWeek,
      mealType: input.mealType,
      title: input.dish.title,
      prepTimeMinutes: input.dish.prepTimeMinutes,
      portions,
      expiresAt,
    });

    await this.prisma.agentProposal.create({
      data: {
        id: proposalId,
        conversationId: input.conversationId,
        turnId: input.turnId,
        userId: input.userId,
        householdId: input.householdId,
        kind: 'HOUSEHOLD_SPLIT',
        weekStart: new Date(`${input.weekStart}T00:00:00.000Z`),
        action: { slots: merged } as unknown as Prisma.InputJsonValue,
        card: card as unknown as Prisma.InputJsonValue,
        baselineHash: weekBaselineHash(baseline),
        expiresAt,
      },
    });

    return {
      proposed: true,
      proposalId,
      summary: {
        meals: 1,
        created: preview.changes.created,
        updated: preview.changes.updated,
        removed: preview.changes.deleted,
        averageKcalPerDay: input.dish.kcalPerServing,
        targetKcalPerDay: null,
      },
    };
  }

  /**
   * Identyfikatory wszystkich domowników.
   *
   * Potrzebne, żeby rozwinąć „pusta lista = wszyscy" na konkretne osoby —
   * inaczej nie da się z takiej pozycji nikogo wypisać.
   */
  private async householdMemberIds(
    userId: string,
    householdId: string,
  ): Promise<string[]> {
    const members = await this.households.memberPreferences(
      userId,
      householdId,
    );
    return members.map((member) => member.userId);
  }

  /** Imiona do karty — „dla Rafała" czyta się, „dla 3fa85f64…" nie. */
  private async displayNames(
    userId: string,
    householdId: string,
    ids: readonly string[],
  ): Promise<string[]> {
    if (ids.length === 0) return [];
    try {
      const members = await this.households.memberPreferences(
        userId,
        householdId,
      );
      return members
        .filter((member) => ids.includes(member.userId))
        .map((member) => member.displayName);
    } catch {
      return [];
    }
  }

  /** Sloty, które ten dom planuje — nota celu ma sens tylko dla pełnego dnia. */
  private async enabledMealTypesFor(householdId: string): Promise<string[]> {
    try {
      const household = await this.prisma.household.findUnique({
        where: { id: householdId },
        select: { enabledMealTypes: true },
      });
      return household?.enabledMealTypes ?? [];
    } catch {
      return [];
    }
  }

  /**
   * Cel kaloryczny PYTAJĄCEGO — karta pokazuje jego pasek celu, nie średnią domu.
   *
   * Błąd odczytu nie może wywrócić propozycji: brak celu znaczy tylko tyle, że
   * pasek nie ma znacznika, a plan i tak jest policzony.
   */
  private async targetKcalFor(
    userId: string,
    householdId: string,
  ): Promise<number | null> {
    try {
      const members = await this.households.memberPreferences(
        userId,
        householdId,
      );
      const mine = members.find((member) => member.userId === userId);
      return mine?.targets.calorieGoal ?? null;
    } catch (error) {
      this.logger.warn(
        `nie udało się odczytać celu kalorycznego dla propozycji: ${String(error)}`,
      );
      return null;
    }
  }

  /**
   * Zatwierdzenie propozycji — jedyne miejsce, w którym asystent zmienia plan.
   *
   * Nie ma tu udziału modelu, więc **klik nie kosztuje ani jednego tokenu**.
   * Nie ma też `assertEnabled()`: karta jest już na ekranie i użytkownik za
   * nią zapłacił kwotą wiadomości — wyłączenie asystenta w międzyczasie nie
   * może zostawić martwego przycisku.
   */
  async apply(
    userId: string,
    proposalId: string,
    options: { force?: boolean } = {},
  ): Promise<ProposalActionResult> {
    const proposal = await this.loadOwned(userId, proposalId);
    // Członkostwo mogło się zmienić między propozycją a kliknięciem.
    await ensureMembership(this.prisma, userId, proposal.householdId);

    // Podwójny klik dostaje TEN SAM wynik, nie konflikt — to jest odpowiedź
    // na dwa dotknięcia przycisku, nie sytuacja wyjątkowa.
    if (proposal.status === 'APPLIED') {
      return this.resultForApplied(proposal);
    }
    // Projekt v2: karta jest sterownikiem. UNDONE ma „Zastosuj ponownie",
    // FAILED „Spróbuj ponownie", STALE „Zapisz mimo to" (z `force`).
    // EXPIRED nie ma przycisku zapisu wcale — po 72 h asystent liczy od nowa.
    if (!REAPPLICABLE_STATUSES.has(proposal.status)) {
      throw new AppException(
        'AI_PROPOSAL_STALE',
        'Ta propozycja jest już nieaktualna. Poproś asystenta o nową.',
        HttpStatus.CONFLICT,
        [`reason:${proposal.status}`],
      );
    }
    const statusBefore = proposal.status;
    if (proposal.expiresAt.getTime() <= Date.now()) {
      await this.markStatus(proposal.id, 'EXPIRED');
      throw new AppException(
        'AI_PROPOSAL_EXPIRED',
        'Ta propozycja wygasła. Poproś asystenta o nową.',
        HttpStatus.CONFLICT,
      );
    }

    const weekStart = toWeekStartString(proposal.weekStart);
    const before = await this.weeklyPlans.snapshotWeekAsSlots(
      userId,
      proposal.householdId,
      weekStart,
    );
    // `force` pomija TYLKO to porównanie: użytkownik widział na karcie, że
    // plan się zmienił, i świadomie zapisuje. Walidacja domeny (alergeny,
    // wykluczenia) biegnie niżej w `applyWeekPlan` tak samo jak zawsze.
    if (!options.force && weekBaselineHash(before) !== proposal.baselineHash) {
      await this.markStatus(proposal.id, 'STALE');
      throw new AppException(
        'AI_PROPOSAL_STALE',
        'Plan tygodnia zmienił się od czasu tej propozycji. Poproś asystenta o nową.',
        HttpStatus.CONFLICT,
        ['reason:CHANGED'],
      );
    }

    // Kwota PRZED zamkiem: odmowa kwoty nie zostawia wtedy propozycji
    // APPLIED bez odcisku (dawny „rollback" przez markStatus połykał błędy,
    // a cofnięcie bez odcisku nadpisywało cudze zmiany).
    const plan = await this.counters.resolvePlan(proposal.householdId);
    const periodKey = plan.periodKey;
    const limit = plan.plansLimit;
    const consumed = await this.counters.tryConsume(
      this.prisma,
      proposal.householdId,
      periodKey,
      'plans',
      limit,
    );
    if (!consumed) {
      throw new AppException(
        'AI_PLAN_QUOTA_EXCEEDED',
        plan.tier === 'TRIAL'
          ? `Darmowy zapis planu na próbę (${limit}) jest wykorzystany. PRO odblokowuje pulę miesięczną dla całego domu.`
          : `Limit zapisanych planów na ten miesiąc (${limit}) został wyczerpany.`,
        HttpStatus.TOO_MANY_REQUESTS,
        this.counters.quotaDetailsFor('plans', plan),
      );
    }

    // Zamek na poziomie bazy. Chodzi nie tylko o podwójny zapis (ten i tak
    // byłby bezstratny — `applyWeekPlan` to operacja stanu docelowego), ale
    // o `undoSnapshot`: drugi przebieg zapisałby jako „stan sprzed" tydzień
    // JUŻ ZMIENIONY i zabiłby „Cofnij".
    const locked = await this.prisma.agentProposal.updateMany({
      where: { id: proposal.id, status: statusBefore },
      data: {
        status: 'APPLIED',
        undoSnapshot: before as unknown as Prisma.InputJsonValue,
        appliedAt: new Date(),
        appliedByUserId: userId,
        undoneAt: null,
        quotaPeriodKey: periodKey,
        changedCount: null,
        appliedHash: null,
      },
    });
    if (locked.count === 0) {
      // Ktoś zdążył pierwszy — jego zapis już zjadł kwotę, nasza wraca.
      await this.refundPlan(proposal.householdId, periodKey);
      return this.resultForApplied(await this.loadOwned(userId, proposalId));
    }

    const slots = readSlots(proposal.action);
    try {
      const result = await this.weeklyPlans.applyWeekPlan(
        userId,
        proposal.householdId,
        weekStart,
        { slots },
      );

      if (!result.applied) {
        await this.refundPlan(proposal.householdId, periodKey);
        await this.markStatus(proposal.id, 'STALE', { quotaPeriodKey: null });
        throw new AppException(
          'AI_PROPOSAL_STALE',
          'Tej propozycji nie da się już zapisać — plan albo przepisy zmieniły się w międzyczasie.',
          HttpStatus.CONFLICT,
          [
            'reason:VIOLATIONS',
            ...result.violations.map((violation) => violation.code),
          ],
        );
      }

      const changed =
        result.changes.created +
        result.changes.updated +
        result.changes.deleted;
      if (changed === 0) {
        // Zapis bez zmian nie kosztuje planu — i cofnięcie nie ma już czego
        // zwracać (`quotaPeriodKey` niżej zostaje puste).
        await this.refundPlan(proposal.householdId, periodKey);
      }

      const after = await this.weeklyPlans.snapshotWeekAsSlots(
        userId,
        proposal.householdId,
        weekStart,
      );
      const undoUntil = new Date(
        Date.now() + readAgentEnv().proposalUndoWindowMs,
      );
      const card = buildAppliedCard({
        proposalId: proposal.id,
        weekStart,
        changes: result.changes,
        undoUntil,
        canUndo: changed > 0,
      });

      const message = await this.writeMessage({
        conversationId: proposal.conversationId,
        kind: 'APPLIED',
        text: appliedMessageText({ weekStart, changes: result.changes }),
        card,
      });

      await this.prisma.agentProposal.update({
        where: { id: proposal.id },
        data: {
          appliedHash: weekBaselineHash(after),
          changedCount: changed,
          quotaPeriodKey: changed === 0 ? null : periodKey,
        },
      });

      this.broadcast(userId, proposal.householdId, weekStart);

      return {
        proposalId: proposal.id,
        status: 'APPLIED',
        message,
        changes: result.changes,
      };
    } catch (error) {
      if (error instanceof AppException) throw error;
      // Propozycja, która padła przy zapisie, nie wraca do klikania:
      // przycisk działający raz na dwa razy jest gorszy niż jego brak.
      await this.refundPlan(proposal.householdId, periodKey);
      await this.markStatus(proposal.id, 'FAILED', { quotaPeriodKey: null });
      throw error;
    }
  }

  /**
   * Cofnięcie zapisu — ponowne zastosowanie tygodnia sprzed kliknięcia.
   *
   * Nie liczymy odwrotnego diffa: `applyWeekPlan` przyjmuje STAN DOCELOWY,
   * więc operacja jest swoją własną odwrotnością. Druga ścieżka zapisu byłaby
   * drugim miejscem, w którym można się pomylić o cudzy tydzień.
   */
  async undo(
    userId: string,
    proposalId: string,
  ): Promise<ProposalActionResult> {
    const proposal = await this.loadOwned(userId, proposalId);
    await ensureMembership(this.prisma, userId, proposal.householdId);

    if (proposal.status === 'UNDONE') {
      return this.resultForUndone(proposal);
    }
    if (proposal.status !== 'APPLIED' || !proposal.appliedAt) {
      throw new AppException(
        'AI_PROPOSAL_STALE',
        'Nie ma czego cofać — ta propozycja nie została zapisana.',
        HttpStatus.CONFLICT,
        [`reason:${proposal.status}`],
      );
    }

    const window = readAgentEnv().proposalUndoWindowMs;
    if (proposal.appliedAt.getTime() + window <= Date.now()) {
      throw new AppException(
        'AI_PROPOSAL_EXPIRED',
        'Minął czas na cofnięcie tej zmiany.',
        HttpStatus.CONFLICT,
      );
    }

    // Zapis, który nie doszedł do odcisku (proces padł między zamkiem a
    // `appliedHash`), nie ma wiarygodnej migawki „po" — cofanie go
    // nadpisałoby tydzień stanem sprzed nieznanej liczby zmian.
    if (!proposal.appliedHash) {
      throw new AppException(
        'AI_PROPOSAL_STALE',
        'Ten zapis nie został domknięty, więc nie da się go bezpiecznie cofnąć. Popraw plan ręcznie.',
        HttpStatus.CONFLICT,
        ['reason:NOT_FINALISED'],
      );
    }

    const weekStart = toWeekStartString(proposal.weekStart);
    const current = await this.weeklyPlans.snapshotWeekAsSlots(
      userId,
      proposal.householdId,
      weekStart,
    );
    // Ktoś w domu poprawił tydzień PO zapisie — cofnięcie skasowałoby jego
    // pracę razem z naszą zmianą.
    if (weekBaselineHash(current) !== proposal.appliedHash) {
      throw new AppException(
        'AI_PROPOSAL_STALE',
        'Plan zmienił się po zapisaniu, więc cofnięcie skasowałoby także tamte zmiany.',
        HttpStatus.CONFLICT,
        ['reason:CHANGED_AFTER_APPLY'],
      );
    }

    const locked = await this.prisma.agentProposal.updateMany({
      where: { id: proposal.id, status: 'APPLIED' },
      data: { status: 'UNDONE', undoneAt: new Date() },
    });
    if (locked.count === 0) {
      return this.resultForUndone(await this.loadOwned(userId, proposalId));
    }

    const result = await this.weeklyPlans.applyWeekPlan(
      userId,
      proposal.householdId,
      weekStart,
      { slots: readSlots(proposal.undoSnapshot, 'slots-array') },
    );

    // Cofnięcie to korekta, nie nowy plan — kwota wraca, ale TYLKO ta,
    // która naprawdę zeszła, i do miesiąca, z którego zeszła (zapis 31.,
    // cofnięcie 1.). Zapis bez zmian już ją oddał i nie ma czego zwracać.
    if (proposal.quotaPeriodKey) {
      await this.refundPlan(proposal.householdId, proposal.quotaPeriodKey);
      await this.markStatus(proposal.id, 'UNDONE', { quotaPeriodKey: null });
    }

    const message = await this.writeMessage({
      conversationId: proposal.conversationId,
      kind: 'TEXT',
      text: `Cofnąłem zapis planu na tydzień od ${weekStartLabel(weekStart)}.`,
      card: null,
    });

    this.broadcast(userId, proposal.householdId, weekStart);

    return {
      proposalId: proposal.id,
      status: 'UNDONE',
      message,
      changes: result.changes,
    };
  }

  /**
   * Stan kart dla wiadomości — liczony PRZY ODCZYCIE, nigdy zapisywany.
   *
   * Karta w historii jest żywym sterownikiem, nie zdjęciem: po tygodniu, na
   * drugim telefonie i po ręcznej zmianie planu ma pokazywać prawdę o tym, czy
   * przycisk jeszcze cokolwiek zrobi. Zapisany stan zestarzałby się po cichu.
   */
  async cardStatesFor(
    messageIds: readonly string[],
  ): Promise<Map<string, AgentCardState>> {
    const ids = messageIds.filter(Boolean);
    if (ids.length === 0) return new Map();

    const proposals = await this.prisma.agentProposal.findMany({
      where: { messageId: { in: [...ids] } },
      select: {
        messageId: true,
        status: true,
        expiresAt: true,
        appliedAt: true,
        changedCount: true,
      },
    });

    const window = readAgentEnv().proposalUndoWindowMs;
    const now = Date.now();
    const states = new Map<string, AgentCardState>();

    for (const proposal of proposals) {
      if (!proposal.messageId) continue;
      states.set(proposal.messageId, cardState(proposal, now, window));
    }
    return states;
  }

  /**
   * Dokleja aktualny stan do kart w wiadomościach.
   *
   * Jedno zapytanie na stronę historii (najwyżej 100 wiadomości), więc odczyt
   * nie drożeje z długością rozmowy. Wiadomości bez karty przechodzą bez
   * zmian — nie ma po co ich dotykać.
   */
  async withCardState(messages: MessageView[]): Promise<MessageView[]> {
    const withCards = messages.filter((message) => message.card);
    if (withCards.length === 0) return messages;

    const states = await this.cardStatesFor(
      withCards.map((message) => message.id),
    );
    if (states.size === 0) return messages;

    return messages.map((message) => {
      const state = states.get(message.id);
      if (!state || !message.card) return message;
      return { ...message, card: { ...message.card, state } };
    });
  }

  // ─── Pomocnicze ───────────────────────────────────────────────────

  private async loadOwned(
    userId: string,
    proposalId: string,
  ): Promise<AgentProposal> {
    assertUuid(proposalId, 'proposalId');
    const proposal = await this.prisma.agentProposal.findFirst({
      where: {
        id: proposalId,
        userId,
        // Propozycja bez wiadomości nigdy nie trafiła na ekran (tura padła
        // w połowie) — nie ma czego zatwierdzać.
        messageId: { not: null },
      },
    });
    if (!proposal) {
      // 404, nie 403: cudza propozycja ma wyglądać tak samo jak nieistniejąca.
      throw new AppException(
        'AI_PROPOSAL_NOT_FOUND',
        'Nie znaleziono tej propozycji.',
        HttpStatus.NOT_FOUND,
      );
    }
    return proposal;
  }

  private async markStatus(
    id: string,
    status: string,
    extra: { quotaPeriodKey?: string | null } = {},
  ): Promise<void> {
    try {
      await this.prisma.agentProposal.update({
        where: { id },
        data: { status, ...extra },
      });
    } catch (error) {
      this.logger.warn(
        `nie udało się ustawić statusu propozycji: ${String(error)}`,
      );
    }
  }

  /** Zwrot kwoty planu — księgowość nie może wywrócić operacji użytkownika. */
  private async refundPlan(
    householdId: string,
    periodKey: string,
  ): Promise<void> {
    try {
      await this.counters.add(this.prisma, householdId, periodKey, 'plans', -1);
    } catch (error) {
      this.logger.warn(`nie udało się zwrócić kwoty planu: ${String(error)}`);
    }
  }

  private async writeMessage(input: {
    conversationId: string;
    kind: string;
    text: string;
    card: unknown;
  }): Promise<MessageView> {
    const message = await this.prisma.agentMessage.create({
      data: {
        conversationId: input.conversationId,
        role: 'ASSISTANT',
        kind: input.kind,
        text: input.text,
        // `turnId` celowo puste: to nie jest odpowiedź modelu, więc klient
        // odpytujący starą turę nie ma nagle dostawać drugiej wiadomości.
        ...(input.card ? { card: input.card as Prisma.InputJsonValue } : {}),
      },
    });
    await this.prisma.agentConversation.update({
      where: { id: input.conversationId },
      data: { lastMessageAt: message.createdAt },
    });

    return {
      id: message.id,
      role: message.role,
      kind: message.kind,
      text: message.text,
      clientMessageId: message.clientMessageId,
      turnId: message.turnId,
      createdAt: message.createdAt.toISOString(),
      card: (message.card ?? null) as MessageView['card'],
    };
  }

  private broadcast(
    userId: string,
    householdId: string,
    weekStart: string,
  ): void {
    try {
      this.plansGateway.broadcastWeekApplied({
        householdId,
        weekStart,
        changedByUserId: userId,
      });
    } catch (error) {
      // Rozgłoszenie jest wygodą, nie warunkiem poprawności zapisu.
      this.logger.warn(
        `nie udało się rozgłosić zapisu tygodnia: ${String(error)}`,
      );
    }
  }

  private async resultForApplied(
    proposal: AgentProposal,
  ): Promise<ProposalActionResult> {
    return {
      proposalId: proposal.id,
      status: 'APPLIED',
      message: await this.messageOf(proposal),
      changes: { created: 0, updated: 0, deleted: 0 },
    };
  }

  private async resultForUndone(
    proposal: AgentProposal,
  ): Promise<ProposalActionResult> {
    return {
      proposalId: proposal.id,
      status: 'UNDONE',
      message: await this.messageOf(proposal),
      changes: { created: 0, updated: 0, deleted: 0 },
    };
  }

  /**
   * Wiadomość TEJ propozycji: potwierdzenie zapisu (karta APPLIED z jej
   * identyfikatorem), a gdy go nie ma — wiadomość z propozycją. Nie „ostatnia
   * odpowiedź rozmowy": po tygodniu rozmowy to byłaby karta z innej tury.
   */
  private async messageOf(proposal: AgentProposal): Promise<MessageView> {
    const applied = await this.prisma.agentMessage.findFirst({
      where: {
        conversationId: proposal.conversationId,
        kind: 'APPLIED',
        card: { path: ['proposalId'], equals: proposal.id },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    const message =
      applied ??
      (proposal.messageId
        ? await this.prisma.agentMessage.findUnique({
            where: { id: proposal.messageId },
          })
        : null);
    return {
      id: message?.id ?? '',
      role: 'ASSISTANT',
      kind: message?.kind ?? 'TEXT',
      text: message?.text ?? '',
      clientMessageId: message?.clientMessageId ?? null,
      turnId: message?.turnId ?? null,
      createdAt: (message?.createdAt ?? new Date()).toISOString(),
      card: (message?.card ?? null) as MessageView['card'],
    };
  }
}

export type ProposalActionResult = {
  proposalId: string;
  status: 'APPLIED' | 'UNDONE';
  /** Wiadomość, która właśnie powstała — klient dokleja ją bez odpytywania. */
  message: MessageView;
  changes: { created: number; updated: number; deleted: number };
};

/** `Date` z bazy → `YYYY-MM-DD`, w UTC jak cały plan tygodnia. */
function toWeekStartString(value: Date): string {
  return value.toISOString().slice(0, 10);
}

/**
 * Stan docelowy z kolumny JSON.
 *
 * `action` trzyma `{ slots }`, a `undoSnapshot` samą tablicę — obie postacie
 * są własne, więc czytamy je jawnie zamiast ufać kształtowi.
 */
function readSlots(
  value: unknown,
  shape: 'wrapped' | 'slots-array' = 'wrapped',
): ApplyWeekSlotDto[] {
  if (shape === 'slots-array') {
    return Array.isArray(value) ? (value as ApplyWeekSlotDto[]) : [];
  }
  const wrapped = (value ?? {}) as { slots?: unknown };
  return Array.isArray(wrapped.slots)
    ? (wrapped.slots as ApplyWeekSlotDto[])
    : [];
}

/**
 * Stany, z których da się (ponownie) zapisać. STALE wymaga `force`
 * („Zapisz mimo to"); UNDONE i FAILED — zwykłego kliknięcia.
 */
export const REAPPLICABLE_STATUSES: ReadonlySet<string> = new Set([
  'PENDING',
  'UNDONE',
  'FAILED',
  'STALE',
]);

/** Reguły stanu karty — jedno miejsce, bo czyta je i lista, i pojedyncza tura. */
export function cardState(
  proposal: {
    status: string;
    expiresAt: Date;
    appliedAt: Date | null;
    /** `null` = zapis sprzed tej kolumny (traktowany jak „coś zmienił"). */
    changedCount?: number | null;
  },
  now: number,
  undoWindowMs: number,
): AgentCardState {
  if (proposal.status === 'APPLIED') {
    const until = proposal.appliedAt
      ? new Date(proposal.appliedAt.getTime() + undoWindowMs)
      : null;
    // Zapis bez zmian nie ma czego cofać — karta nie może obiecywać „Cofnij",
    // którego przycisk zapisu nie dostał.
    const hadChanges = (proposal.changedCount ?? 1) > 0;
    const canUndo = until ? until.getTime() > now && hadChanges : false;
    return {
      status: 'APPLIED',
      canApply: false,
      canUndo,
      until: until?.toISOString() ?? null,
    };
  }

  if (proposal.status === 'PENDING') {
    const expired = proposal.expiresAt.getTime() <= now;
    return {
      status: expired ? 'EXPIRED' : 'PENDING',
      canApply: !expired,
      canUndo: false,
      until: proposal.expiresAt.toISOString(),
    };
  }

  const status = (['UNDONE', 'STALE', 'EXPIRED', 'FAILED'] as const).includes(
    proposal.status as 'UNDONE',
  )
    ? (proposal.status as AgentCardState['status'])
    : 'STALE';
  // Ponowny zapis (UNDONE/FAILED) i „Zapisz mimo to" (STALE) żyją tak długo,
  // jak sama propozycja — po 72 h karta mówi EXPIRED bez przycisku.
  const expired = proposal.expiresAt.getTime() <= now;
  const reapplicable =
    status !== 'EXPIRED' && REAPPLICABLE_STATUSES.has(status) && !expired;
  return {
    // Po 72 h każda z tych kart mówi EXPIRED — bez przycisku.
    status: expired ? 'EXPIRED' : status,
    canApply: reapplicable,
    canUndo: false,
    until: reapplicable ? proposal.expiresAt.toISOString() : null,
  };
}
