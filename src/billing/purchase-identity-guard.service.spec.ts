import { PrismaService } from '../prisma/prisma.service';
import { PurchaseIdentityGuardService } from './purchase-identity-guard.service';
import { purchaseIdentityHash } from '../config/purchase-identity';

/**
 * Zmiana `PURCHASE_IDENTITY_PEPPER` jest jedyną nieodwracalną i całkowicie
 * cichą pomyłką w tej aplikacji: wszyscy dostają świeżą darmową próbę, a każda
 * opłacona subskrypcja przestaje pasować do właściciela. Aplikacja wstaje
 * normalnie, endpointy odpowiadają 200, a objawem jest fala reklamacji.
 */
describe('PurchaseIdentityGuardService', () => {
  const originals = { ...process.env };
  let prisma: {
    user: { findMany: jest.Mock };
    subscription: { count: jest.Mock };
  };
  let guard: PurchaseIdentityGuardService;

  beforeEach(() => {
    process.env.PURCHASE_IDENTITY_PEPPER = 'pieprz-pierwotny';
    prisma = {
      user: { findMany: jest.fn().mockResolvedValue([]) },
      subscription: { count: jest.fn().mockResolvedValue(3) },
    };
    guard = new PurchaseIdentityGuardService(
      prisma as unknown as PrismaService,
    );
  });

  afterEach(() => {
    process.env = { ...originals };
  });

  const userWith = (pepper: string) => {
    const before = process.env.PURCHASE_IDENTITY_PEPPER;
    process.env.PURCHASE_IDENTITY_PEPPER = pepper;
    const hash = purchaseIdentityHash('APPLE', 'apple-sub-1');
    process.env.PURCHASE_IDENTITY_PEPPER = before;
    return {
      id: 'user-1',
      identityHash: hash,
      appleSub: 'apple-sub-1',
      googleId: null,
      authProvider: 'APPLE',
    };
  };

  it('pieprz zgodny z bazą przechodzi bez hałasu', async () => {
    prisma.user.findMany.mockResolvedValue([userWith('pieprz-pierwotny')]);
    expect(await guard.check()).toBe(true);
  });

  it('PODMIENIONY pieprz jest wykryty — to jest cały sens tego pliku', async () => {
    prisma.user.findMany.mockResolvedValue([userWith('pieprz-inny')]);
    expect(await guard.check()).toBe(false);
    // Komunikat musi mówić, ILE subskrypcji właśnie przestało pasować.
    expect(prisma.subscription.count).toHaveBeenCalled();
  });

  it('pusta baza to nie awaria — pierwszy hasz dopiero powstanie', async () => {
    prisma.user.findMany.mockResolvedValue([]);
    expect(await guard.check()).toBe(true);
  });

  it('wystarczy JEDEN pasujący hasz — konta bez appleSub nie liczą się jako dowód', async () => {
    prisma.user.findMany.mockResolvedValue([
      userWith('pieprz-inny'),
      userWith('pieprz-pierwotny'),
    ]);
    expect(await guard.check()).toBe(true);
  });

  it('start nie wywraca się, gdy baza jeszcze nie odpowiada', async () => {
    prisma.user.findMany.mockRejectedValue(new Error('baza wstaje'));
    await expect(guard.onApplicationBootstrap()).resolves.toBeUndefined();
  });
});
