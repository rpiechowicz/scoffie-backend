import { ConsentsService } from '../consents/consents.service';
import { HouseholdsService } from '../households/households.service';
import { PrismaService } from '../prisma/prisma.service';
import { AgentMemoryService } from './agent-memory.service';
import { AgentPromptService } from './agent-prompt.service';

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

describe('AgentPromptService.membersForModel', () => {
  const original = process.env.AI_CONSENT_REQUIRED;
  let consents: { usersWithValid: jest.Mock };
  let service: AgentPromptService;
  const members = [
    { userId: A, displayName: 'Ania' },
    { userId: B, displayName: 'Bartek' },
  ];

  beforeEach(() => {
    consents = { usersWithValid: jest.fn().mockResolvedValue(new Set([A])) };
    service = new AgentPromptService(
      {} as PrismaService,
      {} as HouseholdsService,
      {} as AgentMemoryService,
      consents as unknown as ConsentsService,
    );
  });

  afterEach(() => {
    if (original === undefined) delete process.env.AI_CONSENT_REQUIRED;
    else process.env.AI_CONSENT_REQUIRED = original;
  });

  it('bez bramki zgód: wszyscy domownicy, bez pytania o zgody', async () => {
    delete process.env.AI_CONSENT_REQUIRED;
    const result = await service.membersForModel(members);
    expect(result).toEqual({ members, withheld: 0 });
    expect(consents.usersWithValid).not.toHaveBeenCalled();
  });

  it('z bramką: do modelu idą tylko domownicy z własną zgodą, reszta jest policzona', async () => {
    // Zgoda Ani nie obejmuje Bartka — jego alergie to jego dane o zdrowiu.
    process.env.AI_CONSENT_REQUIRED = 'true';
    const result = await service.membersForModel(members);
    expect(result.members.map((m) => m.userId)).toEqual([A]);
    expect(result.withheld).toBe(1);
    expect(consents.usersWithValid).toHaveBeenCalledWith(
      [A, B],
      'AI_ASSISTANT',
    );
  });
});
