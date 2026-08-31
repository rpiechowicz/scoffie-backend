import { AgentProviderError } from './agent-provider';
import {
  STUB_ERROR_MARKER,
  STUB_UPSTREAM_ERROR_MARKER,
  StubAgentProvider,
} from './stub-agent.provider';

describe('StubAgentProvider', () => {
  const original = process.env.AI_STUB_DELAY_MS;
  const provider = new StubAgentProvider();

  const run = (text: string, signal = new AbortController().signal) =>
    provider.run({
      model: 'claude-sonnet-5',
      messages: [
        { role: 'ASSISTANT', text: 'stara odpowiedź' },
        { role: 'USER', text },
      ],
      signal,
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

  it('sygnał przerwany jeszcze przed startem też kończy turę', async () => {
    process.env.AI_STUB_DELAY_MS = '5000';
    const controller = new AbortController();
    controller.abort();
    await expect(run('x', controller.signal)).rejects.toBeInstanceOf(
      AgentProviderError,
    );
  });
});
