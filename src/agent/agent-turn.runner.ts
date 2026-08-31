import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AgentEnv } from '../config/agent-env';
import { AgentMetricsService } from '../observability/agent-metrics.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  AiUsageCountersService,
  GLOBAL_SCOPE,
} from './ai-usage-counters.service';
import {
  AgentProviderError,
  AgentProviderMessage,
  AgentProviderResult,
  AgentProviderUsage,
} from './providers/agent-provider';
import { AgentProviderResolver } from './providers/agent-provider.resolver';
import {
  AgentProgressStep,
  appendProgress,
  progressStep,
} from './agent-progress';
import { AgentPromptService, TurnDates } from './agent-prompt.service';
import { AgentToolExecutor } from './tools/agent-tool-executor';
import { AGENT_TOOLS } from './tools/agent-tools';
import { UpstreamBreaker } from './upstream-breaker';

export type RunTurnInput = {
  turnId: string;
  conversationId: string;
  userId: string;
  householdId: string;
  /** Okres kwoty, z której zeszła ta tura — zwrot musi trafić tam z powrotem. */
  periodKey: string;
  env: AgentEnv;
  requestId: string;
  /**
   * Daty z TELEFONU. Serwer żyje w UTC i nie ma prawa liczyć „dziś" ani
   * początku tygodnia — patrz `dto/agent-date.validators.ts`.
   */
  dates: TurnDates;
};

/** Ile ostatnich wiadomości rozmowy idzie do modelu jako kontekst. */
export const HISTORY_WINDOW = 40;

type FailureVerdict = {
  errorCode: 'AI_TIMEOUT' | 'AI_PROVIDER_ERROR' | 'INTERNAL_ERROR';
  outcome: 'timeout' | 'failed';
  /** Czy oddać kwotę — użytkownik nie płaci za to, że coś padło po naszej stronie. */
  refund: boolean;
  /** Czy błąd liczy się do bezpiecznika dostawcy. */
  countsToBreaker: boolean;
};

/**
 * Wykonanie jednej tury: historia → dostawca → odpowiedź, księga użycia i
 * domknięcie tury.
 *
 * Biegnie POZA cyklem żądania (klient dostał już 202 i odpytuje
 * `GET /agent/turns/:id`), więc nikt tu nie złapie wyjątku za nas — `run`
 * nie rzuca NIGDY. Każde wyjście domyka turę: DONE albo FAILED z kodem.
 *
 * Domknięcie jest warunkowe: `updateMany` po `status: 'RUNNING'`. Jeśli turę
 * zdążył już zamknąć leniwy timeout z odczytu (`AgentTurnsService.expireIfStale`),
 * `count === 0` i runner cicho odpuszcza zamiast nadpisywać wynik i dopisywać
 * drugą odpowiedź do rozmowy.
 *
 * W logach nie ma treści wiadomości ani odpowiedzi — tylko `turnId`,
 * `requestId` i kod. Rozmowa z asystentem to prywatne dane gospodarstwa;
 * logi Railway nie są miejscem na listę zakupów ani na cele wagowe.
 */
@Injectable()
export class AgentTurnRunner {
  private readonly logger = new Logger(AgentTurnRunner.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly providers: AgentProviderResolver,
    private readonly prompts: AgentPromptService,
    private readonly tools: AgentToolExecutor,
    private readonly counters: AiUsageCountersService,
    private readonly breaker: UpstreamBreaker,
    private readonly metrics: AgentMetricsService,
  ) {}

  async run(input: RunTurnInput): Promise<void> {
    const startedAt = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      input.env.turnTimeoutMs,
    );

    const progress: AgentProgressStep[] = [];

    try {
      const messages = await this.loadHistory(input.conversationId);
      const prompt = await this.prompts.build(
        input.userId,
        input.householdId,
        input.dates,
      );
      const provider = this.providers.resolve(input.env);
      const result = await provider.run({
        model: input.env.model,
        effort: input.env.effort,
        system: prompt.system,
        messages,
        tools: AGENT_TOOLS,
        // Domknięcie z tożsamością tury: dostawca nie zna ani użytkownika, ani
        // gospodarstwa, więc nie ma jak sięgnąć do bazy z pominięciem bramek.
        executeTool: async (name, toolInput) => {
          await this.publishProgress(input.turnId, progress, name, toolInput);
          return this.tools.execute(name, toolInput, {
            userId: input.userId,
            householdId: input.householdId,
            catalogIndex: prompt.catalogIndex,
          });
        },
        signal: controller.signal,
      });
      await this.finishDone(input, result, Date.now() - startedAt);
      this.breaker.recordSuccess();
    } catch (error) {
      await this.finishFailed(
        input,
        error,
        Date.now() - startedAt,
        controller.signal.aborted,
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Dopisuje krok postępu do tury, żeby telefon miał co pokazać w trakcie.
   *
   * Zapis jest warunkowy (`status: 'RUNNING'`) — turę mógł już domknąć leniwy
   * timeout z odczytu i nie wolno jej wskrzeszać dopiskiem. Błąd zapisu jest
   * połykany: postęp to udogodnienie, a nie powód, żeby wywrócić turę, za
   * którą użytkownik już zapłacił kwotą.
   */
  private async publishProgress(
    turnId: string,
    steps: AgentProgressStep[],
    tool: string,
    input: Record<string, unknown>,
  ): Promise<void> {
    if (!appendProgress(steps, progressStep(tool, input))) return;
    try {
      await this.prisma.agentTurn.updateMany({
        where: { id: turnId, status: 'RUNNING' },
        data: { progress: steps as unknown as Prisma.InputJsonValue },
      });
    } catch (error) {
      this.logger.warn(
        `nie udało się zapisać postępu tury ${turnId}: ${
          error instanceof Error ? error.message : 'nieznany błąd'
        }`,
      );
    }
  }

  /**
   * Księga użycia dla nieudanej tury.
   *
   * Osobno od `updateMany`, które domyka turę, i po nim: wiersz księgi ma
   * powstać tylko wtedy, gdy to MY domknęliśmy turę (inaczej leniwy timeout
   * i runner dopisaliby dwa wiersze za to samo). Błąd zapisu nie może
   * przesłonić błędu, który tu nas przywiódł — stąd log, nie rzut.
   */
  private async recordFailedUsage(
    input: RunTurnInput,
    spent: AgentProviderUsage,
    verdict: FailureVerdict,
    durationMs: number,
  ): Promise<void> {
    try {
      await this.prisma.aiUsage.create({
        data: {
          turnId: input.turnId,
          userId: input.userId,
          householdId: input.householdId,
          provider: input.env.provider,
          model: input.env.model,
          effort: input.env.effort,
          stopReason: verdict.errorCode,
          inputTokens: spent.inputTokens,
          cacheReadTokens: spent.cacheReadTokens,
          cacheWriteTokens: spent.cacheWriteTokens,
          outputTokens: spent.outputTokens,
          costMicroUsd: spent.costMicroUsd,
          latencyMs: durationMs,
        },
      });
    } catch (error) {
      this.logger.warn(
        `turn ${input.turnId}: nie udało się dopisać księgi nieudanej tury: ${
          error instanceof Error ? error.message : 'nieznany błąd'
        }`,
      );
    }
  }

  private async loadHistory(
    conversationId: string,
  ): Promise<AgentProviderMessage[]> {
    const rows = await this.prisma.agentMessage.findMany({
      where: { conversationId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: HISTORY_WINDOW,
      select: { role: true, text: true },
    });
    return rows
      .reverse()
      .filter((row) => row.role === 'USER' || row.role === 'ASSISTANT')
      .map((row) => ({
        role:
          row.role === 'ASSISTANT' ? ('ASSISTANT' as const) : ('USER' as const),
        text: row.text,
      }));
  }

  private async finishDone(
    input: RunTurnInput,
    result: AgentProviderResult,
    durationMs: number,
  ): Promise<void> {
    const { usage } = result;
    let closed = false;

    try {
      closed = await this.prisma.$transaction(async (tx) => {
        const update = await tx.agentTurn.updateMany({
          where: { id: input.turnId, status: 'RUNNING' },
          data: {
            status: 'DONE',
            finishedAt: new Date(),
            durationMs,
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            costMicroUsd: usage.costMicroUsd,
          },
        });
        if (update.count === 0) return false;

        const message = await tx.agentMessage.create({
          data: {
            conversationId: input.conversationId,
            role: 'ASSISTANT',
            kind: 'TEXT',
            text: result.text,
            turnId: input.turnId,
          },
        });
        await tx.aiUsage.create({
          data: {
            turnId: input.turnId,
            userId: input.userId,
            householdId: input.householdId,
            provider: input.env.provider,
            model: input.env.model,
            // Bez `effort` księga nie da się skalibrować: ta sama tura na
            // `medium` i na `high` to dwa różne rachunki.
            effort: input.env.effort,
            stopReason: result.stopReason,
            inputTokens: usage.inputTokens,
            cacheReadTokens: usage.cacheReadTokens,
            cacheWriteTokens: usage.cacheWriteTokens,
            outputTokens: usage.outputTokens,
            costMicroUsd: usage.costMicroUsd,
            latencyMs: durationMs,
          },
        });
        await tx.agentConversation.update({
          where: { id: input.conversationId },
          data: { lastMessageAt: message.createdAt },
        });
        // Budżet dobowy liczy się na całą instalację, nie per gospodarstwo —
        // to bezpiecznik na rachunek, nie kwota użytkownika.
        await this.counters.add(
          tx,
          GLOBAL_SCOPE,
          this.counters.dayKey(),
          'costMicroUsd',
          usage.costMicroUsd,
        );
        return true;
      });
    } catch (error) {
      // Rozmowa skasowana w trakcie tury (RODO) — P2025 na `update`.
      // Nie ma czego domykać ani komu pokazać; zostaje ślad w logu.
      if (this.isMissingRecord(error)) {
        this.logger.warn(
          `turn ${input.turnId} requestId=${input.requestId}: rekord zniknął w trakcie tury (P2025)`,
        );
        return;
      }
      throw error;
    }

    if (!closed) {
      this.logger.warn(
        `turn ${input.turnId} requestId=${input.requestId}: tura była już domknięta, wynik dostawcy porzucony`,
      );
      return;
    }

    this.metrics.recordTurnFinished('done');
    this.metrics.recordProviderUsage({
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      costMicroUsd: usage.costMicroUsd,
    });
  }

  private async finishFailed(
    input: RunTurnInput,
    error: unknown,
    durationMs: number,
    aborted: boolean,
  ): Promise<void> {
    const verdict = this.classify(error, aborted);

    try {
      // Zużycie sprzed błędu: tura, która padła po pięciu rundach narzędzi,
      // kosztowała tyle samo co udana. Bez tego księga i budżet dobowy
      // pokazywałyby zero wydanych pieniędzy.
      const spent =
        error instanceof AgentProviderError ? error.usage : undefined;
      const closed = await this.prisma.agentTurn.updateMany({
        where: { id: input.turnId, status: 'RUNNING' },
        data: {
          status: 'FAILED',
          errorCode: verdict.errorCode,
          finishedAt: new Date(),
          durationMs,
          ...(spent
            ? {
                inputTokens: spent.inputTokens,
                outputTokens: spent.outputTokens,
                costMicroUsd: spent.costMicroUsd,
              }
            : {}),
        },
      });
      if (closed.count === 0) {
        this.logger.warn(
          `turn ${input.turnId} requestId=${input.requestId}: tura była już domknięta (${verdict.errorCode})`,
        );
        return;
      }

      if (spent && spent.costMicroUsd > 0) {
        // Wiersz w księdze także dla PORAŻKI. `AiUsage` to surowiec do
        // kalibracji modelu kosztów („jeden wiersz na żądanie do dostawcy"),
        // a tura, która padła w piątej rundzie, wysłała ich pięć. Bez tego
        // księga pokazywałaby wyłącznie tury udane — czyli rachunek niższy
        // od prawdziwego, i to systematycznie.
        await this.recordFailedUsage(input, spent, verdict, durationMs);
        await this.counters.add(
          this.prisma,
          GLOBAL_SCOPE,
          this.counters.dayKey(),
          'costMicroUsd',
          spent.costMicroUsd,
        );
      }

      if (verdict.refund) {
        await this.counters.add(
          this.prisma,
          input.householdId,
          input.periodKey,
          'messages',
          -1,
        );
      }
    } catch (closeError) {
      if (this.isMissingRecord(closeError)) {
        this.logger.warn(
          `turn ${input.turnId} requestId=${input.requestId}: rekord zniknął przy domykaniu (P2025)`,
        );
        return;
      }
      // Awaria bazy przy domykaniu tury: leniwy timeout w odczycie i tak
      // zamknie ją jako AI_TIMEOUT — logujemy i nie wywracamy procesu.
      this.logger.error(
        `turn ${input.turnId} requestId=${input.requestId}: nie udało się domknąć tury`,
        closeError instanceof Error ? closeError.stack : undefined,
      );
      return;
    }

    this.metrics.recordTurnFinished(verdict.outcome);
    if (verdict.countsToBreaker) {
      this.metrics.recordUpstreamError();
      if (this.breaker.recordFailure()) {
        this.metrics.recordBreakerOpened();
        this.logger.warn(
          'bezpiecznik dostawcy otwarty — kolejne tury odmawiane jako AI_UPSTREAM_PAUSED',
        );
      }
    }

    const reason = error instanceof Error ? error.message : String(error);
    this.logger.warn(
      `turn ${input.turnId} requestId=${input.requestId} ${verdict.errorCode}: ${reason}`,
    );
  }

  private classify(error: unknown, aborted: boolean): FailureVerdict {
    // Przerwanie sprawdzamy PRZED typem błędu: dostawca dostaje `AbortSignal`
    // i zgłosi to po swojemu (u nas `AgentProviderError`), ale przyczyną jest
    // nasz timeout, nie awaria po jego stronie — bezpiecznik ma to zignorować.
    if (aborted) {
      return {
        errorCode: 'AI_TIMEOUT',
        outcome: 'timeout',
        refund: true,
        countsToBreaker: false,
      };
    }
    if (error instanceof AgentProviderError) {
      return {
        errorCode: 'AI_PROVIDER_ERROR',
        outcome: 'failed',
        refund: error.retryable,
        countsToBreaker: error.retryable,
      };
    }
    return {
      errorCode: 'INTERNAL_ERROR',
      outcome: 'failed',
      refund: true,
      countsToBreaker: false,
    };
  }

  private isMissingRecord(error: unknown): boolean {
    return (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2025'
    );
  }
}
