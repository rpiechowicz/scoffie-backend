import { Injectable } from '@nestjs/common';
import { AgentEnv } from '../../config/agent-env';
import { AnthropicAgentProvider } from './anthropic-agent.provider';
import { AgentProvider } from './agent-provider';
import { StubAgentProvider } from './stub-agent.provider';

/**
 * Wybór dostawcy PER TURĘ, nie przy starcie modułu.
 *
 * Plan zakładał token `AGENT_PROVIDER` wiązany fabryką, ale fabryka DI biegnie
 * raz, przy budowie kontenera — a `AI_PROVIDER` jest, jak reszta `AI_*`,
 * czytane z env na bieżąco (`readAgentEnv`). Przy tokenie przełączenie
 * dostawcy wymagałoby restartu, a e2e nie mogłoby puścić dwóch tur na dwóch
 * dostawcach w jednym procesie. Resolver kosztuje jedną gałąź `if` i zdejmuje
 * ten problem.
 */
@Injectable()
export class AgentProviderResolver {
  constructor(
    private readonly stub: StubAgentProvider,
    private readonly anthropic: AnthropicAgentProvider,
  ) {}

  resolve(env: AgentEnv): AgentProvider {
    return env.provider === 'stub' ? this.stub : this.anthropic;
  }
}
