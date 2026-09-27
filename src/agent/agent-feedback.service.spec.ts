import { AppException } from '../common/app-exception';
import { PrismaService } from '../prisma/prisma.service';
import { AgentFeedbackService } from './agent-feedback.service';

const USER = '11111111-1111-4111-8111-111111111111';
const MESSAGE = '22222222-2222-4222-8222-222222222222';
const TURN = '33333333-3333-4333-8333-333333333333';

describe('AgentFeedbackService', () => {
  const prisma = {
    agentMessage: { findFirst: jest.fn() },
    agentMessageFeedback: { upsert: jest.fn(), deleteMany: jest.fn() },
  };
  const service = new AgentFeedbackService(prisma as unknown as PrismaService);

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.agentMessage.findFirst.mockResolvedValue({
      id: MESSAGE,
      turnId: TURN,
    });
  });

  const codeOf = async (promise: Promise<unknown>) => {
    try {
      await promise;
      return null;
    } catch (error) {
      expect(error).toBeInstanceOf(AppException);
      return (error as AppException).code;
    }
  };

  it('kciuk zapisuje ocenę — jedna na osobę i wiadomość (upsert)', async () => {
    const result = await service.rate(USER, MESSAGE, { rating: 'UP' });
    expect(result).toEqual({ messageId: MESSAGE, rating: 'UP' });
    expect(prisma.agentMessageFeedback.upsert).toHaveBeenCalledWith({
      where: { userId_messageId: { userId: USER, messageId: MESSAGE } },
      create: { userId: USER, messageId: MESSAGE, turnId: TURN, rating: 'UP' },
      update: { rating: 'UP' },
    });
  });

  it('`null` zdejmuje ocenę', async () => {
    const result = await service.rate(USER, MESSAGE, { rating: null });
    expect(result).toEqual({ messageId: MESSAGE, rating: null });
    expect(prisma.agentMessageFeedback.deleteMany).toHaveBeenCalledWith({
      where: { userId: USER, messageId: MESSAGE },
    });
    expect(prisma.agentMessageFeedback.upsert).not.toHaveBeenCalled();
  });

  it('ocenia się tylko własne odpowiedzi asystenta — reszta to 404', async () => {
    prisma.agentMessage.findFirst.mockResolvedValue(null);
    expect(await codeOf(service.rate(USER, MESSAGE, { rating: 'DOWN' }))).toBe(
      'AI_MESSAGE_NOT_FOUND',
    );
    expect(prisma.agentMessage.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: MESSAGE,
          role: 'ASSISTANT',
          conversation: { userId: USER },
        },
      }),
    );
  });

  it('brak pola `rating` i wartości spoza listy są błędem walidacji', async () => {
    expect(
      await codeOf(service.rate(USER, MESSAGE, {} as { rating: null })),
    ).not.toBeNull();
    expect(
      await codeOf(
        service.rate(USER, MESSAGE, { rating: 'MEH' as unknown as 'UP' }),
      ),
    ).not.toBeNull();
    expect(prisma.agentMessageFeedback.upsert).not.toHaveBeenCalled();
  });

  it('nie-UUID zatrzymuje się przed Prismą', async () => {
    expect(
      await codeOf(service.rate(USER, 'x', { rating: 'UP' })),
    ).not.toBeNull();
    expect(prisma.agentMessage.findFirst).not.toHaveBeenCalled();
  });
});
