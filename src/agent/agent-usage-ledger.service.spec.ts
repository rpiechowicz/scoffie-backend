import { PrismaService } from '../prisma/prisma.service';
import { AgentUsageLedger, LedgerTurn } from './agent-usage-ledger.service';
import { AiUsageCountersService } from './ai-usage-counters.service';
import { AgentProviderCall } from './providers/agent-provider';

const TURN = '44444444-4444-4444-8444-444444444444';
const USER = 'd4999c6e-ad7a-4810-b57e-9131ff1cea1b';
const HOUSEHOLD = 'a00f55ec-8500-4b44-85e6-561bfba4dbad';

const TURN_CTX: LedgerTurn = {
  turnId: TURN,
  userId: USER,
  householdId: HOUSEHOLD,
  provider: 'anthropic',
  env: {
    householdDailyCostUsd: null,
    householdMonthlyCostUsd: null,
    globalDailyBudgetUsd: null,
  },
};

const call = (
  costMicroUsd: number,
  over: Partial<AgentProviderCall> = {},
): AgentProviderCall => ({
  callIndex: 2,
  model: 'claude-sonnet-5',
  effort: 'medium',
  usage: {
    inputTokens: 120,
    cacheReadTokens: 900,
    cacheWriteTokens: 0,
    outputTokens: 40,
    costMicroUsd,
  },
  stopReason: 'tool_use',
  latencyMs: 1500,
  ...over,
});

/**
 * Księga kosztu per wywołanie — na atrapie transakcji. Realny wyścig z
 * domknięciem tury (leniwy timeout, „Stop" spoza procesu, restart) sprawdza
 * `test/agent-accounting.e2e-spec.ts` na żywej bazie.
 */
describe('AgentUsageLedger', () => {
  const tx = {
    agentTurn: { findUnique: jest.fn(), updateMany: jest.fn() },
    aiUsage: { createMany: jest.fn() },
  };
  const prisma = {
    $transaction: jest.fn(async (cb: (client: typeof tx) => Promise<unknown>) =>
      cb(tx),
    ),
  };
  const counters = {
    add: jest.fn(),
    addHouseholdCost: jest.fn(),
    read: jest.fn(),
    dayKey: jest.fn().mockReturnValue('2026-09-26'),
    monthKey: jest.fn().mockReturnValue('2026-09'),
  };
  let ledger: AgentUsageLedger;

  beforeEach(() => {
    jest.clearAllMocks();
    tx.agentTurn.findUnique.mockResolvedValue({
      quotaScopeId: `sub:${HOUSEHOLD}`,
      quotaPeriodKey: 'okres:2026-10-15',
      startedAt: new Date('2026-09-26T10:00:00Z'),
    });
    tx.agentTurn.updateMany.mockResolvedValue({ count: 0 });
    tx.aiUsage.createMany.mockResolvedValue({ count: 1 });
    counters.read.mockResolvedValue(0);
    ledger = new AgentUsageLedger(
      prisma as unknown as PrismaService,
      counters as unknown as AiUsageCountersService,
    );
  });

  describe('record', () => {
    it('jeden wiersz na wywołanie z kluczem (turnId, callIndex), przyrost tury i liczniki sufitów', async () => {
      await expect(ledger.record(TURN_CTX, call(3000))).resolves.toEqual({
        budgetExceeded: false,
      });

      expect(tx.aiUsage.createMany).toHaveBeenCalledWith({
        data: [
          expect.objectContaining({
            callKey: `turn:${TURN}:2`,
            turnId: TURN,
            callIndex: 2,
            userId: USER,
            householdId: HOUSEHOLD,
            provider: 'anthropic',
            model: 'claude-sonnet-5',
            effort: 'medium',
            inputTokens: 120,
            cacheReadTokens: 900,
            outputTokens: 40,
            costMicroUsd: 3000,
            apiCalls: 1,
            stopReason: 'tool_use',
            latencyMs: 1500,
          }),
        ],
        skipDuplicates: true,
      });
      // Przyrost, nie nadpisanie — i BEZ warunku na status: koszt dojeżdża
      // także do tury domkniętej z zewnątrz.
      expect(tx.agentTurn.updateMany).toHaveBeenCalledWith({
        where: { id: TURN },
        data: {
          inputTokens: { increment: 120 },
          outputTokens: { increment: 40 },
          costMicroUsd: { increment: 3000 },
        },
      });
      expect(counters.addHouseholdCost).toHaveBeenCalledWith(
        tx,
        HOUSEHOLD,
        3000,
      );
      expect(counters.add).toHaveBeenCalledWith(
        tx,
        'global',
        '2026-09-26',
        'costMicroUsd',
        3000,
      );
    });

    it('to samo wywołanie drugi raz (ponowienie) niczego nie dolicza', async () => {
      tx.aiUsage.createMany.mockResolvedValue({ count: 0 });
      await ledger.record(TURN_CTX, call(3000));
      expect(tx.agentTurn.updateMany).not.toHaveBeenCalled();
      expect(counters.addHouseholdCost).not.toHaveBeenCalled();
      expect(counters.add).not.toHaveBeenCalled();
    });

    it('koszt dojechał do tury, która oddała już wiadomość: zwrot cofnięty, wiadomość z powrotem w liczniku', async () => {
      tx.agentTurn.updateMany
        .mockResolvedValueOnce({ count: 1 }) // przyrost
        .mockResolvedValueOnce({ count: 1 }); // quotaRefunded true → false

      await ledger.record(TURN_CTX, call(3000));

      expect(tx.agentTurn.updateMany).toHaveBeenNthCalledWith(2, {
        where: { id: TURN, quotaRefunded: true },
        data: { quotaRefunded: false },
      });
      // Do zakresu i okresu Z CHWILI POBRANIA, nie do domu ani miesiąca.
      expect(counters.add).toHaveBeenCalledWith(
        tx,
        `sub:${HOUSEHOLD}`,
        'okres:2026-10-15',
        'messages',
        1,
      );
    });

    it('wywołanie za 0 nie rusza zwrotu', async () => {
      await ledger.record(TURN_CTX, call(0));
      expect(tx.agentTurn.updateMany).toHaveBeenCalledTimes(1);
      expect(counters.add).not.toHaveBeenCalledWith(
        tx,
        expect.anything(),
        expect.anything(),
        'messages',
        expect.anything(),
      );
    });

    it('tura zniknęła (rozmowa skasowana): wiersz bez tury, ale liczniki kosztu dostają pieniądze', async () => {
      tx.agentTurn.findUnique.mockResolvedValue(null);
      await ledger.record(TURN_CTX, call(3000));
      expect(tx.aiUsage.createMany).toHaveBeenCalledWith({
        // Klucz idempotencji ten sam co przy żywej turze — ponowienie po
        // skasowaniu rozmowy trafia w unikat (e2e: agent-accounting).
        data: [
          expect.objectContaining({
            turnId: null,
            callIndex: 2,
            callKey: `turn:${TURN}:2`,
          }),
        ],
        skipDuplicates: true,
      });
      expect(tx.agentTurn.updateMany).not.toHaveBeenCalled();
      expect(counters.addHouseholdCost).toHaveBeenCalledWith(
        tx,
        HOUSEHOLD,
        3000,
      );
    });

    it('werdykt budżetu: licznik po zapisie ≥ sufit (odczyt w tej samej transakcji)', async () => {
      counters.read.mockImplementation((scope: string, period: string) =>
        Promise.resolve(
          scope === HOUSEHOLD && period === '2026-09-26' ? 1_500_000 : 0,
        ),
      );
      const verdict = await ledger.record(
        {
          ...TURN_CTX,
          env: { ...TURN_CTX.env, householdDailyCostUsd: 1.5 },
        },
        call(3000),
      );
      expect(verdict).toEqual({ budgetExceeded: true });
      expect(counters.read).toHaveBeenCalledWith(
        HOUSEHOLD,
        '2026-09-26',
        'costMicroUsd',
        tx,
      );
    });

    it('sufit instalacji też zatrzymuje turę', async () => {
      counters.read.mockImplementation((scope: string) =>
        Promise.resolve(scope === 'global' ? 5_000_000 : 0),
      );
      const verdict = await ledger.record(
        { ...TURN_CTX, env: { ...TURN_CTX.env, globalDailyBudgetUsd: 5 } },
        call(3000),
      );
      expect(verdict).toEqual({ budgetExceeded: true });
    });

    it('zapis zastępczy niesie apiCalls z wywołującego (także null)', async () => {
      await ledger.record(TURN_CTX, call(3000, { apiCalls: null }));
      expect(tx.aiUsage.createMany).toHaveBeenCalledWith({
        data: [expect.objectContaining({ apiCalls: null })],
        skipDuplicates: true,
      });
    });
  });

  describe('refundIfFree', () => {
    it('tura z kosztem albo już zwrócona: nic (warunek w samym updateMany)', async () => {
      tx.agentTurn.updateMany.mockResolvedValue({ count: 0 });
      await expect(
        ledger.refundIfFree(tx as never, TURN, HOUSEHOLD),
      ).resolves.toBe(false);
      expect(tx.agentTurn.updateMany).toHaveBeenCalledWith({
        where: { id: TURN, quotaRefunded: false, costMicroUsd: 0 },
        data: { quotaRefunded: true },
      });
      expect(counters.add).not.toHaveBeenCalled();
    });

    it('darmowa tura: flaga i wiadomość wraca TAM, skąd zeszła', async () => {
      tx.agentTurn.updateMany.mockResolvedValue({ count: 1 });
      await expect(
        ledger.refundIfFree(tx as never, TURN, HOUSEHOLD),
      ).resolves.toBe(true);
      expect(counters.add).toHaveBeenCalledWith(
        tx,
        `sub:${HOUSEHOLD}`,
        'okres:2026-10-15',
        'messages',
        -1,
      );
    });

    it('tura sprzed kolumn zakresu: zwrot do domu i miesiąca startu', async () => {
      tx.agentTurn.updateMany.mockResolvedValue({ count: 1 });
      tx.agentTurn.findUnique.mockResolvedValue({
        quotaScopeId: null,
        quotaPeriodKey: null,
        startedAt: new Date('2026-08-31T23:59:00Z'),
      });
      await ledger.refundIfFree(tx as never, TURN, HOUSEHOLD);
      expect(counters.monthKey).toHaveBeenCalledWith(
        new Date('2026-08-31T23:59:00Z'),
      );
      expect(counters.add).toHaveBeenCalledWith(
        tx,
        HOUSEHOLD,
        '2026-09',
        'messages',
        -1,
      );
    });
  });

  describe('closeTurn', () => {
    it('domyka warunkowo po RUNNING, bez dotykania kosztu, potem zwrot za darmową', async () => {
      tx.agentTurn.updateMany
        .mockResolvedValueOnce({ count: 1 })
        .mockResolvedValueOnce({ count: 1 });
      await expect(
        ledger.closeTurn(tx as never, {
          turnId: TURN,
          errorCode: 'AI_PROVIDER_ERROR',
          fallbackScopeId: HOUSEHOLD,
        }),
      ).resolves.toBe(true);
      expect(tx.agentTurn.updateMany).toHaveBeenNthCalledWith(1, {
        where: { id: TURN, status: 'RUNNING' },
        data: {
          status: 'FAILED',
          errorCode: 'AI_PROVIDER_ERROR',
          finishedAt: expect.any(Date),
        },
      });
      expect(counters.add).toHaveBeenCalledWith(
        tx,
        `sub:${HOUSEHOLD}`,
        'okres:2026-10-15',
        'messages',
        -1,
      );
    });

    it('tura już domknięta (count = 0): bez zwrotu', async () => {
      tx.agentTurn.updateMany.mockResolvedValue({ count: 0 });
      await expect(
        ledger.closeTurn(tx as never, {
          turnId: TURN,
          errorCode: 'AI_TIMEOUT',
          fallbackScopeId: HOUSEHOLD,
        }),
      ).resolves.toBe(false);
      expect(tx.agentTurn.updateMany).toHaveBeenCalledTimes(1);
      expect(counters.add).not.toHaveBeenCalled();
    });
  });
});
