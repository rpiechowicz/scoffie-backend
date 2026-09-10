import { Test, TestingModule } from '@nestjs/testing';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { UsersService } from '../src/users/users.service';

/**
 * Poczta na ŻYWEJ bazie — to, czego mocki nie pokażą: klucze obce i kaskady.
 *
 * Najważniejszy dowód: pożegnanie kolejkuje się WEWNĄTRZ transakcji, która
 * kasuje konto, a mimo to przeżywa tę transakcję. `MailMessage.userId` jest
 * `SetNull`, nie kaskadą — gdyby ktoś to kiedyś zmienił, wiersz zniknąłby
 * razem z użytkownikiem i nikt by się nie dowiedział, bo w testach
 * jednostkowych kaskady nie ma.
 */
describe('Poczta E2E', () => {
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let users: UsersService;

  const createdUserIds: string[] = [];
  const dedupeKeys: string[] = [];
  const suppressed: string[] = [];
  const poprzednieEnv = { ...process.env };

  const createUser = async (label: string) => {
    const stamp = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    const email = `${label}-${stamp}@mail.local`;
    const user = await prisma.user.create({
      data: {
        displayName: `${label} ${stamp}`,
        email,
        authProvider: 'DEV',
      },
      select: { id: true, email: true },
    });
    createdUserIds.push(user.id);
    dedupeKeys.push(`deleted:${user.id}`, `welcome:${user.id}`);
    return user;
  };

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    await moduleRef.init();
    prisma = moduleRef.get(PrismaService);
    users = moduleRef.get(UsersService);
  });

  beforeEach(() => {
    // Zmienne czyta się per wywołanie, więc test może je przestawiać.
    process.env.MAIL_ENABLED = 'true';
    process.env.MAIL_TRANSPORT = 'stub';
  });

  afterAll(async () => {
    await prisma.mailMessage.deleteMany({
      where: { dedupeKey: { in: dedupeKeys } },
    });
    await prisma.mailSuppression.deleteMany({
      where: { email: { in: suppressed } },
    });
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    process.env = { ...poprzednieEnv };
    await moduleRef.close();
  });

  it('pożegnanie przeżywa transakcję, która kasuje konto', async () => {
    const user = await createUser('zegnaj');

    await users.deleteAccount(user.id);

    const wiersz = await prisma.mailMessage.findUnique({
      where: { dedupeKey: `deleted:${user.id}` },
    });

    expect(wiersz).not.toBeNull();
    expect(wiersz?.template).toBe('ACCOUNT_DELETED');
    // Adres jest SKOPIOWANY do wiersza — konta już nie ma, więc nie było
    // z czego go odczytać w chwili wysyłki.
    expect(wiersz?.to).toBe(user.email);
    // Kaskada nie zabrała wiersza, tylko odpięła konto.
    expect(wiersz?.userId).toBeNull();
    expect(wiersz?.status).toBe('QUEUED');

    const payload = wiersz?.payload as Record<string, unknown>;
    expect(payload.email).toBe(user.email);
    // Konto bez domowników: gospodarstwo poszło razem z nim.
    expect(payload.householdRemains).toBe(false);
    expect(payload.hasLiveSubscription).toBe(false);

    // I najważniejsze: konta naprawdę nie ma.
    const konto = await prisma.user.findUnique({ where: { id: user.id } });
    expect(konto).toBeNull();
  });

  it('wyłączona poczta nie zostawia po kasowaniu konta żadnego wiersza', async () => {
    process.env.MAIL_ENABLED = 'false';
    const user = await createUser('cisza');

    await users.deleteAccount(user.id);

    const wiersz = await prisma.mailMessage.findUnique({
      where: { dedupeKey: `deleted:${user.id}` },
    });
    expect(wiersz).toBeNull();
  });

  it('adres z listy wykluczeń nie trafia do kolejki', async () => {
    const user = await createUser('odbity');
    const email = (user.email ?? '').toLowerCase();
    suppressed.push(email);
    await prisma.mailSuppression.create({
      data: { email, reason: 'HARD_BOUNCE' },
    });

    await users.deleteAccount(user.id);

    const wiersz = await prisma.mailMessage.findUnique({
      where: { dedupeKey: `deleted:${user.id}` },
    });
    expect(wiersz).toBeNull();
  });

  it('powitanie po onboardingu wychodzi raz, nawet gdy telefon ponowi żądanie', async () => {
    const user = await createUser('witaj');

    await users.completeOnboarding(user.id);
    await users.completeOnboarding(user.id);

    const wiersze = await prisma.mailMessage.findMany({
      where: { dedupeKey: `welcome:${user.id}` },
    });
    expect(wiersze).toHaveLength(1);
    expect(wiersze[0].template).toBe('WELCOME');
    expect(wiersze[0].userId).toBe(user.id);
  });
});
