import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AppException } from '../common/app-exception';
import { resolveRoute } from './agent-route';
import { assertUuid } from '../common/uuid';
import { validateDto } from '../common/validate-dto';
import { AgentMetricsService } from '../observability/agent-metrics.service';
import { OpsAlertService } from '../observability/ops-alert.service';
import { PrismaService } from '../prisma/prisma.service';
import { runSerializable } from '../weekly-plans/utils/transaction-runner.util';
import { AgentEnv, TURN_TIMEOUT_GRACE_MS } from '../config/agent-env';
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
import { AgentQuotaMailService } from './agent-quota-mail.service';
import {
  AiUsageCountersService,
  GLOBAL_SCOPE,
} from './ai-usage-counters.service';
import { EditMessageDto, PostMessageDto } from './dto/post-message.dto';
import { resolveProposalMode } from './cards/agent-cards';
import { UpstreamBreaker } from './upstream-breaker';
import { AgentUsageLedger } from './agent-usage-ledger.service';
import {
  liveTurnWhere,
  orphanCandidatesWhere,
  orphanErrorCode,
  orphanReason,
} from './agent-turn-liveness';

/**
 * Po ilu sekundach wrócić, gdy proces właśnie się zamyka (deploy). Nowa
 * instancja przejmuje ruch w kilka sekund, więc ponowienie trafi już w nią.
 */
export const DRAINING_RETRY_AFTER_SECONDS = 5;

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
 * przyczyną wyczerpania `AI_TURN_TIMEOUT_MS` jest zbyt szeroki zakres,
 * więc proponujemy mniejszy.
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
  /**
   * Narastający tekst odpowiedzi, TYLKO gdy tura biegnie: telefon pokazuje
   * go w miejscu, w którym za chwilę stanie odpowiedź. Cały dotychczasowy,
   * nie przyrost — klient podmienia, nie dokleja. Brak = jeszcze nic.
   */
  draftText?: string;
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
 * 5. bezpiecznik dostawcy i zamykanie procesu (503 `AI_UPSTREAM_PAUSED`),
 *    potem budżet: sufity domu (szybka odmowa z samych wydanych pieniędzy),
 *    a po nich instalacji — z rezerwacją za tury w biegu, NIEATOMOWO (patrz
 *    niżej). Odmowy bez kosztu.
 * 6. transakcja: lease rozmowy (409) → semafor domu (409) → sufity domu
 *    z rezerwacją za jego tury w biegu (503) → kwota (429) → wiadomość + tura.
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
    private readonly quotaMail: AgentQuotaMailService,
    private readonly breaker: UpstreamBreaker,
    private readonly metrics: AgentMetricsService,
    private readonly runner: AgentTurnRunner,
    private readonly proposals: AgentProposalsService,
    private readonly alerts: OpsAlertService,
    private readonly ledger: AgentUsageLedger,
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

    // Proces się zamyka (SIGTERM po deployu): tura przyjęta teraz zostałaby
    // przerwana po `AI_SHUTDOWN_GRACE_MS`. Ten sam kod co bezpiecznik — dla
    // telefonu to „chwilowa przerwa, ponów za kilka sekund".
    if (this.runner.isDraining()) {
      this.metrics.recordRejected('upstream');
      throw new AppException(
        'AI_UPSTREAM_PAUSED',
        'Asystent ma chwilową przerwę. Spróbuj za kilka sekund.',
        HttpStatus.SERVICE_UNAVAILABLE,
        [`retryAfterSeconds:${DRAINING_RETRY_AFTER_SECONDS}`],
      );
    }

    // Sufit kosztu domu na DOBĘ — sprawdzany PRZED globalnym, bo ma odmówić
    // sprawcy, zanim sprawca odmówi wszystkim. Kolejność jest tu całą
    // poprawką: budżet globalny to bezpiecznik na rachunek infrastruktury,
    // a nie narzędzie do dzielenia go między domy.
    if (env.householdDailyCostUsd !== null) {
      const spentToday = await this.counters.read(
        conversation.householdId,
        this.counters.dayKey(),
        'costMicroUsd',
      );
      if (spentToday >= env.householdDailyCostUsd * 1_000_000) {
        this.metrics.recordRejected('budget');
        void this.alerts.notify(
          `ai-household-daily:${conversation.householdId}:${this.counters.dayKey()}`,
          `gospodarstwo ${conversation.householdId} przekroczyło dobowy sufit kosztu ($${env.householdDailyCostUsd}) — asystent odpowiada 503 do północy UTC`,
        );
        throw new AppException(
          'AI_BUDGET_PAUSED',
          'Wasz dom wykorzystał dziś asystenta do końca. Wróćcie jutro.',
          HttpStatus.SERVICE_UNAVAILABLE,
          [`resetsAt:${this.counters.dayResetsAt().toISOString()}`],
        );
      }
    }

    // Budżet instalacji: wydane PLUS rezerwacja za każdą żywą turę. NIEATOMOWO
    // — liczenie tur całej instalacji w transakcji SERIALIZABLE kłóciłoby się
    // z każdą równoległą turą w każdym domu. Wyścig kosztuje najwyżej tyle
    // tur ponad sufit, ile startów zmieści się między odczytem a zapisem,
    // a w trakcie tury i tak pilnuje go werdykt księgi (`budget_ceiling`).
    if (env.globalDailyBudgetUsd !== null) {
      const spentMicroUsd = await this.counters.read(
        GLOBAL_SCOPE,
        this.counters.dayKey(),
        'costMicroUsd',
      );
      const reservedMicroUsd =
        env.turnCostReserveUsd > 0
          ? (await this.prisma.agentTurn.count({
              where: liveTurnWhere(env.turnTimeoutMs),
            })) *
            env.turnCostReserveUsd *
            1_000_000
          : 0;
      if (
        spentMicroUsd + reservedMicroUsd >=
        env.globalDailyBudgetUsd * 1_000_000
      ) {
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
      // SERIALIZABLE, nie domyślny READ COMMITTED. Lease rozmowy i semafor
      // domu to `count()`, a zaraz po nim `create()` — pod READ COMMITTED dwie
      // równoległe transakcje nie widzą swoich niezacommitowanych wstawek,
      // więc obie liczą „zero biegnących" i obie zakładają turę (write skew).
      // Dwadzieścia żądań wystrzelonych naraz uruchamiało dwadzieścia tur
      // zamiast dwóch. SSI Postgresa wykrywa dokładnie ten wzorzec i przegranej
      // transakcji oddaje P2034, które `runSerializable` ponawia; po ponowieniu
      // `count()` widzi już zacommitowaną turę i odmawia uczciwie, kodem
      // AI_TURN_IN_PROGRESS. Ta sama funkcja pilnuje zapisu planu tygodnia.
      accepted = await runSerializable(this.prisma, async (tx) => {
        // Lease rozmowy: jedna tura naraz. Liczymy w transakcji, bo dwa
        // telefony tej samej osoby potrafią wysłać równocześnie; przy jednej
        // instancji i krótkiej transakcji to wystarcza (kolejny wyścig i tak
        // zatrzyma unikat na `clientMessageId`).
        //
        // Tury po padzie procesu (deploy, OOM) ZAMYKAMY tutaj, zamiast je
        // pomijać przy liczeniu.
        //
        // Samo pominięcie wystarczyłoby, żeby odblokować rozmowę, ale
        // zostawiałoby w bazie wiersz RUNNING, którego nikt już nie domknie —
        // a zombie obok żywej tury znaczyłby trwale spaloną wiadomość.
        // Definicja „tura już nie żyje" jest jedna dla wszystkich ścieżek
        // (`orphanReason`): minuta bez znaku życia albo czas tury z marginesem.
        // Po restarcie rozmowa odblokowuje się więc w minutę, a nie po 4.
        const stale = await tx.agentTurn.findMany({
          where: {
            conversationId,
            ...orphanCandidatesWhere(env.turnTimeoutMs),
          },
          select: { id: true, startedAt: true, updatedAt: true },
        });
        for (const dead of stale) {
          const reason = orphanReason(
            dead,
            env.turnTimeoutMs,
            this.runner.isRunning(dead.id),
          );
          if (!reason) continue;
          const closed = await this.ledger.closeTurn(tx, {
            turnId: dead.id,
            errorCode: orphanErrorCode(reason),
            fallbackScopeId: conversation.householdId,
          });
          if (!closed) continue;
          this.metrics.recordTurnFinished(
            reason === 'timeout' ? 'timeout' : 'failed',
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

        // Żywe tury domu (bez osieroconych — te nie zjadają miejsca, zanim
        // ktoś je posprząta). Liczone raz, dla semafora i dla rezerwacji.
        const householdLive =
          env.maxConcurrentTurnsPerHousehold > 0 ||
          env.householdDailyCostUsd !== null ||
          env.householdMonthlyCostUsd !== null
            ? await tx.agentTurn.count({
                where: {
                  conversation: { householdId: conversation.householdId },
                  ...liveTurnWhere(env.turnTimeoutMs),
                },
              })
            : 0;

        // Lease per rozmowa nie ogranicza tur w WIELU rozmowach naraz —
        // budżet dobowy jest sprawdzany przed startem, a koszt dopisywany po
        // turze, więc burst 30 rozmów potrafił wydać 30× więcej, niż wolno.
        // Semafor per gospodarstwo domyka tę lukę; próg z env.
        if (env.maxConcurrentTurnsPerHousehold > 0) {
          if (householdLive >= env.maxConcurrentTurnsPerHousehold) {
            this.metrics.recordRejected('inProgress');
            throw new AppException(
              'AI_TURN_IN_PROGRESS',
              'W Waszym domu trwa już kilka odpowiedzi asystenta — poczekaj chwilę.',
              HttpStatus.CONFLICT,
            );
          }
        }

        // Sufity domu Z REZERWACJĄ, w tej samej transakcji co semafor: wydane
        // pieniądze plus `AI_TURN_COST_RESERVE_USD` za każdą INNĄ żywą turę
        // domu. Sprawdzenie przed transakcją widziało tylko wydane — koszt
        // tury w biegu dopisuje się dopiero po jej wywołaniach — więc dwa
        // równoległe starty tuż pod sufitem przechodziły oba. SERIALIZABLE
        // szereguje je jak lease: drugi widzi już turę pierwszego.
        await this.assertHouseholdBudget(
          tx,
          env,
          conversation.householdId,
          householdLive,
        );

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
      // Pula wiadomości pusta. Mail MUSI pójść tutaj, a nie przy rzucie:
      // kwota schodzi wewnątrz transakcji, a odmowa ją wycofuje — wiersz
      // zakolejkowany w środku zniknąłby razem z nią.
      if (error instanceof AppException && error.code === 'AI_QUOTA_EXCEEDED') {
        await this.quotaMail.announce(userId, plan, 'messages');
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

    if (turn.status === 'RUNNING' && turn.draftText) {
      view.draftText = turn.draftText;
    }

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
   * zwrot kwoty za turę bez kosztu) — czekamy na to chwilę, żeby odpowiedź
   * już niosła stan końcowy. Tura z innego procesu (po deployu) nie ma kto
   * jej przerwać, więc zamykamy ją tu bezpośrednio, tak jak leniwy timeout;
   * koszt, który zdążyła naliczyć, jest już w księdze.
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

    const closed = await this.prisma.$transaction((tx) =>
      this.ledger.closeTurn(tx, {
        turnId: turn.id,
        errorCode: 'AI_CANCELLED',
        fallbackScopeId: turn.conversation.householdId,
      }),
    );
    if (closed) this.metrics.recordTurnFinished('failed');
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
    // Ta sama bramka, co `loadOwned` rozmowy: własność tury to za mało, liczy
    // się członkostwo DZIŚ. Kto wyszedł z domu, czytał tu dalej odpowiedzi
    // asystenta o TAMTYM domu (plan, lista zakupów) i mógł anulować cudzą turę.
    const membership = await this.prisma.membership.findUnique({
      where: {
        userId_householdId: {
          userId,
          householdId: turn.conversation.householdId,
        },
      },
      select: { userId: true },
    });
    if (!membership) {
      throw new AppException(
        'AI_TURN_NOT_FOUND',
        'Nie znaleziono tej tury.',
        HttpStatus.NOT_FOUND,
      );
    }
    return turn;
  }

  /**
   * Tura bez znaku życia od minuty (proces padł) albo po czasie tury
   * z marginesem — nikt jej już nie domknie, a klient odpytywałby ją
   * w nieskończoność. Domknięcie jest warunkowe (`updateMany` po
   * `status: 'RUNNING'`), żeby nie przykryć wyniku runnera, który akurat
   * kończy, i NIE dotyka kosztu — ten dopisuje księga po każdym wywołaniu,
   * także gdy runner dojedzie po domknięciu. Wiadomość wraca tylko za turę,
   * która nic nie wydała.
   */
  private async expireIfStale<
    T extends {
      id: string;
      status: string;
      startedAt: Date;
      updatedAt: Date;
      conversation: { householdId: string };
    },
  >(turn: T): Promise<T> {
    if (turn.status !== 'RUNNING') return turn;
    const env = this.config.read();
    const reason = orphanReason(
      turn,
      env.turnTimeoutMs,
      this.runner.isRunning(turn.id),
    );
    if (!reason) return turn;

    const closed = await this.prisma.$transaction((tx) =>
      this.ledger.closeTurn(tx, {
        turnId: turn.id,
        errorCode: orphanErrorCode(reason),
        fallbackScopeId: turn.conversation.householdId,
      }),
    );
    if (!closed) {
      return this.loadOwnedTurnById(turn);
    }

    this.metrics.recordTurnFinished(
      reason === 'timeout' ? 'timeout' : 'failed',
    );
    this.logger.warn(
      `turn ${turn.id} domknięta leniwie jako ${orphanErrorCode(reason)} (proces nie dokończył tury)`,
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
   * Sufity kosztu domu (doba, miesiąc) z rezerwacją za jego żywe tury —
   * w transakcji przyjęcia tury. `householdLive` to tury INNE niż ta, którą
   * właśnie przyjmujemy (jeszcze jej nie ma).
   */
  private async assertHouseholdBudget(
    tx: Prisma.TransactionClient,
    env: AgentEnv,
    householdId: string,
    householdLive: number,
  ): Promise<void> {
    const reservedMicroUsd = householdLive * env.turnCostReserveUsd * 1_000_000;
    const ceilings = [
      {
        limitUsd: env.householdDailyCostUsd,
        periodKey: this.counters.dayKey(),
        daily: true,
      },
      {
        limitUsd: env.householdMonthlyCostUsd,
        periodKey: this.counters.monthKey(),
        daily: false,
      },
    ];
    for (const ceiling of ceilings) {
      if (ceiling.limitUsd === null) continue;
      const spent = await this.counters.read(
        householdId,
        ceiling.periodKey,
        'costMicroUsd',
        tx,
      );
      const limitMicroUsd = ceiling.limitUsd * 1_000_000;
      if (spent + reservedMicroUsd < limitMicroUsd) continue;
      this.metrics.recordRejected('budget');
      // Sam koszt jest pod sufitem, a przelewa go dopiero rezerwacja: dom nie
      // „wykorzystał asystenta", tylko czeka na własną odpowiedź w biegu.
      const reservationOnly = spent < limitMicroUsd;
      throw new AppException(
        'AI_BUDGET_PAUSED',
        reservationOnly
          ? 'Limit Waszego domu jest prawie wykorzystany, a asystent jeszcze odpowiada na poprzednią wiadomość. Spróbuj, gdy skończy.'
          : ceiling.daily
            ? 'Wasz dom wykorzystał dziś asystenta do końca. Wróćcie jutro.'
            : 'Asystent jest chwilowo niedostępny dla Waszego domu. Napisz do nas, jeśli to niespodzianka.',
        HttpStatus.SERVICE_UNAVAILABLE,
        ceiling.daily
          ? [`resetsAt:${this.counters.dayResetsAt().toISOString()}`]
          : undefined,
      );
    }
  }

  private toTurnStatus(status: string): TurnStatus {
    return (TURN_STATUSES as readonly string[]).includes(status)
      ? (status as TurnStatus)
      : 'FAILED';
  }
}
