import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { HouseholdsService } from '../../households/households.service';
import {
  PlanViolation,
  WeeklyPlansService,
} from '../../weekly-plans/weekly-plans.service';
import { ApplyWeekSlotDto } from '../../weekly-plans/dto/apply-week-plan.dto';
import { readAgentEnv } from '../../config/agent-env';
import { buildPlanWeekCard } from '../cards/plan-week-card';
import { weekBaselineHash } from './proposal-baseline';

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
}
