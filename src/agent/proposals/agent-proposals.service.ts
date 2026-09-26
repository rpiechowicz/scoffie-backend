import { memoized, TURN_KEYS, TurnMemo } from '../turn-memo';
import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { AgentProposal, Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { ConsentsService } from '../../consents/consents.service';
import { HouseholdsService } from '../../households/households.service';
import {
  PlanViolation,
  WeeklyPlansService,
} from '../../weekly-plans/weekly-plans.service';
import { WeeklyPlansGateway } from '../../weekly-plans/weekly-plans.gateway';
import { ApplyWeekSlotDto } from '../../weekly-plans/dto/apply-week-plan.dto';
import { ensureMembership } from '../../weekly-plans/utils/auth-checks.util';
import { AppException } from '../../common/app-exception';
import { assertUuid, isUuid } from '../../common/uuid';
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
import { buildRemoveMealCard } from '../cards/remove-meal-card';
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
import { AgentQuotaMailService } from '../agent-quota-mail.service';
import { weekBaselineHash } from './proposal-baseline';
import type { MessageView } from '../agent-conversations.service';

export type CreateWeekProposalInput = {
  userId: string;
  householdId: string;
  /** Pamięć tury (Etap 3.7) — domownicy i pory czytane raz na turę. */
  memo?: TurnMemo;
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

/**
 * Poprawka JEDNEGO slotu w propozycji planu z tej rozmowy (`revise_proposal`).
 * Tydzień, dzień propozycji i pozostałe pozycje bierze serwis z propozycji.
 */
export type ReviseProposalInput = Omit<
  CreateWeekProposalInput,
  'slots' | 'note' | 'weekStart' | 'removalReasons'
> & {
  proposalId: string;
  dayOfWeek: DayOfWeek;
  mealType: MealType;
  recipeId: string;
  /**
   * Porcje łączne nowego dania — gdy dobrał je serwerowy planer
   * (`replace_plan_item`). Brak = jak dotąd: porcje zostają przy podmianie
   * jednej pozycji, przy scaleniu kilku liczy je audytorium.
   */
  plannedServings?: number;
  /** Porcje per osoba nowego dania (Etap 2.2) — gdy dobrał je planer. */
  portions?: { userId: string; servings: number }[];
};

/** Propozycja planu, która czeka na zatwierdzenie — do poprawek jednego slotu. */
export type PendingPlanProposal = {
  kind: 'PLAN_WEEK' | 'PLAN_DAY';
  weekStart: string;
  /** Stan docelowy tygodnia (`action.slots`). */
  slots: ApplyWeekSlotDto[];
  /** Dzień propozycji dnia; `null` przy tygodniu. */
  day: DayOfWeek | null;
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
  /** Porcje per osoba nowego dania (Etap 2.2, tylko podmiana całego slotu). */
  portions?: { userId: string; servings: number }[];
};

export type CreateRemoveProposalInput = Omit<
  CreateWeekProposalInput,
  'slots' | 'note'
> & {
  dayOfWeek: DayOfWeek;
  mealType: MealType;
  /** Co stoi w tym slocie — rozwiązuje executor, bo to on zna katalog. */
  removed: SwapCardSide;
  /** Czego chciał użytkownik („nie będzie nas w domu”). */
  reason?: string;
  /**
   * KOMU to danie znika. Puste = całemu domowi, czyli pozycja wypada z planu.
   * Podane = wypisujemy z niej te osoby, a pozycja zostaje dla reszty.
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
    private readonly quotaMail: AgentQuotaMailService,
    private readonly plansGateway: WeeklyPlansGateway,
    private readonly consents: ConsentsService,
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
        input.memo,
      ),
      expiresAt,
      forUserId: input.userId,
      enabledMealTypes: await this.enabledMealTypesFor(
        input.householdId,
        input.memo,
      ),
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
        input.memo,
      ),
      expiresAt,
      forUserId: input.userId,
      enabledMealTypes: await this.enabledMealTypesFor(
        input.householdId,
        input.memo,
      ),
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
   * Poprawka jednej pozycji w propozycji planu, która czeka na zatwierdzenie
   * („zamień tylko wtorkowy obiad", „Wybieram: …" po zamiennikach).
   *
   * Do 26.09.2026 jedyną drogą była NOWA propozycja od zera: model musiał
   * odtworzyć cały tydzień z pamięci, żeby zmienić jedno danie, a każda
   * pozycja, której nie przepisał dokładnie, zmieniała się po cichu. Teraz
   * resztę bierzemy z INTENCJI tamtej propozycji (`action.slots` — stan
   * docelowy zapisany przez serwer), podmieniamy CAŁY slot (dzień + posiłek)
   * na jedno danie i liczymy nową propozycję tą samą ścieżką, co zwykle:
   * walidacja alergenów, karta, odcisk planu. Uczestnicy nowego dania to suma
   * uczestników podmienionych pozycji, a gdy którakolwiek była dla całego
   * domu — cały dom; porcje zostają tylko przy podmianie jednej pozycji
   * (przy scaleniu kilku liczy je audytorium).
   *
   * Starej propozycji nie oznaczamy: obie mają odcisk planu z chwili
   * powstania, więc zatwierdzenie jednej robi z drugiej STALE samo z siebie.
   * Propozycja dnia zostaje propozycją dnia i poprawia się tylko w swoim dniu.
   */
  async reviseProposal(
    input: ReviseProposalInput,
  ): Promise<CreateWeekProposalResult> {
    const pending = await this.loadPendingPlanProposal(input);
    const { weekStart, slots } = pending;
    const isTarget = (slot: ApplyWeekSlotDto) =>
      slot.dayOfWeek === input.dayOfWeek && slot.mealType === input.mealType;
    const replaced = slots.filter(isTarget);
    const wholeHouse =
      replaced.length === 0 ||
      replaced.some((slot) => !slot.participantIds?.length);
    const participantIds = wholeHouse
      ? []
      : [...new Set(replaced.flatMap((slot) => slot.participantIds ?? []))];
    const keptServings =
      input.plannedServings ??
      (replaced.length === 1 ? replaced[0].plannedServings : undefined);
    const next: ApplyWeekSlotDto = {
      dayOfWeek: input.dayOfWeek,
      mealType: input.mealType,
      recipeId: input.recipeId,
      ...(participantIds.length > 0 ? { participantIds } : {}),
      ...(keptServings !== undefined ? { plannedServings: keptServings } : {}),
      // Porcje per osoba z planera (Etap 2.2) — źródło prawdy nowej pozycji.
      ...(input.portions?.length ? { portions: input.portions } : {}),
    };
    // Nowa pozycja w miejscu pierwszej podmienionej — karta i odcisk nie
    // zależą od kolejności, ale czytelny zapis intencji tak.
    const revised: ApplyWeekSlotDto[] = [];
    for (const slot of slots) {
      if (!isTarget(slot)) revised.push(slot);
      else if (!revised.includes(next)) revised.push(next);
    }
    if (!revised.includes(next)) revised.push(next);

    const base = {
      userId: input.userId,
      householdId: input.householdId,
      memo: input.memo,
      conversationId: input.conversationId,
      turnId: input.turnId,
      weekStart,
    };
    if (pending.kind === 'PLAN_DAY') {
      const day = pending.day;
      if (!day || day !== input.dayOfWeek) {
        throw new AppException(
          'VALIDATION_ERROR',
          `Ta propozycja dotyczy jednego dnia (${day ?? '?'}) — poprawiasz w niej tylko ten dzień.`,
          HttpStatus.BAD_REQUEST,
          ['day_of_week'],
        );
      }
      return this.createDayPlanProposal({
        ...base,
        dayOfWeek: day,
        slots: revised
          .filter((slot) => slot.dayOfWeek === day)
          .map(({ dayOfWeek: _day, ...slot }) => slot),
      });
    }
    return this.createWeekPlanProposal({ ...base, slots: revised });
  }

  /**
   * Propozycja planu (tydzień albo dzień) z TEJ rozmowy i TEGO domu, która
   * czeka na zatwierdzenie — wspólny odczyt dla `revise_proposal`
   * i `replace_plan_item`. Cudza, obca rozmowa, zła forma numeru: NOT_FOUND;
   * zatwierdzona/nieaktualna: STALE; po terminie: EXPIRED.
   */
  async loadPendingPlanProposal(input: {
    proposalId: string;
    conversationId: string;
    householdId: string;
  }): Promise<PendingPlanProposal> {
    const notFound = () =>
      new AppException(
        'AI_PROPOSAL_NOT_FOUND',
        'Nie ma takiej propozycji planu w tej rozmowie. Numer weź z dopisku [Propozycja …] w historii.',
        HttpStatus.NOT_FOUND,
      );
    if (!isUuid(input.proposalId)) throw notFound();
    const source = await this.prisma.agentProposal.findFirst({
      where: {
        id: input.proposalId,
        conversationId: input.conversationId,
        householdId: input.householdId,
      },
      select: {
        kind: true,
        status: true,
        expiresAt: true,
        weekStart: true,
        action: true,
        card: true,
      },
    });
    if (
      !source ||
      (source.kind !== 'PLAN_WEEK' && source.kind !== 'PLAN_DAY')
    ) {
      throw notFound();
    }
    if (source.status !== 'PENDING') {
      throw new AppException(
        'AI_PROPOSAL_STALE',
        `Ta propozycja nie czeka już na zatwierdzenie (${source.status}). Zmianę w zapisanym planie pokaż przez propose_swap.`,
        HttpStatus.CONFLICT,
      );
    }
    if (source.expiresAt && source.expiresAt.getTime() <= Date.now()) {
      throw new AppException(
        'AI_PROPOSAL_EXPIRED',
        'Ta propozycja wygasła. Ułóż nową.',
        HttpStatus.CONFLICT,
      );
    }
    const weekStart = source.weekStart.toISOString().slice(0, 10);
    return {
      kind: source.kind,
      weekStart,
      slots: actionSlots(source.action),
      day:
        source.kind === 'PLAN_DAY'
          ? dayOfDayCard(source.card, weekStart)
          : null,
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
          ...(input.portions?.length ? { portions: input.portions } : {}),
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
        input.memo,
      );
      const leaving = new Set(input.participantIds);
      const narrowed = standing
        .map((slot) => {
          const current = slot.participantIds?.length
            ? slot.participantIds
            : everyone;
          const remaining = current.filter((userId) => !leaving.has(userId));
          return narrowSlot(slot, remaining);
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
        input.memo,
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
   * Usunięcie jednego posiłku — przez ten sam stan docelowy, co każdy zapis.
   *
   * Po co osobna droga, skoro `apply_week_plan` to potrafi: bo potrafi to
   * WYŁĄCZNIE przez podanie całego tygodnia od nowa. Model, który chce
   * skasować czwartkową kolację, musi wypisać dwadzieścia pozostałych pozycji
   * bezbłędnie — a każda pominięta znika razem z nią, po cichu i bez śladu
   * w karcie. Tutaj baseline bierze serwer, a model podaje jeden slot.
   *
   * Wypisanie OSOBY nie jest usunięciem posiłku: przy podanych uczestnikach
   * pozycja zostaje dla reszty domu i znika dopiero wtedy, gdy nie zostaje
   * przy niej nikt. Ta sama reguła, co przy podmianie dla wybranych osób —
   * inaczej „nie będę jadł tej kolacji" zabierałoby ją całemu domowi.
   */
  async createRemoveMealProposal(
    input: CreateRemoveProposalInput,
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
      merged = untouched;
    } else {
      const everyone = await this.householdMemberIds(
        input.userId,
        input.householdId,
        input.memo,
      );
      const leaving = new Set(input.participantIds);
      const narrowed = standing
        .map((slot) => {
          const current = slot.participantIds?.length
            ? slot.participantIds
            : everyone;
          const remaining = current.filter((userId) => !leaving.has(userId));
          return narrowSlot(slot, remaining);
        })
        .filter((slot): slot is ApplyWeekSlotDto => slot !== null);
      merged = [...untouched, ...narrowed];
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

    const card = buildRemoveMealCard({
      forNames: await this.displayNames(
        input.userId,
        input.householdId,
        input.participantIds,
        input.memo,
      ),
      proposalId,
      weekStart: input.weekStart,
      date: dateForDay(input.weekStart, input.dayOfWeek),
      dayOfWeek: input.dayOfWeek,
      mealType: input.mealType,
      removed: input.removed,
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
        kind: 'REMOVE_MEAL',
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
        meals: 0,
        created: preview.changes.created,
        updated: preview.changes.updated,
        removed: preview.changes.deleted,
        // Ta karta nie mówi o kaloriach dnia i model nie ma czego tu cytować:
        // po usunięciu jednej pozycji średnia tygodnia jest liczbą o czymś
        // innym niż pytanie, które padło.
        averageKcalPerDay: 0,
        targetKcalPerDay: null,
      },
    };
  }

  /**
   * Domownicy ze zgodą na asystenta — ta sama reguła, co
   * `AgentPromptService.membersForModel`, w miejscu, które nie może na tamten
   * serwis polecieć (zależność szłaby pod prąd grafu modułów). Przy
   * `AI_CONSENT_REQUIRED=false` reguła nie obowiązuje i wszyscy przechodzą.
   */
  private async membersWithConsent<T extends { userId: string }>(
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
    // Talerz może dostać tylko domownik, który zgodził się na asystenta.
    //
    // AUDYT 12.09.2026 (P1.10). Bramka sprawdzała samo członkostwo. Dziś nikt
    // tędy nie przejdzie, bo model nie zna identyfikatora osoby bez zgody —
    // `get_household_context` i rzut planu odfiltrowują takie osoby, zanim
    // cokolwiek do niego trafi. Ale to znaczy, że jedyną ochroną była
    // NIEZNAJOMOŚĆ UUID-a, a nie sprawdzenie. Karta niesie obok imienia cel
    // kaloryczny i alergeny, czyli dokładnie to, czego brak zgody zabrania
    // pokazywać; taka bramka ma stać na regule, nie na tym, czego model
    // przypadkiem nie widział.
    const { members: allowed } = await this.membersWithConsent(members);
    const known = new Map(allowed.map((member) => [member.userId, member]));
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
    memo?: TurnMemo,
  ): Promise<string[]> {
    const members = await this.members(userId, householdId, memo);
    return members.map((member) => member.userId);
  }

  /** Domownicy z celami — raz na turę, jak prompt i narzędzia (`TurnMemo`). */
  private members(userId: string, householdId: string, memo?: TurnMemo) {
    return memoized(memo, TURN_KEYS.members(userId, householdId), () =>
      this.households.memberPreferences(userId, householdId),
    );
  }

  /** Imiona do karty — „dla Rafała" czyta się, „dla 3fa85f64…" nie. */
  private async displayNames(
    userId: string,
    householdId: string,
    ids: readonly string[],
    memo?: TurnMemo,
  ): Promise<string[]> {
    if (ids.length === 0) return [];
    try {
      const members = await this.members(userId, householdId, memo);
      return members
        .filter((member) => ids.includes(member.userId))
        .map((member) => member.displayName);
    } catch {
      return [];
    }
  }

  /** Sloty, które ten dom planuje — nota celu ma sens tylko dla pełnego dnia. */
  private async enabledMealTypesFor(
    householdId: string,
    memo?: TurnMemo,
  ): Promise<string[]> {
    try {
      // Ten sam wiersz i klucz, co prompt tury (`TURN_KEYS.household`).
      const household = await memoized(
        memo,
        TURN_KEYS.household(householdId),
        () =>
          this.prisma.household.findUnique({
            where: { id: householdId },
            select: { name: true, enabledMealTypes: true },
          }),
      );
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
    memo?: TurnMemo,
  ): Promise<number | null> {
    try {
      const members = await this.members(userId, householdId, memo);
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
    // Członkostwo mogło się zmienić między propozycją a kliknięciem. To jest
    // szybka odmowa; wiążąca kontrola biegnie jeszcze raz pod zamkiem tygodnia
    // w `applyWeekPlan` (`ensureMembershipInTx`).
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
    // STALE bez `force` to odmowa, nawet gdy odcisk tygodnia wrócił do stanu
    // z propozycji: STALE znaczy też „pytanie poprawione" (`editMessage`), a
    // tego odcisk planu nie widzi. Telefon wysyła z karty STALE wyłącznie
    // „Zapisz mimo to" (`force: true`), więc kontrakt się nie zmienia.
    if (proposal.status === 'STALE' && !options.force) {
      throw new AppException(
        'AI_PROPOSAL_STALE',
        'Ta propozycja jest już nieaktualna. Poproś asystenta o nową.',
        HttpStatus.CONFLICT,
        ['reason:STALE'],
      );
    }
    const statusBefore = proposal.status;
    if (proposal.expiresAt.getTime() <= Date.now()) {
      await this.markStatusFrom(proposal.id, statusBefore, 'EXPIRED');
      throw new AppException(
        'AI_PROPOSAL_EXPIRED',
        'Ta propozycja wygasła. Poproś asystenta o nową.',
        HttpStatus.CONFLICT,
      );
    }

    // Zakres i limit kwoty liczone PRZED transakcją (to odczyt planu domu,
    // nie blokada); samo zdjęcie kwoty zapada w transakcji zapisu niżej.
    // Zakres ten sam, co przy wiadomościach: `sub:<id>` przy subskrypcji,
    // `trial:<hasz>` na próbie, dom przy nadaniu operatora.
    const plan = await this.counters.resolvePlan(proposal.householdId, {
      userId,
    });
    const periodKey = plan.periodKey;
    const scopeId = plan.quotaScopeId;
    const limit = plan.plansLimit;
    const weekStart = toWeekStartString(proposal.weekStart);
    const messageId = proposal.messageId;

    // JEDNA transakcja na cały zapis — ta, w której domena zapisuje plan.
    //
    // Historia: do 21.09.2026 zapis szedł czterema krokami poza transakcją
    // planu: kwota → status APPLIED → plan → wiadomość i odcisk. Każda przerwa
    // zostawiała inny kłopot: odmowa członkostwa pod zamkiem zostawiała
    // propozycję APPLIED ze zjedzoną kwotą i bez planu; błąd zapisu wiadomości
    // po zatwierdzonym planie oznaczał propozycję FAILED i oddawał kwotę, choć
    // plan się zmienił; zwrot kwoty połykał błędy, więc przegrany wyścig
    // potrafił ją zgubić; odcisk sprawdzany przed zamkiem przepuszczał cudzy
    // zapis wciśnięty między kontrolę a zapis.
    //
    // Teraz, jak w `undo`, `guard` i `settle` biegną POD ZAMKIEM TYGODNIA,
    // w transakcji zapisu, w każdej jej próbie od nowa:
    //  1. przejęcie propozycji ze statusu, który widzieliśmy — przegrany
    //     wyścig (drugi klik, drugi telefon) odpada, zanim dotknie planu,
    //     kwoty albo rozmowy;
    //  2. pytanie, z którego propozycja wyszła, nie jest wycofane;
    //  3. odcisk tygodnia odczytanego pod zamkiem (chyba że `force`);
    //  4. zapis pozycji (domena, z członkostwem sprawdzonym pod zamkiem);
    //  5. kwota, wiadomość, odcisk „po" i domknięcie propozycji.
    // Wszystko zatwierdza się razem albo wcale, więc nie ma stanu APPLIED bez
    // planu, planu bez APPLIED, kwoty bez zapisu ani potwierdzenia bez zmiany.
    let message: MessageView | null = null;
    let result: Awaited<ReturnType<WeeklyPlansService['applyWeekPlan']>>;
    try {
      result = await this.weeklyPlans.applyWeekPlan(
        userId,
        proposal.householdId,
        weekStart,
        { slots: readSlots(proposal.action) },
        {
          guard: async (tx, current) => {
            const claimed = await tx.agentProposal.updateMany({
              where: { id: proposal.id, status: statusBefore },
              data: {
                status: 'APPLIED',
                // „Stan sprzed" z tygodnia odczytanego POD ZAMKIEM — migawka
                // spoza transakcji mogła już nie być prawdą, a „Cofnij"
                // przywróciłby wtedy cudzy tydzień.
                undoSnapshot: current as unknown as Prisma.InputJsonValue,
                appliedAt: new Date(),
                appliedByUserId: userId,
                undoneAt: null,
                quotaPeriodKey: null,
                quotaScopeId: null,
                changedCount: null,
                appliedHash: null,
              },
            });
            if (claimed.count === 0) throw new ProposalSuperseded();
            // Pytanie poprawione po propozycji (`editMessage` ukrywa wszystko
            // od niego w dół): zapis planu, którego nikt już nie chce. Pod
            // zamkiem, bo karta mogła zostać na drugim telefonie, a `force`
            // tego nie omija — pomija wyłącznie odcisk planu.
            const source = messageId
              ? await tx.agentMessage.findUnique({
                  where: { id: messageId },
                  select: { hiddenAt: true },
                })
              : null;
            if (!source || source.hiddenAt) {
              throw new ProposalRefused(
                'WITHDRAWN',
                'Pytanie, na które odpowiadała ta propozycja, zostało poprawione. Poproś asystenta o nową.',
              );
            }
            // `force` pomija TYLKO to porównanie: użytkownik widział na karcie,
            // że plan się zmienił, i świadomie zapisuje. Walidacja domeny
            // (alergeny, wykluczenia, członkostwo) biegnie tak samo jak zawsze.
            if (
              !options.force &&
              weekBaselineHash(current) !== proposal.baselineHash
            ) {
              throw new ProposalRefused(
                'CHANGED',
                'Plan tygodnia zmienił się od czasu tej propozycji. Poproś asystenta o nową.',
              );
            }
          },
          settle: async (tx, changes) => {
            const changed = changes.created + changes.updated + changes.deleted;
            // Zapis bez zmian nie kosztuje planu — kwota nawet nie schodzi,
            // a cofnięcie nie ma czego zwracać (klucze kwoty zostają puste).
            if (changed > 0) {
              const consumed = await this.counters.tryConsume(
                tx,
                scopeId,
                periodKey,
                'plans',
                limit,
              );
              if (!consumed) throw new PlanQuotaExhausted();
            }

            const after = await this.weeklyPlans.snapshotWeekAsSlots(
              userId,
              proposal.householdId,
              weekStart,
              tx,
            );
            const card = buildAppliedCard({
              proposalId: proposal.id,
              weekStart,
              changes,
              undoUntil: new Date(
                Date.now() + readAgentEnv().proposalUndoWindowMs,
              ),
              canUndo: changed > 0,
            });
            // Nadpisywane w każdej próbie — wiadomości z wycofanych prób
            // nie istnieją, zostaje ta z zatwierdzonej.
            message = await this.writeMessage(
              {
                conversationId: proposal.conversationId,
                kind: 'APPLIED',
                text: appliedMessageText({ weekStart, changes }),
                card,
              },
              tx,
            );
            await tx.agentProposal.update({
              where: { id: proposal.id },
              data: {
                appliedHash: weekBaselineHash(after),
                changedCount: changed,
                quotaPeriodKey: changed === 0 ? null : periodKey,
                quotaScopeId: changed === 0 ? null : scopeId,
              },
            });
          },
        },
      );
    } catch (error) {
      if (error instanceof ProposalSuperseded) {
        // Przegrany wyścig: plan, kwota i rozmowa nietknięte. Równoległy
        // zapis TEJ SAMEJ propozycji to dwa dotknięcia przycisku — ten sam
        // wynik. Wszystko inne (np. cofnięcie w międzyczasie) to odmowa.
        const latest = await this.loadOwned(userId, proposalId);
        if (latest.status === 'APPLIED') return this.resultForApplied(latest);
        throw new AppException(
          'AI_PROPOSAL_STALE',
          'Ta propozycja zmieniła stan w trakcie zapisu. Odśwież rozmowę i spróbuj ponownie.',
          HttpStatus.CONFLICT,
          [`reason:${latest.status}`],
        );
      }
      if (error instanceof ProposalRefused) {
        await this.markStatusFrom(proposal.id, statusBefore, 'STALE');
        throw new AppException(
          'AI_PROPOSAL_STALE',
          error.message,
          HttpStatus.CONFLICT,
          [`reason:${error.reason}`],
        );
      }
      if (error instanceof PlanQuotaExhausted) {
        // Transakcja jest już wycofana — kolejkowanie maila przed rzutem
        // nie ma czego wycofać.
        await this.quotaMail.announce(userId, plan, 'plans');
        throw new AppException(
          'AI_PLAN_QUOTA_EXCEEDED',
          plan.tier === 'TRIAL'
            ? `Darmowy zapis planu na próbę (${limit}) jest wykorzystany. Wybierz plan, żeby mieć pulę miesięczną dla całego domu.`
            : `Limit zapisanych planów w tym okresie (${limit}) został wyczerpany.`,
          HttpStatus.TOO_MANY_REQUESTS,
          this.counters.quotaDetailsFor('plans', plan),
        );
      }
      // Odmowa domeny rzucona wyjątkiem (np. `NOT_HOUSEHOLD_MEMBER` pod
      // zamkiem po wyrzuceniu z domu) nie jest awarią: status zostaje, jaki
      // był. Awaria techniczna — FAILED („Spróbuj ponownie"). W obu razach
      // transakcja jest wycofana w całości, więc kwota nie zeszła, a błąd
      // idzie dalej bez zmian.
      if (!(error instanceof AppException)) {
        await this.markStatusFrom(proposal.id, statusBefore, 'FAILED');
      }
      throw error;
    }

    if (!result.applied || !message) {
      // Naruszenia domeny zapadają PRZED transakcją, więc haki nie biegły:
      // nic nie zostało przejęte ani zdjęte.
      await this.markStatusFrom(proposal.id, statusBefore, 'STALE');
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

    // Rozgłoszenie dopiero PO zatwierdzeniu i raz — nie z haka, który biegnie
    // w każdej próbie transakcji.
    this.broadcast(userId, proposal.householdId, weekStart);

    return {
      proposalId: proposal.id,
      status: 'APPLIED',
      message,
      changes: result.changes,
    };
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
    // To samo przy braku migawki „przed": `readSlots` oddałby pustą listę,
    // a stan docelowy „nic" wyczyściłby cały tydzień i ogłosił to cofnięciem.
    if (!proposal.appliedHash || !Array.isArray(proposal.undoSnapshot)) {
      throw new AppException(
        'AI_PROPOSAL_STALE',
        'Ten zapis nie został domknięty, więc nie da się go bezpiecznie cofnąć. Popraw plan ręcznie.',
        HttpStatus.CONFLICT,
        ['reason:NOT_FINALISED'],
      );
    }

    const weekStart = toWeekStartString(proposal.weekStart);
    const { appliedAt, appliedHash } = proposal;

    // JEDNA transakcja na całe cofnięcie — ta, w której domena zapisuje plan.
    //
    // Historia: do 21.09.2026 status UNDONE zapadał PRZED zapisem planu
    // (fałszywy sukces przy odmowie domeny); pierwsza poprawka odwróciła
    // kolejność, ale zostawiła warunki po stronie wołającego: między kontrolą
    // odcisku a zapisem mieścił się cudzy zapis, więc spóźnione cofnięcie
    // nadpisywało ręczną edycję albo ponowny zapis propozycji, a dopiero potem
    // dowiadywało się, że przegrało. Zwrot kwoty szedł osobno, po wyzerowaniu
    // klucza — awaria między nimi gubiła go na stałe.
    //
    // Teraz `guard` i `settle` biegną POD ZAMKIEM TYGODNIA, w transakcji
    // zapisu, i w każdej jej próbie od nowa:
    //  1. przejęcie TEGO zapisu (status + `appliedAt`) — kto przegrał wyścig
    //     albo spóźnił się o cykl „cofnij → zapisz ponownie", odpada, zanim
    //     dotknie planu;
    //  2. odcisk tygodnia odczytanego pod zamkiem — cudza edycja = odmowa;
    //  3. zapis pozycji (domena);
    //  4. zwrot kwoty i wiadomość.
    // Wszystko zatwierdza się razem albo wcale: nie ma stanu „cofnięte bez
    // zwrotu" ani „zwrócone bez cofnięcia", więc ponowienie po awarii jest
    // zwykłym cofnięciem, a po sukcesie — odczytem gotowego wyniku.
    let message: MessageView | null = null;
    let result: Awaited<ReturnType<WeeklyPlansService['applyWeekPlan']>>;
    try {
      result = await this.weeklyPlans.applyWeekPlan(
        userId,
        proposal.householdId,
        weekStart,
        { slots: readSlots(proposal.undoSnapshot, 'slots-array') },
        {
          guard: async (tx, current) => {
            const claimed = await tx.agentProposal.updateMany({
              where: { id: proposal.id, status: 'APPLIED', appliedAt },
              data: {
                status: 'UNDONE',
                undoneAt: new Date(),
                quotaPeriodKey: null,
                quotaScopeId: null,
              },
            });
            if (claimed.count === 0) throw new UndoSuperseded();
            // Ktoś w domu poprawił tydzień PO zapisie — cofnięcie skasowałoby
            // jego pracę razem z naszą zmianą.
            if (weekBaselineHash(current) !== appliedHash) {
              throw new AppException(
                'AI_PROPOSAL_STALE',
                'Plan zmienił się po zapisaniu, więc cofnięcie skasowałoby także tamte zmiany.',
                HttpStatus.CONFLICT,
                ['reason:CHANGED_AFTER_APPLY'],
              );
            }
          },
          settle: async (tx) => {
            // Cofnięcie to korekta, nie nowy plan — kwota wraca, ale TYLKO ta,
            // która naprawdę zeszła, do zakresu i okresu z chwili ZAPISU
            // (zapis 31., cofnięcie 1.; subskrypcja, która zdążyła wygasnąć).
            // Zapis bez zmian już ją oddał. Bez `try/catch`: błąd licznika
            // wycofuje całe cofnięcie, zamiast po cichu zgubić zwrot.
            if (proposal.quotaPeriodKey) {
              await this.counters.add(
                tx,
                proposal.quotaScopeId ?? proposal.householdId,
                proposal.quotaPeriodKey,
                'plans',
                -1,
              );
            }
            // Nadpisywane w każdej próbie — wiadomości z wycofanych prób
            // nie istnieją, zostaje ta z zatwierdzonej.
            message = await this.writeMessage(
              {
                conversationId: proposal.conversationId,
                kind: 'TEXT',
                text: `Cofnąłem zapis planu na tydzień od ${weekStartLabel(weekStart)}.`,
                card: null,
              },
              tx,
            );
          },
        },
      );
    } catch (error) {
      if (!(error instanceof UndoSuperseded)) throw error;
      // Przegrany wyścig: plan nietknięty. Równoległe cofnięcie TEGO SAMEGO
      // zapisu to odpowiedź na dwa dotknięcia przycisku — ten sam wynik.
      // Wszystko inne (np. nowszy zapis) to uczciwa odmowa.
      const latest = await this.loadOwned(userId, proposalId);
      if (latest.status === 'UNDONE') return this.resultForUndone(latest);
      throw new AppException(
        'AI_PROPOSAL_STALE',
        'Ta propozycja zmieniła stan w trakcie cofania. Odśwież rozmowę i spróbuj ponownie.',
        HttpStatus.CONFLICT,
        [`reason:${latest.status}`],
      );
    }

    if (!result.applied || !message) {
      // Odmowa domeny zapada PRZED transakcją, więc haki nie biegły:
      // propozycja zostaje APPLIED — bo plan nadal jest taki, jak go zapisała.
      throw new AppException(
        'AI_PROPOSAL_STALE',
        'Nie da się już przywrócić poprzedniego planu — preferencje domowników albo przepisy zmieniły się od zapisu. Popraw plan ręcznie.',
        HttpStatus.CONFLICT,
        [
          'reason:VIOLATIONS',
          ...result.violations.map((violation) => violation.code),
        ],
      );
    }

    // Rozgłoszenie dopiero PO zatwierdzeniu i raz — nie z haka, który biegnie
    // w każdej próbie transakcji.
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

  /**
   * Oznaczenie propozycji po odmowie albo awarii — WARUNKOWE, ze statusu,
   * który widzieliśmy. Bez warunku spóźniona odmowa nadpisałaby cudzy,
   * zatwierdzony już zapis (APPLIED → STALE przy planie, który się zmienił).
   *
   * To księgowość karty, nie poprawność zapisu: transakcja jest już wycofana,
   * a status sprzed niej jest bezpieczny (zapis sprawdzi wszystko od nowa).
   * Dlatego błąd tutaj tylko logujemy — i nigdy nie zasłania on błędu, który
   * wołający i tak rzuca dalej.
   */
  private async markStatusFrom(
    id: string,
    from: string,
    status: string,
  ): Promise<void> {
    try {
      await this.prisma.agentProposal.updateMany({
        where: { id, status: from },
        data: { status },
      });
    } catch (error) {
      this.logger.warn(
        `nie udało się ustawić statusu propozycji: ${String(error)}`,
      );
    }
  }

  private async writeMessage(
    input: {
      conversationId: string;
      kind: string;
      text: string;
      card: unknown;
    },
    client: Prisma.TransactionClient = this.prisma,
  ): Promise<MessageView> {
    const message = await client.agentMessage.create({
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
    await client.agentConversation.update({
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

/** Sygnał z `guard`: TEN zapis propozycji przejął już ktoś inny. */
class UndoSuperseded extends Error {}

/** Sygnał z `guard` zapisu: propozycję przejął już ktoś inny. */
class ProposalSuperseded extends Error {}

/** Sygnał z `guard` zapisu: propozycja nieaktualna (powód w `details`). */
class ProposalRefused extends Error {
  constructor(
    readonly reason: 'CHANGED' | 'WITHDRAWN',
    message: string,
  ) {
    super(message);
  }
}

/** Sygnał z `settle` zapisu: kwota planów wyczerpana — wycofaj wszystko. */
class PlanQuotaExhausted extends Error {}

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

/**
 * Stan docelowy propozycji tygodnia/dnia z `action` (zapisuje go serwer, nie
 * model). Wiersz bez listy — pusta, czyli „w propozycji nic nie ma".
 */
function actionSlots(action: Prisma.JsonValue): ApplyWeekSlotDto[] {
  const slots =
    action && typeof action === 'object' && !Array.isArray(action)
      ? (action as { slots?: unknown }).slots
      : undefined;
  return Array.isArray(slots) ? (slots as ApplyWeekSlotDto[]) : [];
}

/** Dzień propozycji dnia z daty w karcie (`YYYY-MM-DD` w tygodniu `weekStart`). */
function dayOfDayCard(
  card: Prisma.JsonValue,
  weekStart: string,
): DayOfWeek | null {
  const date =
    card && typeof card === 'object' && !Array.isArray(card)
      ? (card as { date?: unknown }).date
      : undefined;
  if (typeof date !== 'string') return null;
  return (
    Object.values(DayOfWeek).find(
      (day) => dateForDay(weekStart, day) === date,
    ) ?? null
  );
}

/**
 * Pozycja zawężona do `remaining` (podmiana albo usunięcie dania części osób);
 * `null`, gdy nikt nie zostaje. Porcje per osoba (Etap 2.2) idą za
 * audytorium: kto wychodzi z pozycji, znika też z jej alokacji — inaczej zbiór
 * porcji nie pasowałby do uczestników (`PLAN_PORTIONS_INVALID`).
 */
function narrowSlot(
  slot: ApplyWeekSlotDto,
  remaining: string[],
): ApplyWeekSlotDto | null {
  if (remaining.length === 0) return null;
  const { portions, ...rest } = slot;
  const kept = (portions ?? []).filter((portion) =>
    remaining.includes(portion.userId),
  );
  return {
    ...rest,
    participantIds: remaining,
    ...(kept.length > 0 ? { portions: kept } : {}),
  } as ApplyWeekSlotDto;
}
