import { AppException } from '../common/app-exception';
import {
  LEGAL_DOCUMENT_VERSIONS,
  MINIMUM_CONSENT_VERSIONS,
} from '../common/legal-documents';
import { PrismaService } from '../prisma/prisma.service';
import { ConsentsService } from './consents.service';

const USER = '3fa85f64-5717-4562-b3fc-2c963f66afa6';
const OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

type Row = {
  userId: string;
  kind: string;
  action: string;
  documentVersion: string;
  createdAt: Date;
};

describe('ConsentsService', () => {
  let rows: Row[];
  let prisma: { consentEvent: { findMany: jest.Mock; create: jest.Mock } };
  let service: ConsentsService;

  const at = (iso: string) => new Date(iso);

  beforeEach(() => {
    rows = [];
    prisma = {
      consentEvent: {
        // Serwis prosi o kolejność malejącą — mock ją respektuje, bo na niej
        // stoi „pierwszy napotkany = ostatni w czasie".
        findMany: jest
          .fn()
          .mockImplementation(({ where }: any) =>
            Promise.resolve(
              rows
                .filter(
                  (r) =>
                    where.userId.in.includes(r.userId) &&
                    (!where.kind || r.kind === where.kind),
                )
                .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()),
            ),
          ),
        create: jest.fn().mockImplementation(({ data }: any) => {
          rows.push({ ...data, createdAt: new Date() });
          return Promise.resolve({});
        }),
      },
    };
    service = new ConsentsService(prisma as unknown as PrismaService);
  });

  it('bez zdarzeń: nic nie jest przyznane, ale klient wie, jaką wersję pokazać', async () => {
    const status = await service.status(USER);
    expect(status).toHaveLength(5);
    for (const entry of status) {
      expect(entry.granted).toBe(false);
      expect(entry.documentVersion).toBeNull();
      expect(entry.currentVersion).toBe(LEGAL_DOCUMENT_VERSIONS[entry.kind]);
      expect(entry.minimumVersion).toBe(MINIMUM_CONSENT_VERSIONS[entry.kind]);
    }
  });

  it('ostatnie zdarzenie wygrywa: GRANTED → REVOKED → GRANTED', async () => {
    rows.push(
      {
        userId: USER,
        kind: 'AI_ASSISTANT',
        action: 'GRANTED',
        documentVersion: '2026-09-02',
        createdAt: at('2026-09-02T10:00:00Z'),
      },
      {
        userId: USER,
        kind: 'AI_ASSISTANT',
        action: 'REVOKED',
        documentVersion: '2026-09-02',
        createdAt: at('2026-09-02T11:00:00Z'),
      },
    );
    expect(await service.hasValid(USER, 'AI_ASSISTANT')).toBe(false);

    rows.push({
      userId: USER,
      kind: 'AI_ASSISTANT',
      action: 'GRANTED',
      documentVersion: '2026-09-02',
      createdAt: at('2026-09-02T12:00:00Z'),
    });
    expect(await service.hasValid(USER, 'AI_ASSISTANT')).toBe(true);
  });

  it('zgoda na starszą wersję niż minimalna jest nieważna; nowsza jest ważna', async () => {
    rows.push({
      userId: USER,
      kind: 'AI_ASSISTANT',
      action: 'GRANTED',
      documentVersion: '2026-01-01',
      createdAt: at('2026-09-02T10:00:00Z'),
    });
    expect(await service.hasValid(USER, 'AI_ASSISTANT')).toBe(false);

    rows.push({
      userId: USER,
      kind: 'AI_ASSISTANT',
      action: 'GRANTED',
      documentVersion: '2027-01-01',
      createdAt: at('2026-09-02T11:00:00Z'),
    });
    expect(await service.hasValid(USER, 'AI_ASSISTANT')).toBe(true);
  });

  it('usersWithValid liczy cały dom jednym zapytaniem i nie miesza rodzajów', async () => {
    rows.push(
      {
        userId: USER,
        kind: 'AI_ASSISTANT',
        action: 'GRANTED',
        documentVersion: '2026-09-02',
        createdAt: at('2026-09-02T10:00:00Z'),
      },
      {
        userId: OTHER,
        kind: 'TERMS',
        action: 'GRANTED',
        documentVersion: '2026-09-02',
        createdAt: at('2026-09-02T10:00:00Z'),
      },
    );
    const valid = await service.usersWithValid(
      [USER, OTHER, USER],
      'AI_ASSISTANT',
    );
    expect(Array.from(valid)).toEqual([USER]);
    expect(prisma.consentEvent.findMany).toHaveBeenCalledTimes(1);
  });

  it('pusta lista użytkowników nie pyta bazy', async () => {
    expect((await service.usersWithValid([], 'AI_ASSISTANT')).size).toBe(0);
    expect(prisma.consentEvent.findMany).not.toHaveBeenCalled();
  });

  it('record waliduje wejście (nieznany rodzaj = VALIDATION_ERROR, nic nie zapisane)', async () => {
    await expect(
      service.record(USER, {
        kind: 'NEWSLETTER',
        action: 'GRANTED',
        documentVersion: '2026-09-02',
      } as never),
    ).rejects.toMatchObject({ response: { code: 'VALIDATION_ERROR' } });
    await expect(
      service.record(USER, {
        kind: 'AI_ASSISTANT',
        action: 'GRANTED',
        documentVersion: 'v2',
      } as never),
    ).rejects.toBeInstanceOf(AppException);
    expect(prisma.consentEvent.create).not.toHaveBeenCalled();
  });

  it('record dopisuje zdarzenie i oddaje świeży stan', async () => {
    const status = await service.record(USER, {
      kind: 'AI_ASSISTANT',
      action: 'GRANTED',
      documentVersion: '2026-09-02',
      source: 'IOS_APP',
    });
    expect(prisma.consentEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: USER,
        kind: 'AI_ASSISTANT',
        action: 'GRANTED',
        documentVersion: '2026-09-02',
        source: 'IOS_APP',
      }),
    });
    expect(status.find((s) => s.kind === 'AI_ASSISTANT')?.granted).toBe(true);
  });
});
