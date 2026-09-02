import { AppException } from '../common/app-exception';
import { PrismaService } from '../prisma/prisma.service';
import { AgentConfigService } from './agent-config.service';
import { AgentProposalsService } from './proposals/agent-proposals.service';
import {
  AgentConversationsService,
  CONVERSATION_TITLE_MAX,
  conversationTitleFrom,
} from './agent-conversations.service';

const HOUSEHOLD = 'a00f55ec-8500-4b44-85e6-561bfba4dbad';
const CONVERSATION = '11111111-1111-4111-8111-111111111111';
const MESSAGE = '22222222-2222-4222-8222-222222222222';
const USER = 'd4999c6e-ad7a-4810-b57e-9131ff1cea1b';

describe('AgentConversationsService', () => {
  const prisma = {
    agentConversation: {
      create: jest.fn(),
      findMany: jest.fn(),
      findFirst: jest.fn(),
      deleteMany: jest.fn(),
    },
    agentMessage: { findMany: jest.fn(), findFirst: jest.fn() },
    membership: { findUnique: jest.fn() },
  };
  const config = {
    assertEnabled: jest.fn(),
    assertUserAllowed: jest.fn().mockResolvedValue(undefined),
    read: jest.fn(),
  };
  // Stan kart dokłada serwis propozycji; tutaj przepuszczamy wiadomości bez
  // zmian, bo te testy sprawdzają historię, nie karty.
  const proposals = { withCardState: jest.fn((messages: unknown) => messages) };
  const service = new AgentConversationsService(
    prisma as unknown as PrismaService,
    config as unknown as AgentConfigService,
    proposals as unknown as AgentProposalsService,
  );

  const conversationRow = {
    id: CONVERSATION,
    userId: USER,
    householdId: HOUSEHOLD,
    status: 'OPEN',
    title: null,
    lastMessageAt: null,
    createdAt: new Date('2026-08-31T10:00:00.000Z'),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.membership.findUnique.mockResolvedValue({ userId: USER });
    prisma.agentConversation.findFirst.mockResolvedValue(conversationRow);
    prisma.agentConversation.create.mockResolvedValue(conversationRow);
    prisma.agentMessage.findMany.mockResolvedValue([]);
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

  describe('create', () => {
    it('waliduje DTO w serwisie — asystent in-process nie przechodzi przez pipe', async () => {
      expect(
        await codeOf(service.create(USER, { householdId: 'nie-uuid' })),
      ).toBe('VALIDATION_ERROR');
      expect(prisma.agentConversation.create).not.toHaveBeenCalled();
    });

    it('nie-członek gospodarstwa dostaje 403', async () => {
      prisma.membership.findUnique.mockResolvedValue(null);
      expect(
        await codeOf(service.create(USER, { householdId: HOUSEHOLD })),
      ).toBe('NOT_HOUSEHOLD_MEMBER');
    });

    it('oddaje daty jako ISO, nie obiekty Date', async () => {
      const view = await service.create(USER, { householdId: HOUSEHOLD });
      expect(view).toEqual({
        id: CONVERSATION,
        householdId: HOUSEHOLD,
        status: 'OPEN',
        title: null,
        lastMessageAt: null,
        createdAt: '2026-08-31T10:00:00.000Z',
      });
    });

    it('wyłączony asystent zatrzymuje się przed bazą', async () => {
      config.assertEnabled.mockImplementation(() => {
        throw new AppException('AI_DISABLED', 'nie', 503);
      });
      expect(
        await codeOf(service.create(USER, { householdId: HOUSEHOLD })),
      ).toBe('AI_DISABLED');
      expect(prisma.membership.findUnique).not.toHaveBeenCalled();
      config.assertEnabled.mockReset();
    });
  });

  describe('loadOwned', () => {
    it('cudza rozmowa wygląda jak nieistniejąca', async () => {
      prisma.agentConversation.findFirst.mockResolvedValue(null);
      expect(await codeOf(service.loadOwned(USER, CONVERSATION))).toBe(
        'AI_CONVERSATION_NOT_FOUND',
      );
      // Filtr po `userId` w zapytaniu, nie porównanie po odczycie.
      expect(prisma.agentConversation.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: CONVERSATION, userId: USER },
        }),
      );
    });

    it('nie-UUID zatrzymuje się przed Prismą (P2023 byłoby 500)', async () => {
      expect(await codeOf(service.loadOwned(USER, 'hh-1'))).toBe(
        'VALIDATION_ERROR',
      );
      expect(prisma.agentConversation.findFirst).not.toHaveBeenCalled();
    });
  });

  describe('messages', () => {
    it('kursor `after` spoza rozmowy jest błędem, nie cichym początkiem historii', async () => {
      prisma.agentMessage.findFirst.mockResolvedValue(null);
      expect(
        await codeOf(service.messages(USER, CONVERSATION, { after: MESSAGE })),
      ).toBe('AI_CONVERSATION_NOT_FOUND');
    });

    it('kursor jest po (createdAt, id) — dwie wiadomości tej samej milisekundy', async () => {
      const createdAt = new Date('2026-08-31T10:00:01.000Z');
      prisma.agentMessage.findFirst.mockResolvedValue({
        id: MESSAGE,
        createdAt,
      });
      await service.messages(USER, CONVERSATION, { after: MESSAGE });
      expect(prisma.agentMessage.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            conversationId: CONVERSATION,
            hiddenAt: null,
            OR: [
              { createdAt: { gt: createdAt } },
              { createdAt, id: { gt: MESSAGE } },
            ],
          },
        }),
      );
    });
  });

  describe('deleteAll', () => {
    it('działa też przy wyłączonym asystencie — RODO nie zależy od flagi', async () => {
      config.assertEnabled.mockImplementation(() => {
        throw new AppException('AI_DISABLED', 'nie', 503);
      });
      prisma.agentConversation.deleteMany.mockResolvedValue({ count: 3 });
      await expect(service.deleteAll(USER)).resolves.toEqual({ deleted: 3 });
      config.assertEnabled.mockReset();
    });
  });
});

describe('conversationTitleFrom', () => {
  it('bierze pierwszą wiadomość i skleja białe znaki', () => {
    expect(conversationTitleFrom('  Co   na\n obiad?  ')).toBe('Co na obiad?');
  });

  it('pusta wiadomość nie robi tytułu ze spacji', () => {
    expect(conversationTitleFrom('   \n  ')).toBeNull();
  });

  it('krótka wiadomość zostaje bez wielokropka', () => {
    expect(conversationTitleFrom('Co na obiad?')).toBe('Co na obiad?');
  });

  it('długą prośbę ucina na granicy słowa, nie w połowie wyrazu', () => {
    // Ucięte słowo w liście rozmów wygląda jak błąd aplikacji, nie jak skrót.
    expect(
      conversationTitleFrom(
        'Zaplanuj mi cały tydzień bezglutenowy dla dwóch osób z alergią na laktozę',
      ),
    ).toBe('Zaplanuj mi cały tydzień bezglutenowy dla dwóch osób z…');
  });

  it('jedno bardzo długie słowo tnie się twardo — nie ma gdzie indziej', () => {
    const title = conversationTitleFrom('a'.repeat(200));
    expect(title).toHaveLength(CONVERSATION_TITLE_MAX + 1);
    expect(title?.endsWith('…')).toBe(true);
  });
});
