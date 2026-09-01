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
import { AgentCardState } from '../cards/agent-cards';
import { appliedMessageText, buildAppliedCard, weekStartLabel } from '../cards/applied-card';
import { buildPlanWeekCard } from '../cards/plan-week-card';
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
      targetKcalPerDay: await this.targetKcalFor(
        input.userId,
        input.householdId,
      ),
      expiresAt,
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
  async apply(userId: string, proposalId: string): Promise<ProposalActionResult> {
    const proposal = await this.loadOwned(userId, proposalId);
    // Członkostwo mogło się zmienić między propozycją a kliknięciem.
    await ensureMembership(this.prisma, userId, proposal.householdId);

    // Podwójny klik dostaje TEN SAM wynik, nie konflikt — to jest odpowiedź
    // na dwa dotknięcia przycisku, nie sytuacja wyjątkowa.
    if (proposal.status === 'APPLIED') {
      return this.resultForApplied(proposal);
    }
    if (proposal.status !== 'PENDING') {
      throw new AppException(
        'AI_PROPOSAL_STALE',
        'Ta propozycja jest już nieaktualna. Poproś asystenta o nową.',
        HttpStatus.CONFLICT,
        [`reason:${proposal.status}`],
      );
    }
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
    if (weekBaselineHash(before) !== proposal.baselineHash) {
      await this.markStatus(proposal.id, 'STALE');
      throw new AppException(
        'AI_PROPOSAL_STALE',
        'Plan tygodnia zmienił się od czasu tej propozycji. Poproś asystenta o nową.',
        HttpStatus.CONFLICT,
        ['reason:CHANGED'],
      );
    }

    // Zamek na poziomie bazy. Chodzi nie tylko o podwójny zapis (ten i tak
    // byłby bezstratny — `applyWeekPlan` to operacja stanu docelowego), ale
    // o `undoSnapshot`: drugi przebieg zapisałby jako „stan sprzed" tydzień
    // JUŻ ZMIENIONY i zabiłby „Cofnij".
    const locked = await this.prisma.agentProposal.updateMany({
      where: { id: proposal.id, status: 'PENDING' },
      data: {
        status: 'APPLIED',
        undoSnapshot: before as unknown as Prisma.InputJsonValue,
        appliedAt: new Date(),
        appliedByUserId: userId,
      },
    });
    if (locked.count === 0) {
      return this.resultForApplied(await this.loadOwned(userId, proposalId));
    }

    const periodKey = this.counters.monthKey();
    const limit = readAgentEnv().plansPerMonth;
    const consumed = await this.counters.tryConsume(
      this.prisma,
      proposal.householdId,
      periodKey,
      'plans',
      limit,
    );
    if (!consumed) {
      // Kwota wraca do stanu sprzed kliknięcia: użytkownik może zatwierdzić
      // tę samą propozycję pierwszego dnia miesiąca.
      await this.markStatus(proposal.id, 'PENDING');
      throw new AppException(
        'AI_PLAN_QUOTA_EXCEEDED',
        `Limit zapisanych planów na ten miesiąc (${limit}) został wyczerpany.`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
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
        await this.markStatus(proposal.id, 'STALE');
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
        result.changes.created + result.changes.updated + result.changes.deleted;
      if (changed === 0) await this.refundPlan(proposal.householdId, periodKey);

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
        data: { appliedHash: weekBaselineHash(after) },
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
      await this.markStatus(proposal.id, 'FAILED');
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
  async undo(userId: string, proposalId: string): Promise<ProposalActionResult> {
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

    const weekStart = toWeekStartString(proposal.weekStart);
    const current = await this.weeklyPlans.snapshotWeekAsSlots(
      userId,
      proposal.householdId,
      weekStart,
    );
    // Ktoś w domu poprawił tydzień PO zapisie — cofnięcie skasowałoby jego
    // pracę razem z naszą zmianą.
    if (proposal.appliedHash && weekBaselineHash(current) !== proposal.appliedHash) {
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

    // Cofnięcie to korekta, nie nowy plan — kwota wraca.
    await this.refundPlan(proposal.householdId, this.counters.monthKey());

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

  private async markStatus(id: string, status: string): Promise<void> {
    try {
      await this.prisma.agentProposal.update({ where: { id }, data: { status } });
    } catch (error) {
      this.logger.warn(`nie udało się ustawić statusu propozycji: ${String(error)}`);
    }
  }

  /** Zwrot kwoty planu — księgowość nie może wywrócić operacji użytkownika. */
  private async refundPlan(householdId: string, periodKey: string): Promise<void> {
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
        ...(input.card
          ? { card: input.card as Prisma.InputJsonValue }
          : {}),
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
      this.logger.warn(`nie udało się rozgłosić zapisu tygodnia: ${String(error)}`);
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

  /** Ostatnia wiadomość rozmowy — to ona niesie kartę po tej operacji. */
  private async messageOf(proposal: AgentProposal): Promise<MessageView> {
    const message = await this.prisma.agentMessage.findFirst({
      where: { conversationId: proposal.conversationId, role: 'ASSISTANT' },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
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
  return Array.isArray(wrapped.slots) ? (wrapped.slots as ApplyWeekSlotDto[]) : [];
}

/** Reguły stanu karty — jedno miejsce, bo czyta je i lista, i pojedyncza tura. */
export function cardState(
  proposal: {
    status: string;
    expiresAt: Date;
    appliedAt: Date | null;
  },
  now: number,
  undoWindowMs: number,
): AgentCardState {
  if (proposal.status === 'APPLIED') {
    const until = proposal.appliedAt
      ? new Date(proposal.appliedAt.getTime() + undoWindowMs)
      : null;
    const canUndo = until ? until.getTime() > now : false;
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

  return {
    status: (['UNDONE', 'STALE', 'EXPIRED', 'FAILED'] as const).includes(
      proposal.status as 'UNDONE',
    )
      ? (proposal.status as AgentCardState['status'])
      : 'STALE',
    canApply: false,
    canUndo: false,
    until: null,
  };
}
