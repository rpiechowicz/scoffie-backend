import { Prisma } from '@prisma/client';
import { AppException } from '../common/app-exception';
import { encryptSecret, parseEncryptionKey } from '../common/crypto.util';
import { PrismaService } from '../prisma/prisma.service';
import {
  CookidooIntegrationService,
  maskCookidooLogin,
} from './cookidoo-integration.service';
import { CookidooServiceClient } from './cookidoo-service.client';

const USER = '3fa85f64-5717-4562-b3fc-2c963f66afa6';
const OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const HOUSEHOLD = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
// 32 bajty w base64 — ten sam sztuczny klucz, co w CI.
const KEY = 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=';

describe('CookidooIntegrationService — flaga COOKIDOO_INTEGRATION_ENABLED', () => {
  const original = {
    flag: process.env.COOKIDOO_INTEGRATION_ENABLED,
    key: process.env.COOKIDOO_ENCRYPTION_KEY,
  };
  let prisma: {
    membership: { findFirst: jest.Mock };
    $transaction: jest.Mock;
    $queryRaw: jest.Mock;
    cookidooIntegration: {
      findUnique: jest.Mock;
      upsert: jest.Mock;
      deleteMany: jest.Mock;
    };
  };
  let client: { validateCredentials: jest.Mock; addToWeek: jest.Mock };
  let service: CookidooIntegrationService;

  beforeEach(() => {
    process.env.COOKIDOO_ENCRYPTION_KEY = KEY;
    delete process.env.COOKIDOO_INTEGRATION_ENABLED;
    prisma = {
      membership: {
        findFirst: jest
          .fn()
          .mockResolvedValue({ householdId: HOUSEHOLD, role: 'OWNER' }),
      },
      // Transakcja zapisu dostaje ten sam obiekt; rola czytana pod blokadą.
      $transaction: jest.fn(),
      $queryRaw: jest.fn().mockResolvedValue([{ role: 'OWNER' }]),
      cookidooIntegration: {
        findUnique: jest.fn().mockResolvedValue(null),
        upsert: jest.fn().mockResolvedValue({}),
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    prisma.$transaction.mockImplementation((run: (tx: unknown) => unknown) =>
      run(prisma),
    );
    client = {
      validateCredentials: jest.fn().mockResolvedValue({ subscription: null }),
      addToWeek: jest.fn().mockResolvedValue({}),
    };
    service = new CookidooIntegrationService(
      prisma as unknown as PrismaService,
      client as unknown as CookidooServiceClient,
    );
  });

  afterEach(() => {
    if (original.flag === undefined)
      delete process.env.COOKIDOO_INTEGRATION_ENABLED;
    else process.env.COOKIDOO_INTEGRATION_ENABLED = original.flag;
    if (original.key === undefined) delete process.env.COOKIDOO_ENCRYPTION_KEY;
    else process.env.COOKIDOO_ENCRYPTION_KEY = original.key;
  });

  it('brak zmiennej = włączona, jak dotąd; status niesie enabled', async () => {
    await expect(service.status(USER)).resolves.toEqual({
      connected: false,
      enabled: true,
    });
  });

  it('wyłączona bez zapisanego hasła: klient ma schować wiersz', async () => {
    process.env.COOKIDOO_INTEGRATION_ENABLED = 'false';
    await expect(service.status(USER)).resolves.toEqual({
      connected: false,
      enabled: false,
    });
  });

  it('wyłączona z zapisanym hasłem: connected zostaje, żeby dało się rozłączyć', async () => {
    process.env.COOKIDOO_INTEGRATION_ENABLED = 'false';
    prisma.cookidooIntegration.findUnique.mockResolvedValueOnce({
      householdId: HOUSEHOLD,
      emailEncrypted: 'zepsute',
      passwordEncrypted: 'zepsute',
      status: 'CONNECTED',
      connectedById: USER,
      lastVerifiedAt: null,
    });
    // E-mail nie do odszyfrowania (obcy klucz) → jak brak wpisu, ale z flagą.
    await expect(service.status(USER)).resolves.toEqual({
      connected: false,
      enabled: false,
    });
    expect(prisma.cookidooIntegration.findUnique).toHaveBeenCalled();
  });

  it('wyłączona: connect i sendToWeek odmawiają PRZED wysłaniem hasła do Vorwerka', async () => {
    process.env.COOKIDOO_INTEGRATION_ENABLED = 'false';
    await expect(
      service.connect(USER, 'a@b.pl', 'tajne'),
    ).rejects.toMatchObject({ code: 'COOKIDOO_DISABLED' });
    await expect(
      service.sendToWeek(USER, HOUSEHOLD, '2026-09-07'),
    ).rejects.toBeInstanceOf(AppException);
    expect(client.validateCredentials).not.toHaveBeenCalled();
    expect(client.addToWeek).not.toHaveBeenCalled();
    expect(prisma.cookidooIntegration.upsert).not.toHaveBeenCalled();
  });

  it('wyłączona: disconnect nadal kasuje poświadczenia — to prawo użytkownika', async () => {
    process.env.COOKIDOO_INTEGRATION_ENABLED = 'false';
    await expect(service.disconnect(USER)).resolves.toEqual({
      connected: false,
      enabled: false,
    });
    expect(prisma.cookidooIntegration.deleteMany).toHaveBeenCalledWith({
      where: { householdId: HOUSEHOLD },
    });
  });

  it('tylko literalne false wyłącza', async () => {
    process.env.COOKIDOO_INTEGRATION_ENABLED = 'no';
    await expect(service.status(USER)).resolves.toMatchObject({
      enabled: true,
    });
  });
});

describe('CookidooIntegrationService — kto zarządza połączeniem domu (audyt 2.2.4)', () => {
  const originalKey = process.env.COOKIDOO_ENCRYPTION_KEY;
  const originalFlag = process.env.COOKIDOO_INTEGRATION_ENABLED;
  let prisma: {
    membership: { findFirst: jest.Mock };
    $transaction: jest.Mock;
    $queryRaw: jest.Mock;
    cookidooIntegration: {
      findUnique: jest.Mock;
      upsert: jest.Mock;
      updateMany: jest.Mock;
      create: jest.Mock;
      deleteMany: jest.Mock;
      count: jest.Mock;
    };
  };
  let client: { validateCredentials: jest.Mock; addToWeek: jest.Mock };
  let service: CookidooIntegrationService;

  const asRole = (role: 'OWNER' | 'MEMBER') => {
    prisma.membership.findFirst.mockResolvedValue({
      householdId: HOUSEHOLD,
      role,
    });
    // Ta sama rola przy ponownym odczycie W transakcji zapisu.
    prisma.$queryRaw.mockResolvedValue([{ role }]);
  };
  const storedBy = (connectedById: string | null) => ({
    householdId: HOUSEHOLD,
    emailEncrypted: encryptSecret('rafal@example.com', parseEncryptionKey(KEY)),
    passwordEncrypted: 'nieistotne',
    status: 'CONNECTED',
    connectedById,
    lastVerifiedAt: null,
  });

  beforeEach(() => {
    process.env.COOKIDOO_ENCRYPTION_KEY = KEY;
    delete process.env.COOKIDOO_INTEGRATION_ENABLED;
    prisma = {
      membership: { findFirst: jest.fn() },
      $transaction: jest.fn(),
      $queryRaw: jest.fn(),
      cookidooIntegration: {
        findUnique: jest.fn().mockResolvedValue(null),
        upsert: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        create: jest.fn().mockResolvedValue({}),
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
        count: jest.fn().mockResolvedValue(0),
      },
    };
    prisma.$transaction.mockImplementation((run: (tx: unknown) => unknown) =>
      run(prisma),
    );
    client = {
      validateCredentials: jest.fn().mockResolvedValue({ subscription: null }),
      addToWeek: jest.fn().mockResolvedValue({}),
    };
    service = new CookidooIntegrationService(
      prisma as unknown as PrismaService,
      client as unknown as CookidooServiceClient,
    );
    asRole('MEMBER');
  });

  afterEach(() => {
    if (originalKey === undefined) delete process.env.COOKIDOO_ENCRYPTION_KEY;
    else process.env.COOKIDOO_ENCRYPTION_KEY = originalKey;
    if (originalFlag === undefined)
      delete process.env.COOKIDOO_INTEGRATION_ENABLED;
    else process.env.COOKIDOO_INTEGRATION_ENABLED = originalFlag;
  });

  it('maska e-maila: pierwszy znak, kropki, końcówka domeny', () => {
    expect(maskCookidooLogin('rafal@example.com')).toBe('r•••@e•••.com');
    expect(maskCookidooLogin('a@b')).toBe('a•••@b•••');
    expect(maskCookidooLogin('bez-malpy')).toBe('•••');
    expect(maskCookidooLogin('@x.pl')).toBe('•••');
  });

  it('pierwsze podłączenie domu: każdy domownik, jak dotąd (create)', async () => {
    await expect(
      service.connect(USER, 'a@b.pl', 'tajne'),
    ).resolves.toMatchObject({ connected: true, canManage: true });
    expect(prisma.cookidooIntegration.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        householdId: HOUSEHOLD,
        connectedById: USER,
      }),
    });
    expect(prisma.cookidooIntegration.upsert).not.toHaveBeenCalled();
  });

  it('domownik NIE nadpisuje cudzego połączenia — odmowa przed wysłaniem hasła do Vorwerka', async () => {
    prisma.cookidooIntegration.findUnique.mockResolvedValue({
      connectedById: OTHER,
    });
    await expect(
      service.connect(USER, 'a@b.pl', 'tajne'),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(client.validateCredentials).not.toHaveBeenCalled();
    expect(prisma.cookidooIntegration.updateMany).not.toHaveBeenCalled();
    expect(prisma.cookidooIntegration.create).not.toHaveBeenCalled();
  });

  it('połączenie bez autora (konto usunięte) nadpisuje tylko właściciel', async () => {
    prisma.cookidooIntegration.findUnique.mockResolvedValue({
      connectedById: null,
    });
    await expect(
      service.connect(USER, 'a@b.pl', 'tajne'),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('autor nadpisuje WŁASNE połączenie warunkowym zapisem', async () => {
    prisma.cookidooIntegration.findUnique.mockResolvedValue({
      connectedById: USER,
    });
    prisma.cookidooIntegration.updateMany.mockResolvedValue({ count: 1 });
    await service.connect(USER, 'a@b.pl', 'tajne');
    expect(prisma.cookidooIntegration.updateMany).toHaveBeenCalledWith({
      where: { householdId: HOUSEHOLD, connectedById: USER },
      data: expect.objectContaining({ connectedById: USER }),
    });
    expect(prisma.cookidooIntegration.create).not.toHaveBeenCalled();
  });

  it('wyścig: ktoś podłączył dom między odczytem a zapisem → P2002 = ta sama odmowa', async () => {
    prisma.cookidooIntegration.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('unique', {
        code: 'P2002',
        clientVersion: 'test',
      }),
    );
    await expect(
      service.connect(USER, 'a@b.pl', 'tajne'),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('właściciel nadpisuje cudze połączenie (upsert)', async () => {
    asRole('OWNER');
    prisma.cookidooIntegration.findUnique.mockResolvedValue({
      connectedById: OTHER,
    });
    await service.connect(USER, 'a@b.pl', 'tajne');
    expect(prisma.cookidooIntegration.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { householdId: HOUSEHOLD } }),
    );
  });

  it('domownik NIE rozłącza cudzego połączenia; nic nie znika', async () => {
    prisma.cookidooIntegration.count.mockResolvedValue(1);
    await expect(service.disconnect(USER)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(prisma.cookidooIntegration.deleteMany).toHaveBeenCalledWith({
      where: { householdId: HOUSEHOLD, connectedById: USER },
    });
  });

  it('autor rozłącza własne połączenie', async () => {
    prisma.cookidooIntegration.deleteMany.mockResolvedValue({ count: 1 });
    await expect(service.disconnect(USER)).resolves.toEqual({
      connected: false,
      enabled: true,
    });
    expect(prisma.cookidooIntegration.count).not.toHaveBeenCalled();
  });

  it('brak połączenia: rozłączenie idempotentne, bez odmowy', async () => {
    await expect(service.disconnect(USER)).resolves.toEqual({
      connected: false,
      enabled: true,
    });
  });

  it('właściciel rozłącza każde połączenie domu', async () => {
    asRole('OWNER');
    prisma.cookidooIntegration.deleteMany.mockResolvedValue({ count: 1 });
    await service.disconnect(USER);
    expect(prisma.cookidooIntegration.deleteMany).toHaveBeenCalledWith({
      where: { householdId: HOUSEHOLD },
    });
  });

  it('status: domownik widzi maskę e-maila i canManage=false', async () => {
    prisma.cookidooIntegration.findUnique.mockResolvedValue(storedBy(OTHER));
    await expect(service.status(USER)).resolves.toMatchObject({
      connected: true,
      login: 'r•••@e•••.com',
      connectedById: OTHER,
      canManage: false,
    });
  });

  // ─── review 7.10.2026: rola zmienia się w trakcie walidacji u Vorwerka ───

  it('właściciel zdegradowany W TRAKCIE walidacji nie nadpisuje cudzego połączenia', async () => {
    asRole('OWNER');
    prisma.cookidooIntegration.findUnique.mockResolvedValue({
      connectedById: OTHER,
    });
    client.validateCredentials.mockImplementation(() => {
      // Inny właściciel degraduje pytającego, zanim Vorwerk odpowie.
      prisma.$queryRaw.mockResolvedValue([{ role: 'MEMBER' }]);
      prisma.cookidooIntegration.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('unique', {
          code: 'P2002',
          clientVersion: 'test',
        }),
      );
      return Promise.resolve({ subscription: null });
    });

    await expect(
      service.connect(USER, 'a@b.pl', 'tajne'),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(prisma.cookidooIntegration.upsert).not.toHaveBeenCalled();
    expect(prisma.cookidooIntegration.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { householdId: HOUSEHOLD, connectedById: USER },
      }),
    );
  });

  it('usunięty z domu W TRAKCIE walidacji niczego nie zapisuje', async () => {
    client.validateCredentials.mockImplementation(() => {
      prisma.$queryRaw.mockResolvedValue([]);
      return Promise.resolve({ subscription: null });
    });

    await expect(
      service.connect(USER, 'a@b.pl', 'tajne'),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(prisma.cookidooIntegration.upsert).not.toHaveBeenCalled();
    expect(prisma.cookidooIntegration.updateMany).not.toHaveBeenCalled();
    expect(prisma.cookidooIntegration.create).not.toHaveBeenCalled();
  });

  it('rozłączenie liczy rolę pod blokadą: zdegradowany właściciel kasuje tylko własne', async () => {
    prisma.membership.findFirst.mockResolvedValue({
      householdId: HOUSEHOLD,
      role: 'OWNER',
    });
    prisma.$queryRaw.mockResolvedValue([{ role: 'MEMBER' }]);
    prisma.cookidooIntegration.count.mockResolvedValue(1);

    await expect(service.disconnect(USER)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(prisma.cookidooIntegration.deleteMany).toHaveBeenCalledWith({
      where: { householdId: HOUSEHOLD, connectedById: USER },
    });
  });

  it('rola czytana W transakcji zapytaniem z blokadą FOR SHARE na Membership', async () => {
    await service.connect(USER, 'a@b.pl', 'tajne');
    await service.disconnect(USER);
    const sqls = prisma.$queryRaw.mock.calls.map(([strings]: unknown[]) =>
      (strings as TemplateStringsArray).join('?'),
    );
    expect(sqls).toHaveLength(2);
    for (const sql of sqls) {
      expect(sql).toMatch(/FROM "Membership"/);
      expect(sql).toMatch(/FOR SHARE\s*$/);
    }
    // Zapytanie biegnie W transakcji zapisu, nie przed nią.
    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
  });

  it('rozłączenie po usunięciu z domu: odmowa bez kasowania', async () => {
    prisma.$queryRaw.mockResolvedValue([]);
    await expect(service.disconnect(USER)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(prisma.cookidooIntegration.deleteMany).not.toHaveBeenCalled();
  });

  it('status: autor i właściciel widzą pełny e-mail', async () => {
    prisma.cookidooIntegration.findUnique.mockResolvedValue(storedBy(USER));
    await expect(service.status(USER)).resolves.toMatchObject({
      login: 'rafal@example.com',
      canManage: true,
    });
    asRole('OWNER');
    prisma.cookidooIntegration.findUnique.mockResolvedValue(storedBy(OTHER));
    await expect(service.status(USER)).resolves.toMatchObject({
      login: 'rafal@example.com',
      canManage: true,
    });
  });
});
