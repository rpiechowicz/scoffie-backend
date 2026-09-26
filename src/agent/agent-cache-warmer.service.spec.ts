import { PrismaService } from '../prisma/prisma.service';
import { AgentCacheWarmer } from './agent-cache-warmer.service';
import { AgentPromptService } from './agent-prompt.service';
import { AiUsageCountersService } from './ai-usage-counters.service';
import { AnthropicAgentProvider } from './providers/anthropic-agent.provider';

describe('AgentCacheWarmer', () => {
  const saved = { ...process.env };
  const now = new Date('2026-09-26T12:00:00Z');
  let findFirst: jest.Mock;
  let aiUsageCreate: jest.Mock;
  let warmCache: jest.Mock;
  let add: jest.Mock;
  let warmer: AgentCacheWarmer;

  beforeEach(() => {
    process.env.AI_ENABLED = 'true';
    process.env.AI_PROVIDER = 'anthropic';
    process.env.ANTHROPIC_API_KEY = 'klucz-testowy';
    process.env.AI_CACHE_WARM_HOURS = '3';
    delete process.env.AI_MODEL_TOOLS;
    findFirst = jest
      .fn()
      .mockResolvedValue({ createdAt: new Date('2026-09-26T10:30:00Z') });
    aiUsageCreate = jest.fn().mockResolvedValue({});
    warmCache = jest.fn().mockResolvedValue({
      inputTokens: 1,
      cacheReadTokens: 20_000,
      cacheWriteTokens: 0,
      outputTokens: 1,
      costMicroUsd: 4_000,
    });
    add = jest.fn().mockResolvedValue(undefined);
    warmer = new AgentCacheWarmer(
      {
        agentTurn: { findFirst },
        aiUsage: { create: aiUsageCreate },
      } as unknown as PrismaService,
      {
        sharedPrefix: jest
          .fn()
          .mockResolvedValue([{ type: 'text', text: 'instrukcje' }]),
      } as unknown as AgentPromptService,
      { warmCache } as unknown as AnthropicAgentProvider,
      { add, dayKey: () => '2026-09-26' } as unknown as AiUsageCountersService,
    );
  });

  afterEach(() => {
    process.env = { ...saved };
  });

  it('przy ruchu: jeden ping z prefiksem tury, koszt w księdze i w budżecie dobowym', async () => {
    await expect(warmer.warm(now)).resolves.toBe(true);
    expect(warmCache).toHaveBeenCalledTimes(1);
    expect(warmCache.mock.calls[0][0]).toMatchObject({
      system: [{ type: 'text', text: 'instrukcje' }],
    });
    expect(aiUsageCreate.mock.calls[0][0]).toMatchObject({
      data: { stopReason: 'cache_warm', costMicroUsd: 4_000, apiCalls: 1 },
    });
    expect(add).toHaveBeenCalledWith(
      expect.anything(),
      'global',
      '2026-09-26',
      'costMicroUsd',
      4_000,
    );
  });

  it('przy przekazaniu pałeczki podgrzewa oba prefiksy', async () => {
    process.env.AI_MODEL_TOOLS = 'claude-haiku-4-5';
    await warmer.warm(now);
    expect(warmCache).toHaveBeenCalledTimes(2);
  });

  it('bez ruchu w oknie — nic nie idzie', async () => {
    findFirst.mockResolvedValue({
      createdAt: new Date('2026-09-26T06:00:00Z'),
    });
    await expect(warmer.warm(now)).resolves.toBe(false);
    findFirst.mockResolvedValue(null);
    await expect(warmer.warm(now)).resolves.toBe(false);
    expect(warmCache).not.toHaveBeenCalled();
  });

  it('wyłączone zerem, wyłączonym asystentem albo dostawcą stub', async () => {
    for (const env of [
      { AI_CACHE_WARM_HOURS: '0' },
      { AI_ENABLED: 'false' },
      { AI_PROVIDER: 'stub' },
    ]) {
      Object.assign(process.env, env);
      await expect(warmer.warm(now)).resolves.toBe(false);
      process.env.AI_CACHE_WARM_HOURS = '3';
      process.env.AI_ENABLED = 'true';
      process.env.AI_PROVIDER = 'anthropic';
    }
    expect(warmCache).not.toHaveBeenCalled();
  });
});
