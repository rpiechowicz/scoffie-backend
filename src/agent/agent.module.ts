import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ConsentsModule } from '../consents/consents.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { HouseholdsModule } from '../households/households.module';
import { RecipesModule } from '../recipes/recipes.module';
import { WeeklyPlansModule } from '../weekly-plans/weekly-plans.module';
import { AgentProposalsService } from './proposals/agent-proposals.service';
import { AgentRetentionService } from './agent-retention.service';
import { AgentReportsService } from './agent-reports.service';
import { AgentUsageService } from './agent-usage.service';
import { AgentToolExecutor } from './tools/agent-tool-executor';
import { AgentPromptService } from './agent-prompt.service';
import { ObservabilityModule } from '../observability/observability.module';
import { AgentConfigService } from './agent-config.service';
import { AgentConversationsService } from './agent-conversations.service';
import { AgentMemoryService } from './agent-memory.service';
import { AgentController } from './agent.controller';
import { AgentTurnRunner } from './agent-turn.runner';
import { AgentTurnsService } from './agent-turns.service';
import { MailModule } from '../mail/mail.module';
import { AiUsageCountersService } from './ai-usage-counters.service';
import { AgentQuotaMailService } from './agent-quota-mail.service';
import { AgentProviderResolver } from './providers/agent-provider.resolver';
import { AnthropicAgentProvider } from './providers/anthropic-agent.provider';
import { StubAgentProvider } from './providers/stub-agent.provider';
import { UpstreamBreaker } from './upstream-breaker';
import { AgentCatalogService } from './search/agent-catalog.service';
import { AgentCacheWarmer } from './agent-cache-warmer.service';

/**
 * Asystent AI — szkielet Fazy 0.
 *
 * Granica jest jednokierunkowa: asystent wolno mu wołać domenę i
 * obserwowalność, ale NIC w aplikacji nie importuje `src/agent/` (pilnuje
 * tego `no-restricted-imports` w `eslint.config.mjs`; jedyny wyjątek to
 * `AppModule`, który go rejestruje). Dzięki temu wyłączenie asystenta jest
 * zmianą jednej flagi, a nie operacją na całym backendzie — i dlatego
 * `AgentMetricsService` mieszka w `src/observability/`, a nie tutaj.
 *
 * `AuthModule` daje `JwtAuthGuard`, `PrismaModule` jest globalny.
 */
@Module({
  imports: [
    AuthModule,
    ObservabilityModule,
    // Domena, którą wołają narzędzia asystenta. Granica pozostaje
    // jednokierunkowa: to agent importuje domenę, nigdy odwrotnie.
    HouseholdsModule,
    WeeklyPlansModule,
    RecipesModule,
    // Zgody: bramka przed turą i filtr domowników w prompcie.
    ConsentsModule,
    // Poczta: mail o wyczerpanej puli. Granica trzyma się kierunku — agent
    // woła pocztę, poczta nie wie o agencie.
    MailModule,
    // Push „asystent odpowiedział" po domknięciu tury.
    NotificationsModule,
  ],
  controllers: [AgentController],
  providers: [
    AgentConfigService,
    AiUsageCountersService,
    AgentQuotaMailService,
    AgentMemoryService,
    AgentConversationsService,
    AgentTurnsService,
    AgentTurnRunner,
    AgentProviderResolver,
    AgentToolExecutor,
    AgentProposalsService,
    AgentPromptService,
    // Indeks katalogu w pamięci + wyszukiwarka dań (`find_recipes`).
    AgentCatalogService,
    // Ping co 55 min trzyma cache prefiksu ciepłym przy ruchu.
    AgentCacheWarmer,
    AgentRetentionService,
    AgentReportsService,
    AgentUsageService,
    StubAgentProvider,
    AnthropicAgentProvider,
    // Jeden bezpiecznik na proces — stan współdzielą wszystkie rozmowy,
    // bo chodzi o zdrowie DOSTAWCY, nie pojedynczego użytkownika. Przez
    // fabrykę, bo konstruktor bierze progi jako argument z wartością domyślną,
    // a DI i tak próbowałoby go wstrzyknąć.
    { provide: UpstreamBreaker, useFactory: () => new UpstreamBreaker() },
  ],
  // Tylko dla panelu administratora (`src/admin/`, wierzchołek grafu jak
  // AppModule): pula i reset sufitu liczą się tą samą funkcją, co kwota.
  exports: [AiUsageCountersService],
})
export class AgentModule {}
