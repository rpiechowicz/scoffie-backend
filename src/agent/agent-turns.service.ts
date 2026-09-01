import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AppException } from '../common/app-exception';
import { assertUuid } from '../common/uuid';
import { validateDto } from '../common/validate-dto';
import { AgentMetricsService } from '../observability/agent-metrics.service';
import { PrismaService } from '../prisma/prisma.service';
import { TURN_TIMEOUT_GRACE_MS } from '../config/agent-env';
import { AgentConfigService } from './agent-config.service';
import {
  conversationTitleFrom,
  AgentConversationsService,
  MessageView,
} from './agent-conversations.service';
import { AgentProgressStep } from './agent-progress';
import { AgentProposalsService } from './proposals/agent-proposals.service';
import { AgentTurnRunner } from './agent-turn.runner';
import {
  AiUsageCountersService,
  GLOBAL_SCOPE,
} from './ai-usage-counters.service';
import { PostMessageDto } from './dto/post-message.dto';
import { UpstreamBreaker } from './upstream-breaker';

export const TURN_STATUSES = ['RUNNING', 'DONE', 'FAILED', 'LIMITED'] as const;
export type TurnStatus = (typeof TURN_STATUSES)[number];

export type AcceptedTurn = {
  turnId: string;
  messageId: string;
  status: TurnStatus;
  requestId: string;
};

export type TurnView = {
  id: string;
  conversationId: string;
  status: TurnStatus;
  progress: AgentProgressStep[];
  errorCode: string | null;
  messages?: MessageView[];
  usage?: {
    inputTokens: number;
    outputTokens: number;
    costMicroUsd: number;
  };
  startedAt: string;
  finishedAt: string | null;
};

/**
 * Margines nad `AI_TURN_TIMEOUT_MS` przy leniwym domykaniu tury: runner ma
 * własny `AbortController` i sam ustawia FAILED, więc odczyt wchodzi dopiero
 * wtedy, gdy proces padł w połowie tury (deploy, OOM) i nikt już tego nie zrobi.
 */
export { TURN_TIMEOUT_GRACE_MS };

/**
 * Tury asystenta: przyjęcie wiadomości (202) i odczyt stanu (polling).
 *
 * Dlaczego 202 + polling, a nie Socket.IO ani SSE: tura trwa dziesiątki
 * sekund, telefon w tym czasie potrafi wejść w tło i stracić socket, a my i
 * tak musimy trzymać stan tury w bazie (żeby po powrocie było co pokazać).
 * Skoro stan jest trwały, strumień byłby tylko drugim, zawodnym kanałem do
 * tego samego — patrz analiza asystenta, sekcja Architektura.
 *
 * KOLEJNOŚĆ ODMÓW jest częścią kontraktu i wygląda tak:
 *
 * 1. `AI_DISABLED` — zanim dotkniemy bazy.
 * 2. 404 rozmowy — cudza rozmowa nie może dowiedzieć się o sobie niczego,
 *    nawet tego, że jest zajęta.
 * 3. walidacja treści.
 * 4. idempotencja — powtórzone żądanie oddaje starą turę, ZANIM ktokolwiek
 *    sprawdzi limity; inaczej ponowienie po zerwanej sieci trafiałoby na
 *    409 („moja własna tura jeszcze biegnie") zamiast dostać jej id.
 * 5. bezpiecznik dostawcy i budżet dobowy — odmowy globalne, bez kosztu.
 * 6. transakcja: lease rozmowy (409) → kwota (429) → wiadomość + tura.
 *
 * Kwota schodzi NA STARCIE, nie po odpowiedzi modelu: inaczej wystarczyłoby
 * zrywać połączenie, żeby dostać nielimitowanego asystenta. Nieudana tura
 * (błąd dostawcy, timeout) oddaje ją z powrotem — patrz `refundQuota`.
 */
@Injectable()
export class AgentTurnsService {
  private readonly logger = new Logger(AgentTurnsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AgentConfigService,
    private readonly conversations: AgentConversationsService,
    private readonly counters: AiUsageCountersService,
    private readonly breaker: UpstreamBreaker,
    private readonly metrics: AgentMetricsService,
    private readonly runner: AgentTurnRunner,
    private readonly proposals: AgentProposalsService,
  ) {}

  async postMessage(
    userId: string,
    conversationId: string,
    dto: PostMessageDto,
    requestId: string,
  ): Promise<AcceptedTurn> {
    const env = this.config.assertEnabled();
    const conversation = await this.conversations.loadOwned(
      userId,
      conversationId,
    );
    const data = await validateDto(PostMessageDto, dto);

    const existing = await this.findByClientMessageId(
      conversationId,
      data.clientMessageId,
    );
    if (existing) return { ...existing, requestId };

    if (this.breaker.isOpen()) {
      this.metrics.recordRejected('upstream');
      throw new AppException(
        'AI_UPSTREAM_PAUSED',
        'Asystent ma chwilową przerwę. Spróbuj za minutę.',
        HttpStatus.SERVICE_UNAVAILABLE,
        [`retryAfterSeconds:${this.breaker.retryAfterSeconds()}`],
      );
    }

    if (env.globalDailyBudgetUsd !== null) {
      const spentMicroUsd = await this.counters.read(
        GLOBAL_SCOPE,
        this.counters.dayKey(),
        'costMicroUsd',
      );
      if (spentMicroUsd >= env.globalDailyBudgetUsd * 1_000_000) {
        this.metrics.recordRejected('budget');
        throw new AppException(
          'AI_BUDGET_PAUSED',
          'Asystent jest dziś niedostępny. Spróbuj jutro.',
          HttpStatus.SERVICE_UNAVAILABLE,
        );
      }
    }

    const periodKey = this.counters.monthKey();
    let accepted: AcceptedTurn;
    try {
      accepted = await this.prisma.$transaction(async (tx) => {
        // Lease rozmowy: jedna tura naraz. Liczymy w transakcji, bo dwa
        // telefony tej samej osoby potrafią wysłać równocześnie; przy jednej
        // instancji i krótkiej transakcji to wystarcza (kolejny wyścig i tak
        // zatrzyma unikat na `clientMessageId`).
        //
        // Tury po padzie procesu (deploy, OOM) ZAMYKAMY tutaj, zamiast je
        // pomijać przy liczeniu.
        //
        // Samo pominięcie wystarczyłoby, żeby odblokować rozmowę, ale
        // zostawiałoby w bazie wiersz RUNNING, którego nikt już nie odpyta —
        // a to właśnie odpytanie (`expireIfStale`) jest jedynym mechanizmem
        // zwrotu kwoty. Zombie obok żywej tury znaczyłby więc trwale spaloną
        // wiadomość z miesięcznego limitu. Ten sam próg co w `expireIfStale`,
        // bo to ta sama definicja „tura już nie żyje".
        const staleBefore = new Date(
          Date.now() - env.turnTimeoutMs - TURN_TIMEOUT_GRACE_MS,
        );
        const stale = await tx.agentTurn.findMany({
          where: {
            conversationId,
            status: 'RUNNING',
            startedAt: { lte: staleBefore },
          },
          select: { id: true, startedAt: true },
        });
        for (const dead of stale) {
          const closed = await tx.agentTurn.updateMany({
            where: { id: dead.id, status: 'RUNNING' },
            data: {
              status: 'FAILED',
              errorCode: 'AI_TIMEOUT',
              finishedAt: new Date(),
            },
          });
          if (closed.count === 0) continue;
          this.metrics.recordTurnFinished('timeout');
          // Kwota wraca do okresu, z którego zeszła — tura zaczęta 31. o 23:59
          // oddaje ją tam, a nie do nowego miesiąca.
          await this.counters.add(
            tx,
            conversation.householdId,
            this.counters.monthKey(dead.startedAt),
            'messages',
            -1,
          );
        }

        const running = await tx.agentTurn.count({
          where: { conversationId, status: 'RUNNING' },
        });
        if (running > 0) {
          this.metrics.recordRejected('inProgress');
          throw new AppException(
            'AI_TURN_IN_PROGRESS',
            'Poprzednia wiadomość jest jeszcze przetwarzana.',
            HttpStatus.CONFLICT,
          );
        }

        const consumed = await this.counters.tryConsume(
          tx,
          conversation.householdId,
          periodKey,
          'messages',
          env.messagesPerMonth,
        );
        if (!consumed) {
          this.metrics.recordRejected('quota');
          throw new AppException(
            'AI_QUOTA_EXCEEDED',
            'Limit wiadomości asystenta na ten miesiąc został wyczerpany.',
            HttpStatus.TOO_MANY_REQUESTS,
          );
        }

        const message = await tx.agentMessage.create({
          data: {
            conversationId,
            role: 'USER',
            kind: 'TEXT',
            text: data.text,
            clientMessageId: data.clientMessageId,
          },
        });
        const turn = await tx.agentTurn.create({
          data: {
            conversationId,
            userId,
            userMessageId: message.id,
            requestId,
            provider: env.provider,
            model: env.model,
          },
        });
        await tx.agentMessage.update({
          where: { id: message.id },
          data: { turnId: turn.id },
        });
        await tx.agentConversation.update({
          where: { id: conversationId },
          data: { lastMessageAt: message.createdAt },
        });
        // Tytuł nadaje WYŁĄCZNIE pierwsza wiadomość — `title: null` w warunku
        // załatwia to bez dodatkowego odczytu i bez wyścigu.
        await tx.agentConversation.updateMany({
          where: { id: conversationId, title: null },
          data: { title: conversationTitleFrom(data.text) },
        });

        return {
          turnId: turn.id,
          messageId: message.id,
          status: 'RUNNING' as const,
          requestId,
        };
      });
    } catch (error) {
      // Wyścig na `clientMessageId`: drugie żądanie z tym samym id trafiło
      // w unikat. To nie konflikt do pokazania, tylko idempotencja — oddaj
      // turę, którą właśnie założył ten pierwszy.
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        const raced = await this.findByClientMessageId(
          conversationId,
          data.clientMessageId,
        );
        if (raced) return { ...raced, requestId };
      }
      throw error;
    }

    this.metrics.recordTurnStarted();
    // Tura biegnie in-process, poza cyklem żądania — klient ma już 202
    // i odpytuje `GET /agent/turns/:id`. Runner łapie wszystko sam.
    void this.runner.run({
      turnId: accepted.turnId,
      conversationId,
      userId,
      householdId: conversation.householdId,
      periodKey,
      env,
      requestId,
      dates: {
        weekStart: data.weekStart,
        clientToday: data.clientToday,
        timeZone: data.timeZone,
      },
    });

    return accepted;
  }

  async getTurn(userId: string, turnId: string): Promise<TurnView> {
    this.config.assertEnabled();
    assertUuid(turnId, 'turnId');

    let turn = await this.loadOwnedTurn(userId, turnId);
    turn = await this.expireIfStale(turn);

    const view: TurnView = {
      id: turn.id,
      conversationId: turn.conversationId,
      status: this.toTurnStatus(turn.status),
      progress: Array.isArray(turn.progress)
        ? (turn.progress as unknown as AgentProgressStep[])
        : [],
      errorCode: turn.errorCode,
      startedAt: turn.startedAt.toISOString(),
      finishedAt: turn.finishedAt?.toISOString() ?? null,
    };

    if (turn.status === 'DONE') {
      const messages = await this.prisma.agentMessage.findMany({
        where: { turnId: turn.id, role: 'ASSISTANT' },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      });
      view.messages = await this.proposals.withCardState(
        messages.map((m) => ({
          id: m.id,
          role: m.role,
          kind: m.kind,
          text: m.text,
          clientMessageId: m.clientMessageId,
          turnId: m.turnId,
          createdAt: m.createdAt.toISOString(),
          card: (m.card ?? null) as MessageView['card'],
        })),
      );
      view.usage = {
        inputTokens: turn.inputTokens,
        outputTokens: turn.outputTokens,
        costMicroUsd: turn.costMicroUsd,
      };
    }

    return view;
  }

  private async findByClientMessageId(
    conversationId: string,
    clientMessageId: string,
  ): Promise<Omit<AcceptedTurn, 'requestId'> | null> {
    const message = await this.prisma.agentMessage.findUnique({
      where: {
        conversationId_clientMessageId: { conversationId, clientMessageId },
      },
      select: { id: true, turnId: true },
    });
    if (!message?.turnId) return null;
    const turn = await this.prisma.agentTurn.findUnique({
      where: { id: message.turnId },
      select: { id: true, status: true },
    });
    if (!turn) return null;
    return {
      turnId: turn.id,
      messageId: message.id,
      status: this.toTurnStatus(turn.status),
    };
  }

  private async loadOwnedTurn(userId: string, turnId: string) {
    const turn = await this.prisma.agentTurn.findFirst({
      where: { id: turnId, userId },
      include: { conversation: { select: { householdId: true } } },
    });
    if (!turn) {
      throw new AppException(
        'AI_TURN_NOT_FOUND',
        'Nie znaleziono tej tury.',
        HttpStatus.NOT_FOUND,
      );
    }
    return turn;
  }

  /**
   * Tura RUNNING starsza niż timeout + margines to tura po padzie procesu —
   * nikt jej już nie domknie, a klient odpytywałby ją w nieskończoność.
   * Domknięcie jest warunkowe (`updateMany` po `status: 'RUNNING'`), żeby nie
   * przykryć wyniku runnera, który akurat kończy.
   */
  private async expireIfStale<
    T extends {
      id: string;
      status: string;
      startedAt: Date;
      conversation: { householdId: string };
    },
  >(turn: T): Promise<T> {
    const env = this.config.read();
    const staleAfterMs = env.turnTimeoutMs + TURN_TIMEOUT_GRACE_MS;
    if (
      turn.status !== 'RUNNING' ||
      Date.now() - turn.startedAt.getTime() < staleAfterMs
    ) {
      return turn;
    }

    const closed = await this.prisma.agentTurn.updateMany({
      where: { id: turn.id, status: 'RUNNING' },
      data: {
        status: 'FAILED',
        errorCode: 'AI_TIMEOUT',
        finishedAt: new Date(),
      },
    });
    if (closed.count === 0) {
      return this.loadOwnedTurnById(turn);
    }

    this.metrics.recordTurnFinished('timeout');
    await this.refundQuota(turn.conversation.householdId, turn.startedAt);
    this.logger.warn(
      `turn ${turn.id} domknięta leniwie jako AI_TIMEOUT (proces nie dokończył tury)`,
    );
    return this.loadOwnedTurnById(turn);
  }

  private async loadOwnedTurnById<T extends { id: string }>(
    turn: T,
  ): Promise<T> {
    const fresh = await this.prisma.agentTurn.findUnique({
      where: { id: turn.id },
      include: { conversation: { select: { householdId: true } } },
    });
    return (fresh ?? turn) as T;
  }

  /**
   * Zwrot kwoty do okresu, w którym tura RUSZYŁA. Tura zaczęta 31. o 23:59
   * i zamknięta 1. o 0:01 musi oddać kwotę tam, skąd ją wzięła.
   */
  private async refundQuota(householdId: string, startedAt: Date) {
    await this.counters.add(
      this.prisma,
      householdId,
      this.counters.monthKey(startedAt),
      'messages',
      -1,
    );
  }

  private toTurnStatus(status: string): TurnStatus {
    return (TURN_STATUSES as readonly string[]).includes(status)
      ? (status as TurnStatus)
      : 'FAILED';
  }
}
