import { AppException } from '../common/app-exception';
import { AgentMetricsService } from '../observability/agent-metrics.service';
import { AgentConfigService } from './agent-config.service';

describe('AgentConfigService', () => {
  const KEYS = ['AI_ENABLED', 'AI_PROVIDER', 'ANTHROPIC_API_KEY'] as const;
  const original: Record<string, string | undefined> = {};
  let metrics: AgentMetricsService;
  let service: AgentConfigService;

  beforeEach(() => {
    for (const key of KEYS) original[key] = process.env[key];
    metrics = new AgentMetricsService();
    service = new AgentConfigService(metrics);
  });

  afterEach(() => {
    for (const key of KEYS) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
  });

  const expectDisabled = (detail: string) => {
    try {
      service.assertEnabled();
      throw new Error('oczekiwano AI_DISABLED');
    } catch (error) {
      expect(error).toBeInstanceOf(AppException);
      const exception = error as AppException;
      expect(exception.code).toBe('AI_DISABLED');
      // 503, nie 404: klient ma wiedzieć, że funkcja istnieje.
      expect(exception.getStatus()).toBe(503);
      expect(exception.details).toEqual([detail]);
    }
    expect(metrics.snapshot().rejected.disabled).toBe(1);
  };

  it('domyślnie (brak AI_ENABLED) asystent jest wyłączony', () => {
    delete process.env.AI_ENABLED;
    expect(service.read().enabled).toBe(false);
    expectDisabled('disabled');
  });

  it('AI_ENABLED=true z dostawcą anthropic bez klucza = wyłączony', () => {
    process.env.AI_ENABLED = 'true';
    process.env.AI_PROVIDER = 'anthropic';
    delete process.env.ANTHROPIC_API_KEY;
    expectDisabled('provider_not_configured');
  });

  it('stub nie potrzebuje klucza', () => {
    process.env.AI_ENABLED = 'true';
    process.env.AI_PROVIDER = 'stub';
    delete process.env.ANTHROPIC_API_KEY;
    const env = service.assertEnabled();
    expect(env.provider).toBe('stub');
    expect(metrics.snapshot().rejected.disabled).toBe(0);
  });

  it('czyta env przy KAŻDYM wywołaniu — flaga działa bez restartu builda', () => {
    process.env.AI_ENABLED = 'false';
    expect(service.read().enabled).toBe(false);
    process.env.AI_ENABLED = 'true';
    expect(service.read().enabled).toBe(true);
  });
});
