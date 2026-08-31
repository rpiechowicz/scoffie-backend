import { PrismaService } from '../prisma/prisma.service';
import { AiUsageCountersService } from './ai-usage-counters.service';

describe('AiUsageCountersService', () => {
  const upsert = jest.fn();
  const updateMany = jest.fn();
  const findUnique = jest.fn();
  const client = {
    aiUsageCounter: { upsert, updateMany, findUnique },
  } as unknown as PrismaService;
  const service = new AiUsageCountersService(client);

  beforeEach(() => {
    upsert.mockReset().mockResolvedValue(undefined);
    updateMany.mockReset().mockResolvedValue({ count: 1 });
    findUnique.mockReset().mockResolvedValue(null);
  });

  describe('klucze okresów (UTC)', () => {
    it('miesiąc i dzień liczone w UTC, nie w strefie serwera', () => {
      const at = new Date('2026-08-31T23:30:00.000Z');
      expect(service.monthKey(at)).toBe('2026-08');
      expect(service.dayKey(at)).toBe('2026-08-31');
    });
  });

  describe('tryConsume', () => {
    it('zdejmuje kwotę jednym warunkowym updateMany', async () => {
      await expect(
        service.tryConsume(client, 'dom', '2026-08', 'messages', 200),
      ).resolves.toBe(true);

      expect(upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: {
            scopeId: 'dom',
            periodKey: '2026-08',
            kind: 'messages',
            value: 0,
          },
          update: {},
        }),
      );
      expect(updateMany).toHaveBeenCalledWith({
        where: {
          scopeId: 'dom',
          periodKey: '2026-08',
          kind: 'messages',
          value: { lt: 200 },
        },
        data: { value: { increment: 1 } },
      });
    });

    it('brak podniesionego wiersza = limit wyczerpany', async () => {
      updateMany.mockResolvedValue({ count: 0 });
      await expect(
        service.tryConsume(client, 'dom', '2026-08', 'messages', 200),
      ).resolves.toBe(false);
    });

    it('limit 0 nigdy nie przechodzi i nie rusza bazy', async () => {
      await expect(
        service.tryConsume(client, 'dom', '2026-08', 'messages', 0),
      ).resolves.toBe(false);
      expect(upsert).not.toHaveBeenCalled();
      expect(updateMany).not.toHaveBeenCalled();
    });
  });

  describe('add', () => {
    it('delta 0 nie robi nic', async () => {
      await service.add(client, 'dom', '2026-08', 'messages', 0);
      expect(upsert).not.toHaveBeenCalled();
    });

    it('zwrot kwoty podcina licznik do zera', async () => {
      await service.add(client, 'dom', '2026-08', 'messages', -1);
      expect(upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({ value: 0 }),
          update: { value: { increment: -1 } },
        }),
      );
      expect(updateMany).toHaveBeenCalledWith({
        where: {
          scopeId: 'dom',
          periodKey: '2026-08',
          kind: 'messages',
          value: { lt: 0 },
        },
        data: { value: 0 },
      });
    });

    it('dodatnia delta nie odpala podcinania', async () => {
      await service.add(client, 'global', '2026-08-31', 'costMicroUsd', 1234);
      expect(updateMany).not.toHaveBeenCalled();
    });
  });

  describe('read', () => {
    it('brak wiersza to zero, nie null', async () => {
      await expect(
        service.read('global', '2026-08-31', 'costMicroUsd'),
      ).resolves.toBe(0);
    });

    it('oddaje zapisaną wartość', async () => {
      findUnique.mockResolvedValue({ value: 42 });
      await expect(service.read('dom', '2026-08', 'messages')).resolves.toBe(
        42,
      );
    });
  });
});
