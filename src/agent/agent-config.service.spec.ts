import { AppException } from '../common/app-exception';
import { AgentMetricsService } from '../observability/agent-metrics.service';
import { PrismaService } from '../prisma/prisma.service';
import { AgentConfigService } from './agent-config.service';

describe('AgentConfigService', () => {
  const KEYS = [
    'AI_ENABLED',
    'AI_PROVIDER',
    'ANTHROPIC_API_KEY',
    'AI_ALLOWED_USERS',
  ] as const;
  const original: Record<string, string | undefined> = {};
  const USER_ID = '3fa85f64-5717-4562-b3fc-2c963f66afa6';
  let metrics: AgentMetricsService;
  let prisma: { user: { findUnique: jest.Mock } };
  let service: AgentConfigService;

  beforeEach(() => {
    for (const key of KEYS) original[key] = process.env[key];
    delete process.env.AI_ALLOWED_USERS;
    metrics = new AgentMetricsService();
    prisma = {
      user: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ id: USER_ID, email: 'Rafal@Example.com' }),
      },
    };
    service = new AgentConfigService(
      metrics,
      prisma as unknown as PrismaService,
    );
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

  describe('lista dozwolonych kont', () => {
    it('pusta lista = wszyscy, bez pytania bazy', async () => {
      await expect(service.assertUserAllowed(USER_ID)).resolves.toBeUndefined();
      expect(prisma.user.findUnique).not.toHaveBeenCalled();
    });

    it('przepuszcza po identyfikatorze', async () => {
      process.env.AI_ALLOWED_USERS = `ktos@inny.pl, ${USER_ID.toUpperCase()}`;
      await expect(service.assertUserAllowed(USER_ID)).resolves.toBeUndefined();
    });

    it('przepuszcza po e-mailu bez względu na wielkość liter', async () => {
      process.env.AI_ALLOWED_USERS = 'RAFAL@example.COM';
      await expect(service.assertUserAllowed(USER_ID)).resolves.toBeUndefined();
    });

    it('konto spoza listy dostaje to samo 503 AI_DISABLED, co wyłączony asystent', async () => {
      // Celowo ten sam kod: wydany build iOS ma dla niego kopię i blokadę
      // pola; nowy kod czekałby na wizytę na Macu. Powód jest w `details`.
      process.env.AI_ALLOWED_USERS = 'ktos@inny.pl';
      await expect(service.assertUserAllowed(USER_ID)).rejects.toMatchObject({
        code: 'AI_DISABLED',
        details: ['not_allowed'],
      });
      expect(metrics.snapshot().rejected.disabled).toBe(1);
    });

    it('konto bez e-maila, którego nie ma na liście po id, też odpada', async () => {
      process.env.AI_ALLOWED_USERS = 'ktos@inny.pl';
      prisma.user.findUnique.mockResolvedValue({ id: USER_ID, email: null });
      await expect(service.assertUserAllowed(USER_ID)).rejects.toMatchObject({
        details: ['not_allowed'],
      });
    });
  });
});
