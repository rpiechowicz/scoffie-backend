import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { readAgentEnv } from '../config/agent-env';
import { PrismaService } from '../prisma/prisma.service';
import { AgentPromptService } from './agent-prompt.service';
import { resolveRoute } from './agent-route';
import {
  AiUsageCountersService,
  GLOBAL_SCOPE,
} from './ai-usage-counters.service';
import { AnthropicAgentProvider } from './providers/anthropic-agent.provider';

/**
 * Co ile podgrzewamy. Cache prefiksu żyje godzinę od OSTATNIEGO trafienia,
 * więc ping co 55 minut trzyma go ciepłym z pięciominutowym zapasem.
 */
export const CACHE_WARM_INTERVAL_MS = 55 * 60 * 1000;

/**
 * Podgrzewacz cache prefiksu asystenta.
 *
 * Pomiar 24.09.2026: pierwsza tura po godzinie ciszy płaciła zapis całego
 * prefiksu (narzędzia + instrukcje + katalog) i czekała na niego ~5 s dłużej.
 * Ping co 55 minut kosztuje odczyt z cache (~$0,005 przy prefiksie ~20 tys.
 * tokenów po przejściu na mapę katalogu) i zdejmuje oba koszty.
 *
 * Tylko przy ruchu: ping idzie, gdy ostatnia tura była najwyżej
 * `AI_CACHE_WARM_HOURS` godzin temu (`0` = wyłączone). W nocy, bez rozmów,
 * nie kosztuje nic. Koszt pingu trafia do księgi `AiUsage` (bez osoby i domu,
 * `stopReason: cache_warm`) i do dobowego budżetu instalacji — jak każda tura.
 *
 * Jedna instancja Railway, więc zwykły `setInterval` z `unref`, jak retencja.
 */
@Injectable()
export class AgentCacheWarmer
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(AgentCacheWarmer.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly prompts: AgentPromptService,
    private readonly anthropic: AnthropicAgentProvider,
    private readonly counters: AiUsageCountersService,
  ) {}

  onApplicationBootstrap(): void {
    this.timer = setInterval(
      () => void this.warmQuietly(),
      CACHE_WARM_INTERVAL_MS,
    );
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Jedno podgrzanie; `false` = nic nie poszło (wyłączone, brak ruchu, inny
   * dostawca). Publiczne dla testów i ręcznego wywołania.
   */
  async warm(now: Date = new Date()): Promise<boolean> {
    const env = readAgentEnv();
    if (
      !env.enabled ||
      env.provider !== 'anthropic' ||
      !env.apiKeyPresent ||
      env.cacheWarmHours <= 0
    ) {
      return false;
    }
    const last = await this.prisma.agentTurn.findFirst({
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });
    if (
      !last ||
      now.getTime() - last.createdAt.getTime() >
        env.cacheWarmHours * 60 * 60 * 1000
    ) {
      return false;
    }

    const route = resolveRoute(env);
    const system = await this.prompts.sharedPrefix();
    // Przy przekazaniu pałeczki prefiksy są DWA (tani model z listą rozmowy,
    // planista z pełną) — każdy ma swój wpis w cache.
    const targets = [
      { model: route.model, tools: route.tools },
      ...(route.handoff
        ? [{ model: route.handoff.model, tools: route.handoff.tools }]
        : []),
    ];
    for (const target of targets) {
      const usage = await this.anthropic.warmCache({ ...target, system });
      await this.prisma.aiUsage.create({
        data: {
          provider: 'anthropic',
          model: target.model,
          stopReason: 'cache_warm',
          inputTokens: usage.inputTokens,
          cacheReadTokens: usage.cacheReadTokens,
          cacheWriteTokens: usage.cacheWriteTokens,
          outputTokens: usage.outputTokens,
          costMicroUsd: usage.costMicroUsd,
          apiCalls: 1,
        },
      });
      await this.counters.add(
        this.prisma,
        GLOBAL_SCOPE,
        this.counters.dayKey(),
        'costMicroUsd',
        usage.costMicroUsd,
      );
    }
    return true;
  }

  private async warmQuietly(): Promise<void> {
    try {
      await this.warm();
    } catch (error) {
      // Podgrzewanie jest optymalizacją: jego błąd nie może niczego wywrócić.
      this.logger.warn(
        `podgrzanie cache nie wyszło (${
          error instanceof Error ? error.message : 'nieznany błąd'
        })`,
      );
    }
  }
}
