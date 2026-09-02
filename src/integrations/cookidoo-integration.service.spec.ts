import { AppException } from '../common/app-exception';
import { PrismaService } from '../prisma/prisma.service';
import { CookidooIntegrationService } from './cookidoo-integration.service';
import { CookidooServiceClient } from './cookidoo-service.client';

const USER = '3fa85f64-5717-4562-b3fc-2c963f66afa6';
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
        findFirst: jest.fn().mockResolvedValue({ householdId: HOUSEHOLD }),
      },
      cookidooIntegration: {
        findUnique: jest.fn().mockResolvedValue(null),
        upsert: jest.fn().mockResolvedValue({}),
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
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

  it('wyłączona: status bez odczytu bazy, klient ma schować wiersz', async () => {
    process.env.COOKIDOO_INTEGRATION_ENABLED = 'false';
    await expect(service.status(USER)).resolves.toEqual({
      connected: false,
      enabled: false,
    });
    expect(prisma.cookidooIntegration.findUnique).not.toHaveBeenCalled();
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
