import { createHash } from 'crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { HouseholdsService } from '../src/households/households.service';
import { AppException } from '../src/common/app-exception';

/**
 * Surowy token zaproszenia nie ma prawa leżeć w bazie — na żywej bazie.
 *
 * Link zapraszający jest anonimowy i ważny do 30 dni. Dopóki `Invitation`
 * trzymało token jawnym tekstem, zrzut tabeli (backup, replika, podgląd
 * w panelu) był kompletem działających wejść do każdego domu z otwartym
 * zaproszeniem. `RefreshToken` od początku trzyma wyłącznie hasz — tu ma być
 * tak samo.
 *
 * Suita pyta bazę SUROWYM SQL-em o cały wiersz (`row_to_json`), a nie przez
 * model Prismy: sprawdzamy to, co zobaczy ktoś ze zrzutem, a nie to, co
 * akurat wybiera `select`.
 */
describe('Hasz tokenu zaproszenia E2E', () => {
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let households: HouseholdsService;

  const createdUserIds: string[] = [];
  const createdHouseholdIds: string[] = [];

  const createUser = async (label: string) => {
    const stamp = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    const user = await prisma.user.create({
      data: {
        displayName: `${label} ${stamp}`,
        email: `${label.toLowerCase()}-${stamp}@hasz-zaproszen.local`,
        authProvider: 'DEV',
      },
      select: { id: true },
    });
    createdUserIds.push(user.id);
    return user.id;
  };

  const createHousehold = async (ownerId: string) => {
    const household = await prisma.household.create({
      data: { name: `Dom haszy ${Date.now()}`, createdById: ownerId },
      select: { id: true },
    });
    createdHouseholdIds.push(household.id);
    await prisma.membership.create({
      data: { userId: ownerId, householdId: household.id, role: 'OWNER' },
    });
    return household.id;
  };

  /** Dom z właścicielem i świeżym zaproszeniem. */
  const invite = async () => {
    const ownerId = await createUser('Wystawca');
    const householdId = await createHousehold(ownerId);
    const invitation = await households.createInvitation(ownerId, householdId);
    return { ownerId, householdId, invitation };
  };

  /** Cały wiersz tak, jak widzi go zrzut bazy. */
  const rawRow = async (id: string): Promise<Record<string, unknown>> => {
    const rows = await prisma.$queryRaw<Array<{ row: string }>>`
      SELECT row_to_json(i)::text AS "row"
      FROM "Invitation" i
      WHERE i.id = ${id}::uuid
    `;
    return JSON.parse(rows[0].row) as Record<string, unknown>;
  };

  const kod = async (attempt: Promise<unknown>): Promise<string> => {
    try {
      await attempt;
      return 'BRAK_ODMOWY';
    } catch (error) {
      if (error instanceof AppException) {
        return (error.getResponse() as { code: string }).code;
      }
      throw error;
    }
  };

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    await moduleRef.init();
    prisma = moduleRef.get(PrismaService);
    households = moduleRef.get(HouseholdsService);
  });

  afterAll(async () => {
    await prisma.invitation.deleteMany({
      where: { householdId: { in: createdHouseholdIds } },
    });
    await prisma.household.deleteMany({
      where: { id: { in: createdHouseholdIds } },
    });
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    await moduleRef.close();
  });

  it('w bazie leży hasz, a nie token z odpowiedzi', async () => {
    const { invitation } = await invite();

    // Ta sama entropia co dotąd: 16 losowych bajtów jako 32 znaki hex.
    expect(invitation.token).toMatch(/^[0-9a-f]{32}$/);

    const row = await rawRow(invitation.id);
    expect(JSON.stringify(row)).not.toContain(invitation.token);
    expect(row.tokenHash).toBe(
      createHash('sha256').update(invitation.token).digest('hex'),
    );
    // Odpowiedź tworzenia niesie token, ale nie hasz — hasz nie jest
    // klientowi do niczego potrzebny.
    expect(invitation).not.toHaveProperty('tokenHash');
  });

  it('podgląd i przyjęcie działają z tokenem z odpowiedzi', async () => {
    const { householdId, invitation } = await invite();
    const gosc = await createUser('Gosc');

    const preview = await households.previewInvitation(gosc, {
      token: invitation.token,
    });
    expect(preview.status).toBe('PENDING');
    expect(preview.household?.id).toBe(householdId);

    const membership = await households.acceptInvitation(gosc, {
      token: invitation.token,
    });
    expect(membership.householdId).toBe(householdId);
  });

  it('zły token nie działa', async () => {
    await invite();
    const gosc = await createUser('Zgadujacy');
    const zly = 'f'.repeat(32);

    expect(
      (await households.previewInvitation(gosc, { token: zly })).status,
    ).toBe('NOT_FOUND');
    expect(await kod(households.acceptInvitation(gosc, { token: zly }))).toBe(
      'INVITATION_NOT_FOUND',
    );
    expect(await kod(households.declineInvitation(gosc, { token: zly }))).toBe(
      'INVITATION_NOT_FOUND',
    );
  });

  it('wyciek wiersza z bazy nie daje działającego linku', async () => {
    const { invitation } = await invite();
    const zlodziej = await createUser('Zlodziej');

    // Każda wartość napisowa z wiersza — hasz, id, cokolwiek — podana jako
    // token. Plus uchwyt skrzynki złożony z wykradzionego id.
    const row = await rawRow(invitation.id);
    const candidates = [
      ...Object.values(row).filter(
        (value): value is string =>
          typeof value === 'string' && value.length >= 8,
      ),
      `inv_${invitation.id}`,
    ];
    expect(candidates.length).toBeGreaterThan(2);

    for (const candidate of candidates) {
      expect(
        (await households.previewInvitation(zlodziej, { token: candidate }))
          .status,
      ).toBe('NOT_FOUND');
      expect(
        await kod(households.acceptInvitation(zlodziej, { token: candidate })),
      ).toBe('INVITATION_NOT_FOUND');
    }

    // Podglądy z wykradzionymi wartościami nie odłożyły zaproszenia do
    // skrzynki złodzieja — inaczej uchwyt zacząłby dla niego działać.
    expect((await rawRow(invitation.id)).invitedUserId).toBeNull();
  });

  it('token wygasły i token odwołany nie działają', async () => {
    const wygasle = await invite();
    const gosc = await createUser('Spozniony');
    await prisma.invitation.update({
      where: { id: wygasle.invitation.id },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });
    expect(
      (
        await households.previewInvitation(gosc, {
          token: wygasle.invitation.token,
        })
      ).status,
    ).toBe('EXPIRED');
    expect(
      await kod(
        households.acceptInvitation(gosc, { token: wygasle.invitation.token }),
      ),
    ).toBe('INVITATION_EXPIRED');

    // Odwołanie = wystawca przestaje być właścicielem (degradacja gasi jego
    // linki w tej samej transakcji). Potrzebny drugi właściciel, inaczej
    // degradacja ostatniego jest zabroniona.
    const odwolane = await invite();
    const drugi = await createUser('Drugi');
    await prisma.membership.create({
      data: {
        userId: drugi,
        householdId: odwolane.householdId,
        role: 'OWNER',
      },
    });
    await households.updateMemberRole(
      drugi,
      odwolane.householdId,
      odwolane.ownerId,
      { role: 'MEMBER' },
    );
    expect(
      await kod(
        households.acceptInvitation(gosc, { token: odwolane.invitation.token }),
      ),
    ).toBe('INVITATION_EXPIRED');
  });

  it('wystawca bez uprawnień = odmowa, nawet gdy wiersz wygląda na żywy', async () => {
    const { ownerId, householdId, invitation } = await invite();
    const gosc = await createUser('Pozny');
    // Degradacja z pominięciem serwisu: wiersz zaproszenia zostaje nietknięty
    // (niewygasły), więc odmówić musi bramka w chwili użycia.
    await prisma.membership.update({
      where: { userId_householdId: { userId: ownerId, householdId } },
      data: { role: 'MEMBER' },
    });

    expect(
      await kod(households.acceptInvitation(gosc, { token: invitation.token })),
    ).toBe('INVITATION_EXPIRED');
  });

  it('token po użyciu nie działa ponownie', async () => {
    const { invitation } = await invite();
    const pierwszy = await createUser('Pierwszy');
    const drugi = await createUser('Drugi');

    await households.acceptInvitation(pierwszy, { token: invitation.token });
    expect(
      await kod(
        households.acceptInvitation(drugi, { token: invitation.token }),
      ),
    ).toBe('INVITATION_ALREADY_REDEEMED');
  });

  it('równoległe przyjęcie wpuszcza dokładnie jedną osobę', async () => {
    const { householdId, invitation } = await invite();
    const ids = await Promise.all(
      ['A', 'B', 'C', 'D'].map((label) => createUser(`Rownolegly${label}`)),
    );

    const results = await Promise.allSettled(
      ids.map((id) =>
        households.acceptInvitation(id, { token: invitation.token }),
      ),
    );

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(
      await prisma.membership.count({
        where: { householdId, userId: { in: ids } },
      }),
    ).toBe(1);
  });

  it('skrzynka nie ujawnia tokenu i pracuje na id zaproszenia', async () => {
    const { householdId, invitation } = await invite();
    const adresat = await createUser('Adresat');
    const obcy = await createUser('Obcy');

    await households.previewInvitation(adresat, { token: invitation.token });
    const inbox = await households.listPendingInvitations(adresat);

    expect(inbox).toHaveLength(1);
    expect(JSON.stringify(inbox)).not.toContain(invitation.token);
    expect(inbox[0].id).toBe(invitation.id);
    // Pole `token` zostaje w kontrakcie (wydane buildy iOS dekodują je jako
    // wymagane), ale niesie uchwyt skrzynki, nie token z linku.
    expect(inbox[0].token).toBe(`inv_${invitation.id}`);

    // Uchwyt działa WYŁĄCZNIE dla adresata.
    expect(
      await kod(households.acceptInvitation(obcy, { token: inbox[0].token })),
    ).toBe('INVITATION_NOT_FOUND');
    expect(
      await kod(households.declineInvitation(obcy, { token: inbox[0].token })),
    ).toBe('INVITATION_NOT_FOUND');

    const preview = await households.previewInvitation(adresat, {
      token: inbox[0].token,
    });
    expect(preview.status).toBe('PENDING');
    const membership = await households.acceptInvitation(adresat, {
      token: inbox[0].token,
    });
    expect(membership.householdId).toBe(householdId);
  });

  it('odmowa ze skrzynki działa po uchwycie', async () => {
    const { invitation } = await invite();
    const adresat = await createUser('Odmawiajacy');

    await households.previewInvitation(adresat, { token: invitation.token });
    const [pending] = await households.listPendingInvitations(adresat);
    await households.declineInvitation(adresat, { token: pending.token });

    expect(await households.listPendingInvitations(adresat)).toHaveLength(0);
    expect(
      await kod(
        households.acceptInvitation(adresat, { token: invitation.token }),
      ),
    ).toBe('INVITATION_DECLINED');
  });
});
