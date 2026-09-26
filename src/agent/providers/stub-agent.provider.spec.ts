import { AgentProviderError } from './agent-provider';
import {
  STUB_ERROR_MARKER,
  STUB_UPSTREAM_ERROR_MARKER,
  StubAgentProvider,
} from './stub-agent.provider';

describe('StubAgentProvider', () => {
  const original = process.env.AI_STUB_DELAY_MS;
  const provider = new StubAgentProvider();

  const run = (
    text: string,
    signal = new AbortController().signal,
    onUsage?: jest.Mock,
  ) =>
    provider.run({
      model: 'claude-sonnet-5',
      effort: 'medium',
      system: [],
      tools: [],
      executeTool: jest.fn(),
      messages: [
        { role: 'ASSISTANT', text: 'stara odpowiedź' },
        { role: 'USER', text },
      ],
      signal,
      maxTurnCostUsd: null,
      ...(onUsage ? { onUsage } : {}),
    });

  afterEach(() => {
    if (original === undefined) delete process.env.AI_STUB_DELAY_MS;
    else process.env.AI_STUB_DELAY_MS = original;
  });

  it('odpowiada na OSTATNIĄ wiadomość użytkownika i oddaje niezerowe zużycie', async () => {
    const result = await run('co na obiad?');
    expect(result.text).toBe('[stub] co na obiad?');
    expect(result.stopReason).toBe('end_turn');
    expect(result.usage.inputTokens).toBeGreaterThan(0);
    expect(result.usage.outputTokens).toBeGreaterThan(0);
  });

  it('marker upstream daje błąd retryable (kwota wraca, bezpiecznik liczy)', async () => {
    await expect(run(`x ${STUB_UPSTREAM_ERROR_MARKER}`)).rejects.toMatchObject({
      name: 'AgentProviderError',
      retryable: true,
    });
  });

  it('marker błędu daje porażkę bez zwrotu kwoty', async () => {
    await expect(run(`x ${STUB_ERROR_MARKER}`)).rejects.toMatchObject({
      retryable: false,
    });
  });

  it('respektuje AbortSignal — timeout tury przerywa opóźnienie', async () => {
    process.env.AI_STUB_DELAY_MS = '5000';
    const controller = new AbortController();
    const promise = run('długa tura', controller.signal);
    controller.abort();
    await expect(promise).rejects.toBeInstanceOf(AgentProviderError);
  });

  it('bez markera kosztu melduje JEDNO wywołanie za 0', async () => {
    const onUsage = jest.fn().mockResolvedValue({ budgetExceeded: false });
    const result = await run('co na obiad?', undefined, onUsage);
    expect(onUsage).toHaveBeenCalledTimes(1);
    expect(onUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        callIndex: 0,
        usage: expect.objectContaining({ costMicroUsd: 0 }),
      }),
    );
    expect(result.apiCalls).toBe(1);
  });

  it('[[cost:N]]: wywołanie 0 za N melduje się PRZED opóźnieniem, wywołanie 1 za 0 po nim', async () => {
    process.env.AI_STUB_DELAY_MS = '5000';
    const onUsage = jest.fn().mockResolvedValue({ budgetExceeded: false });
    const controller = new AbortController();
    const promise = run('tydzień [[cost:7000]]', controller.signal, onUsage);
    await new Promise((resolve) => setImmediate(resolve));
    // Przerwanie w opóźnieniu: pierwsze wywołanie już jest w księdze,
    // a błąd niesie jego zużycie — jak u prawdziwego dostawcy.
    expect(onUsage).toHaveBeenCalledTimes(1);
    expect(onUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        callIndex: 0,
        usage: expect.objectContaining({ costMicroUsd: 7000 }),
      }),
    );
    controller.abort();
    await expect(promise).rejects.toMatchObject({
      usage: expect.objectContaining({ costMicroUsd: 7000 }),
    });

    process.env.AI_STUB_DELAY_MS = '0';
    onUsage.mockClear();
    const result = await run('tydzień [[cost:7000]]', undefined, onUsage);
    expect(onUsage).toHaveBeenCalledTimes(2);
    expect(onUsage).toHaveBeenLastCalledWith(
      expect.objectContaining({
        callIndex: 1,
        usage: expect.objectContaining({ costMicroUsd: 0 }),
      }),
    );
    expect(result.usage.costMicroUsd).toBe(7000);
    expect(result.apiCalls).toBe(2);
  });

  it('sygnał przerwany jeszcze przed startem też kończy turę', async () => {
    process.env.AI_STUB_DELAY_MS = '5000';
    const controller = new AbortController();
    controller.abort();
    await expect(run('x', controller.signal)).rejects.toBeInstanceOf(
      AgentProviderError,
    );
  });
});
