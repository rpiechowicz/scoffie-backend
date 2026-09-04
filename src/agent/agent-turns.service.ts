import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AppException } from '../common/app-exception';
import { resolveRoute } from './agent-route';
import { assertUuid } from '../common/uuid';
import { validateDto } from '../common/validate-dto';
import { AgentMetricsService } from '../observability/agent-metrics.service';
import { OpsAlertService } from '../observability/ops-alert.service';
import { PrismaService } from '../prisma/prisma.service';
import { TURN_TIMEOUT_GRACE_MS } from '../config/agent-env';
import { AgentConfigService } from './agent-config.service';
import {
  conversationTitleFrom,
  usedContextFrom,
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
import { EditMessageDto, PostMessageDto } from './dto/post-message.dto';
import { resolveProposalMode } from './cards/agent-cards';
import { UpstreamBreaker } from './upstream-breaker';

export const TURN_STATUSES = ['RUNNING', 'DONE', 'FAILED', 'LIMITED'] as const;
export type TurnStatus = (typeof TURN_STATUSES)[number];

export type AcceptedTurn = {
  turnId: string;
  messageId: string;
  status: TurnStatus;
  requestId: string;
};

/**
 * Szybkie odpowiedzi po przekroczeniu czasu albo „Stop": najczęstszą
 * przyczyną 90 s jest zbyt szeroki zakres, więc proponujemy mniejszy.
 * Serwer, nie klient — ta sama lista ma się pokazać na każdym telefonie.
 */
export const TIMEOUT_SUGGESTIONS: readonly string[] = [
  'Zaplanuj tylko obiady',
  'Zaplanuj 3 dni',
];

export type TurnView = {
  id: string;
  conversationId: string;
  status: TurnStatus;
  progress: AgentProgressStep[];
  errorCode: string | null;
  /** Gotowe podpowiedzi do pokazania pod błędem (chipy); brak = nic nie pokazuj. */
  suggestions?: string[];
  /** „Stop" przyjęty, tura jeszcze się domyka — klient odpytuje dalej. */
  stopRequested?: boolean;
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
    private readonly alerts: OpsAlertService,
  ) {}

  /**
   * Poprawienie własnego pytania.
   *
   * Nie jest to edycja tekstu w miejscu. Poprawka WYCOFUJE poprawianą
   * wiadomość i wszystko, co po niej — łącznie z odpowiedziami asystenta —
   * i uruchamia nową turę. Inaczej użytkownik zostawałby z odpowiedzią na
   * pytanie, którego już nie zadał, a model widziałby oba w kolejnej turze.
   *
   * Kolejność jest tu jedyną rzeczą, która naprawdę ma znaczenie: ukrywamy
   * PRZED wysłaniem, bo tura startuje natychmiast i czyta historię — gdyby
   * ukrycie przyszło po niej, model zobaczyłby dokładnie to, co poprawka
   * miała usunąć. Gdy wysyłka odmówi (kwota, bezpiecznik, zajęta rozmowa),
   * cofamy ukrycie: rozmowa ma wtedy wyglądać tak, jakby nikt niczego nie
   * próbował.
   */
  async editMessage(
    userId: string,
    conversationId: string,
    dto: EditMessageDto,
    requestId: string,
  ): Promise<AcceptedTurn> {
    this.config.assertEnabled();
    await this.conversations.loadOwned(userId, conversationId);
    const data = await validateDto(EditMessageDto, dto);

    const target = await this.prisma.agentMessage.findFirst({
      where: {
        id: data.messageId,
        conversationId,
        role: 'USER',
        hiddenAt: null,
      },
      select: { id: true, createdAt: true },
    });
    if (!target) {
      throw new AppException(
        'AI_MESSAGE_NOT_FOUND',
        'Nie znaleziono wiadomości do poprawienia.',
        HttpStatus.NOT_FOUND,
      );
    }

    // Zbiór do wycofania liczymy PRZED czymkolwiek innym i po identyfikatorach,
    // a nie po znaczniku czasu: nowa wiadomość powstanie za chwilę z tym samym
    // `createdAt` co do milisekundy, a filtr po czasie zabrałby ją razem
    // z resztą.
    const doomed = await this.prisma.agentMessage.findMany({
      where: {
        conversationId,
        hiddenAt: null,
        OR: [
          { createdAt: { gt: target.createdAt } },
          { createdAt: target.createdAt, id: { gte: target.id } },
        ],
      },
      select: { id: true },
    });
    const ids = doomed.map((message) => message.id);
    const hiddenAt = new Date();
    await this.prisma.agentMessage.updateMany({
      where: { id: { in: ids } },
      data: { hiddenAt },
    });

    try {
      // `messageId` zostaje TUTAJ: wysyłka waliduje swoje DTO z whitelistą,
      // więc nieznane pole zatrzymałoby poprawkę na 400 — i to po tym, jak
      // wiadomości zostały już ukryte.
      const { messageId: _edited, ...forwarded } = data;
      const accepted = await this.postMessage(
        userId,
        conversationId,
        forwarded as PostMessageDto,
        requestId,
      );
      // Propozycje wiszące na wycofanych wiadomościach przestają być
      // klikalne. Karta mogła zostać na drugim telefonie — a zatwierdzenie
      // planu z pytania, które użytkownik właśnie wycofał, byłoby zapisem
      // czegoś, czego nikt już nie chce.
      await this.prisma.agentProposal.updateMany({
        where: { messageId: { in: ids }, status: 'PENDING' },
        data: { status: 'STALE' },
      });
      return accepted;
    } catch (error) {
      await this.prisma.agentMessage.updateMany({
        where: { id: { in: ids }, hiddenAt },
        data: { hiddenAt: null },
      });
      throw error;
    }
  }

  async postMessage(
    userId: string,
    conversationId: string,
    dto: PostMessageDto,
    requestId: string,
  ): Promise<AcceptedTurn> {
    const env = this.config.assertEnabled();
    await this.config.assertUserAllowed(userId, env);
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
        // Operator ma się dowiedzieć PRZED użytkownikami — raz na dobę.
        void this.alerts.notify(
          `ai-budget-paused:${this.counters.dayKey()}`,
          `budżet dobowy asystenta ($${env.globalDailyBudgetUsd}) wyczerpany — /agent odpowiada 503 AI_BUDGET_PAUSED do północy UTC`,
        );
        throw new AppException(
          'AI_BUDGET_PAUSED',
          'Asystent jest dziś niedostępny. Spróbuj jutro.',
          HttpStatus.SERVICE_UNAVAILABLE,
        );
      }
    }

    const plan = await this.counters.resolvePlan(conversation.householdId, {
      userId,
    });
    const periodKey = plan.periodKey;
    // Zakres kwoty: `sub:<id>` przy subskrypcji, `trial:<hasz>` na próbie,
    // UUID domu przy nadaniu. Zapisujemy go przy turze, bo zwrot ma wrócić
    // TAM, skąd kwota zeszła — dom, który w międzyczasie stracił PRO, oddawał
    // do zakresu wyliczonego dopiero w chwili zwrotu, czyli do cudzej puli.
    const scopeId = plan.quotaScopeId;

    // Sufit kosztu domu na miesiąc. Osobno od limitu wiadomości, bo tura
    // przerwana timeoutem oddaje wiadomość, a pieniądze zostają wydane —
    // bez tego jeden dom w pętli błędów wyczerpuje budżet dobowy CAŁEJ
    // instalacji i wyłącza asystenta wszystkim.
    if (env.householdMonthlyCostUsd !== null) {
      const spent = await this.counters.read(
        conversation.householdId,
        this.counters.monthKey(),
        'costMicroUsd',
      );
      if (spent >= env.householdMonthlyCostUsd * 1_000_000) {
        this.metrics.recordRejected('budget');
        void this.alerts.notify(
          `ai-household-cost:${conversation.householdId}:${this.counters.monthKey()}`,
          `gospodarstwo ${conversation.householdId} przekroczyło miesięczny sufit kosztu ($${env.householdMonthlyCostUsd}) — asystent odpowiada 503 do końca miesiąca UTC`,
        );
        throw new AppException(
          'AI_BUDGET_PAUSED',
          'Asystent jest chwilowo niedostępny dla Waszego domu. Napisz do nas, jeśli to niespodzianka.',
          HttpStatus.SERVICE_UNAVAILABLE,
        );
      }
    }
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
          select: {
            id: true,
            startedAt: true,
            quotaPeriodKey: true,
            quotaScopeId: true,
          },
        });
        for (const dead of stale) {
          const closed = await tx.agentTurn.updateMany({
            where: { id: dead.id, status: 'RUNNING' },
            data: {
              status: 'FAILED',
              errorCode: 'AI_TIMEOUT',
              finishedAt: new Date(),
              quotaRefunded: true,
            },
          });
          if (closed.count === 0) continue;
          this.metrics.recordTurnFinished('timeout');
          // Kwota wraca do okresu, z którego zeszła — tura zaczęta 31. o 23:59
          // oddaje ją tam, a nie do nowego miesiąca.
          await this.counters.add(
            tx,
            dead.quotaScopeId ?? conversation.householdId,
            dead.quotaPeriodKey ?? this.counters.monthKey(dead.startedAt),
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

        // Lease per rozmowa nie ogranicza tur w WIELU rozmowach naraz —
        // budżet dobowy jest sprawdzany przed startem, a koszt dopisywany po
        // turze, więc burst 30 rozmów potrafił wydać 30× więcej, niż wolno.
        // Semafor per gospodarstwo domyka tę lukę; próg z env.
        if (env.maxConcurrentTurnsPerHousehold > 0) {
          const householdRunning = await tx.agentTurn.count({
            where: {
              conversation: { householdId: conversation.householdId },
              status: 'RUNNING',
              startedAt: { gt: staleBefore },
            },
          });
          if (householdRunning >= env.maxConcurrentTurnsPerHousehold) {
            this.metrics.recordRejected('inProgress');
            throw new AppException(
              'AI_TURN_IN_PROGRESS',
              'W Waszym domu trwa już kilka odpowiedzi asystenta — poczekaj chwilę.',
              HttpStatus.CONFLICT,
            );
          }
        }

        const consumed = await this.counters.tryConsume(
          tx,
          scopeId,
          periodKey,
          'messages',
          plan.messagesLimit,
        );
        if (!consumed) {
          this.metrics.recordRejected('quota');
          throw new AppException(
            'AI_QUOTA_EXCEEDED',
            plan.tier === 'TRIAL'
              ? `Darmowe wiadomości na próbę (${plan.messagesLimit}) są wykorzystane. Wybierz plan, żeby mieć pulę miesięczną dla całego domu.`
              : // „W tym miesiącu" byłoby nieprawdą: od 4.09.2026 pula wraca
                // w dniu odnowienia subskrypcji, a nie pierwszego. Datę niesie
                // `resetsAt` w `details` — telefon pokazuje ją wprost.
                'Limit wiadomości asystenta w tym okresie został wyczerpany.',
            HttpStatus.TOO_MANY_REQUESTS,
            this.counters.quotaDetailsFor('messages', plan),
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
            // Model STARTOWY tury (faza CHAT przy routingu); `finishDone`
            // nadpisze go modelem, który dał ostatnie słowo.
            model: resolveRoute(env).model,
            quotaPeriodKey: periodKey,
            quotaScopeId: scopeId,
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
      quotaScopeId: scopeId,
      env,
      requestId,
      dates: {
        weekStart: data.weekStart,
        clientToday: data.clientToday,
        timeZone: data.timeZone,
      },
      // Tryb rozstrzyga się TU, raz na turę: env mówi, co jest włączone,
      // klient — czy w ogóle umie pokazać kartę. Runner dostaje gotową
      // odpowiedź, żeby prompt i bramka narzędzi nie mogły się rozjechać.
      proposalMode: resolveProposalMode(env.cardsMode, data.clientCapabilities),
      ...(data.scopeUserIds?.length ? { scopeUserIds: data.scopeUserIds } : {}),
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

    if (
      turn.status === 'FAILED' &&
      (turn.errorCode === 'AI_TIMEOUT' || turn.errorCode === 'AI_CANCELLED')
    ) {
      view.suggestions = [...TIMEOUT_SUGGESTIONS];
    }

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
          ...(usedContextFrom(m.context)
            ? { usedContext: usedContextFrom(m.context) }
            : {}),
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

  /**
   * „Stop" z telefonu.
   *
   * Tura w tym procesie dostaje sygnał i domyka się sama (`AI_CANCELLED`,
   * księga zużycia, zwrot kwoty) — czekamy na to chwilę, żeby odpowiedź już
   * niosła stan końcowy. Tura z innego procesu (po deployu) nie ma kto jej
   * przerwać, więc zamykamy ją tu bezpośrednio, tak jak leniwy timeout.
   * Tura już domknięta wraca bez zmian: drugie kliknięcie nie jest błędem.
   */
  async cancelTurn(userId: string, turnId: string): Promise<TurnView> {
    assertUuid(turnId, 'turnId');
    const turn = await this.loadOwnedTurn(userId, turnId);
    if (turn.status !== 'RUNNING') return this.getTurn(userId, turnId);

    if (this.runner.cancel(turn.id)) {
      await this.waitUntilClosed(turn.id);
      const view = await this.getTurn(userId, turnId);
      // Narzędzie potrafi trwać dłużej niż okno czekania — tura jest już
      // przerywana, ale jeszcze nie domknięta. Klient ma to wiedzieć, zamiast
      // dostać RUNNING bez słowa.
      return view.status === 'RUNNING'
        ? { ...view, stopRequested: true }
        : view;
    }

    const closed = await this.prisma.agentTurn.updateMany({
      where: { id: turn.id, status: 'RUNNING' },
      data: {
        status: 'FAILED',
        errorCode: 'AI_CANCELLED',
        finishedAt: new Date(),
        quotaRefunded: true,
      },
    });
    if (closed.count > 0) {
      this.metrics.recordTurnFinished('failed');
      await this.refundQuota(turn.conversation.householdId, turn);
    }
    return this.getTurn(userId, turnId);
  }

  /** Krótkie oczekiwanie na domknięcie tury przez runner po sygnale. */
  private async waitUntilClosed(turnId: string, timeoutMs = 3000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const row = await this.prisma.agentTurn.findUnique({
        where: { id: turnId },
        select: { status: true },
      });
      if (!row || row.status !== 'RUNNING') return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
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
        quotaRefunded: true,
      },
    });
    if (closed.count === 0) {
      return this.loadOwnedTurnById(turn);
    }

    this.metrics.recordTurnFinished('timeout');
    await this.refundQuota(turn.conversation.householdId, turn);
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
  private async refundQuota(
    householdId: string,
    turn: {
      startedAt: Date;
      quotaPeriodKey?: string | null;
      quotaScopeId?: string | null;
    },
  ) {
    await this.counters.add(
      this.prisma,
      // Zakres z CHWILI POBRANIA, nie z chwili zwrotu. Dom, który w
      // międzyczasie stracił PRO (albo płatnik się wyprowadził), oddawałby
      // inaczej kwotę do puli, z której nigdy jej nie wziął.
      turn.quotaScopeId ?? householdId,
      turn.quotaPeriodKey ?? this.counters.monthKey(turn.startedAt),
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
