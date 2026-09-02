import { PrismaService } from '../prisma/prisma.service';
import { AgentRetentionService } from './agent-retention.service';

describe('AgentRetentionService.sweep', () => {
  const original = process.env.AI_CONVERSATION_RETENTION_DAYS;
  const NOW = new Date('2026-09-02T12:00:00.000Z');
  let prisma: {
    agentConversation: { deleteMany: jest.Mock };
    invitation: { deleteMany: jest.Mock };
  };
  let service: AgentRetentionService;

  beforeEach(() => {
    delete process.env.AI_CONVERSATION_RETENTION_DAYS;
    prisma = {
      agentConversation: {
        deleteMany: jest.fn().mockResolvedValue({ count: 3 }),
      },
      invitation: { deleteMany: jest.fn().mockResolvedValue({ count: 1 }) },
    };
    service = new AgentRetentionService(prisma as unknown as PrismaService);
  });

  afterEach(() => {
    if (original === undefined)
      delete process.env.AI_CONVERSATION_RETENTION_DAYS;
    else process.env.AI_CONVERSATION_RETENTION_DAYS = original;
    service.onModuleDestroy();
  });

  it('kasuje rozmowy starsze niż 90 dni od ostatniej wiadomości, omijając tury w biegu', async () => {
    const result = await service.sweep(NOW);
    const cutoff = new Date('2026-06-04T12:00:00.000Z');
    expect(result).toEqual({
      cutoff: cutoff.toISOString(),
      conversations: 3,
      invitations: 1,
    });
    expect(prisma.agentConversation.deleteMany).toHaveBeenCalledWith({
      where: {
        OR: [
          { lastMessageAt: { lt: cutoff } },
          { lastMessageAt: null, createdAt: { lt: cutoff } },
        ],
        turns: { none: { status: 'RUNNING' } },
      },
    });
  });

  it('zaproszenia: wygasłe ponad 30 dni temu i nieprzyjęte', async () => {
    await service.sweep(NOW);
    expect(prisma.invitation.deleteMany).toHaveBeenCalledWith({
      where: {
        redeemedAt: null,
        expiresAt: { lt: new Date('2026-08-03T12:00:00.000Z') },
      },
    });
  });

  it('AI_CONVERSATION_RETENTION_DAYS=0 wyłącza retencję rozmów, nie zaproszeń', async () => {
    process.env.AI_CONVERSATION_RETENTION_DAYS = '0';
    const result = await service.sweep(NOW);
    expect(result.cutoff).toBeNull();
    expect(result.conversations).toBe(0);
    expect(prisma.agentConversation.deleteMany).not.toHaveBeenCalled();
    expect(prisma.invitation.deleteMany).toHaveBeenCalled();
  });

  it('timery nie trzymają procesu i są sprzątane przy zamknięciu modułu', () => {
    service.onApplicationBootstrap();
    service.onModuleDestroy();
    // Drugie zamknięcie jest bezpieczne (idempotentne).
    service.onModuleDestroy();
  });
});
