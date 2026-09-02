import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ConsentsModule } from '../consents/consents.module';
import { HouseholdsModule } from '../households/households.module';
import { RecipesModule } from '../recipes/recipes.module';
import { WeeklyPlansModule } from '../weekly-plans/weekly-plans.module';
import { AgentProposalsService } from './proposals/agent-proposals.service';
import { AgentToolExecutor } from './tools/agent-tool-executor';
import { AgentPromptService } from './agent-prompt.service';
import { ObservabilityModule } from '../observability/observability.module';
import { AgentConfigService } from './agent-config.service';
import { AgentConversationsService } from './agent-conversations.service';
import { AgentMemoryService } from './agent-memory.service';
import { AgentController } from './agent.controller';
import { AgentTurnRunner } from './agent-turn.runner';
import { AgentTurnsService } from './agent-turns.service';
import { AiUsageCountersService } from './ai-usage-counters.service';
import { AgentProviderResolver } from './providers/agent-provider.resolver';
import { AnthropicAgentProvider } from './providers/anthropic-agent.provider';
import { StubAgentProvider } from './providers/stub-agent.provider';
import { UpstreamBreaker } from './upstream-breaker';

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
  ],
  controllers: [AgentController],
  providers: [
    AgentConfigService,
    AiUsageCountersService,
    AgentMemoryService,
    AgentConversationsService,
    AgentTurnsService,
    AgentTurnRunner,
    AgentProviderResolver,
    AgentToolExecutor,
    AgentProposalsService,
    AgentPromptService,
    StubAgentProvider,
    AnthropicAgentProvider,
    // Jeden bezpiecznik na proces — stan współdzielą wszystkie rozmowy,
    // bo chodzi o zdrowie DOSTAWCY, nie pojedynczego użytkownika. Przez
    // fabrykę, bo konstruktor bierze progi jako argument z wartością domyślną,
    // a DI i tak próbowałoby go wstrzyknąć.
    { provide: UpstreamBreaker, useFactory: () => new UpstreamBreaker() },
  ],
})
export class AgentModule {}
