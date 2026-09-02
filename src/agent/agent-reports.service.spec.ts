import { PrismaService } from '../prisma/prisma.service';
import { AgentReportsService } from './agent-reports.service';

const USER = '3fa85f64-5717-4562-b3fc-2c963f66afa6';
const MESSAGE = '22222222-2222-4222-8222-222222222222';
const CONVERSATION = '11111111-1111-4111-8111-111111111111';
const TURN = '44444444-4444-4444-8444-444444444444';

describe('AgentReportsService', () => {
  let prisma: {
    agentMessage: { findFirst: jest.Mock };
    agentReport: { create: jest.Mock };
  };
  let service: AgentReportsService;

  beforeEach(() => {
    prisma = {
      agentMessage: {
        findFirst: jest.fn().mockResolvedValue({
          id: MESSAGE,
          conversationId: CONVERSATION,
          turnId: TURN,
          text: 'Na kolację proponuję leczo.',
        }),
      },
      agentReport: {
        create: jest.fn().mockResolvedValue({
          id: 'r-1',
          createdAt: new Date('2026-09-02T12:00:00.000Z'),
        }),
      },
    };
    service = new AgentReportsService(prisma as unknown as PrismaService);
  });

  it('zapisuje zgłoszenie z migawką treści, tylko dla własnej odpowiedzi asystenta', async () => {
    const result = await service.report(USER, MESSAGE, {
      reason: 'WRONG',
      comment: '  Leczo ma paprykę, której nie jem.  ',
    });
    expect(result).toEqual({
      id: 'r-1',
      createdAt: '2026-09-02T12:00:00.000Z',
    });
    expect(prisma.agentMessage.findFirst).toHaveBeenCalledWith({
      where: { id: MESSAGE, role: 'ASSISTANT', conversation: { userId: USER } },
      select: { id: true, conversationId: true, turnId: true, text: true },
    });
    expect(prisma.agentReport.create).toHaveBeenCalledWith({
      data: {
        userId: USER,
        conversationId: CONVERSATION,
        messageId: MESSAGE,
        turnId: TURN,
        reason: 'WRONG',
        comment: 'Leczo ma paprykę, której nie jem.',
        messageText: 'Na kolację proponuję leczo.',
      },
      select: { id: true, createdAt: true },
    });
  });

  it('cudza albo nieistniejąca wiadomość = 404 AI_MESSAGE_NOT_FOUND, nic nie zapisane', async () => {
    prisma.agentMessage.findFirst.mockResolvedValue(null);
    await expect(
      service.report(USER, MESSAGE, { reason: 'OTHER' }),
    ).rejects.toMatchObject({ response: { code: 'AI_MESSAGE_NOT_FOUND' } });
    expect(prisma.agentReport.create).not.toHaveBeenCalled();
  });

  it('nieznany powód i nie-UUID = VALIDATION_ERROR przed odczytem bazy', async () => {
    await expect(
      service.report(USER, MESSAGE, { reason: 'MEH' } as never),
    ).rejects.toMatchObject({ response: { code: 'VALIDATION_ERROR' } });
    await expect(
      service.report(USER, 'abc', { reason: 'OTHER' }),
    ).rejects.toMatchObject({ response: { code: 'VALIDATION_ERROR' } });
    expect(prisma.agentMessage.findFirst).not.toHaveBeenCalled();
  });
});
