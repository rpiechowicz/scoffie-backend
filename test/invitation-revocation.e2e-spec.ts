import { Test, TestingModule } from '@nestjs/testing';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { HouseholdsService } from '../src/households/households.service';
import { UsersService } from '../src/users/users.service';
import { AppException } from '../src/common/app-exception';

/**
 * Zaproszenie musi umrzeć razem z członkostwem wystawcy — na żywej bazie.
 *
 * AUDYT 12.09.2026 (P1.10). Link zapraszający tworzy WYŁĄCZNIE właściciel,
 * jest anonimowy i ważny do 30 dni. Nic nie wiązało jego życia z życiem
 * członkostwa: ani wyrzucenie wystawcy, ani jego wyjście z domu, ani
 * degradacja OWNER → MEMBER, ani skasowanie konta nie tykały tabeli
 * `Invitation`. `acceptInvitation` sprawdzał cztery rzeczy — istnieje, nie
 * wykorzystane, nie wygasłe, nie odrzucone — i nigdy nie pytał, czy wystawca
 * ma jeszcze cokolwiek wspólnego z tym domem.
 *
 * Wyrzucony właściciel wracał WŁASNYM linkiem jako MEMBER: plan, lista
 * zakupów, prywatne przepisy, pamięć asystenta. To samo mógł zrobić każdy,
 * komu link przekazał.
 *
 * Testy jednostkowe pokrywają obie bramki osobno. Ta suita sprawdza je razem,
 * na prawdziwych kluczach obcych i prawdziwych transakcjach — bo to tam
 * mieszka pytanie, czy wygaszenie NAPRAWDĘ zapisuje się w tej samej
 * transakcji co usunięcie członkostwa.
 */
describe('Unieważnianie zaproszeń E2E', () => {
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let households: HouseholdsService;
  let users: UsersService;

  const createdUserIds: string[] = [];
  const createdHouseholdIds: string[] = [];

  const createUser = async (label: string) => {
    const stamp = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    const user = await prisma.user.create({
      data: {
        displayName: `${label} ${stamp}`,
        email: `${label.toLowerCase()}-${stamp}@zaproszenia.local`,
        authProvider: 'DEV',
      },
      select: { id: true },
    });
    createdUserIds.push(user.id);
    return user.id;
  };

  /** Dom z właścicielem i jednym domownikiem. */
  const createHousehold = async (ownerId: string, memberId: string) => {
    const household = await prisma.household.create({
      data: { name: `Dom zaproszeń ${Date.now()}`, createdById: ownerId },
      select: { id: true },
    });
    createdHouseholdIds.push(household.id);
    await prisma.membership.createMany({
      data: [
        { userId: ownerId, householdId: household.id, role: 'OWNER' },
        { userId: memberId, householdId: household.id, role: 'OWNER' },
      ],
    });
    return household.id;
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
    users = moduleRef.get(UsersService);
  });

  afterAll(async () => {
    await prisma.invitation.deleteMany({
      where: { householdId: { in: createdHouseholdIds } },
    });
    await prisma.recipe.deleteMany({
      where: { householdId: { in: createdHouseholdIds } },
    });
    await prisma.household.deleteMany({
      where: { id: { in: createdHouseholdIds } },
    });
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    await moduleRef.close();
  });

  it('wyrzucony właściciel nie wraca własnym linkiem', async () => {
    const wyrzucany = await createUser('Wyrzucany');
    const zostajacy = await createUser('Zostajacy');
    const obcy = await createUser('Obcy');
    const householdId = await createHousehold(zostajacy, wyrzucany);

    const invitation = await households.createInvitation(
      wyrzucany,
      householdId,
      {},
    );

    await households.removeMember(zostajacy, householdId, wyrzucany);

    // Sam wiersz ma już termin w przeszłości — wygaszenie poszło w tej samej
    // transakcji co usunięcie członkostwa.
    const po = await prisma.invitation.findUnique({
      where: { id: invitation.id },
      select: { expiresAt: true, redeemedAt: true },
    });
    expect(po?.expiresAt.getTime()).toBeLessThan(Date.now());
    expect(po?.redeemedAt).toBeNull();

    // I nikt tym linkiem nie wejdzie — ani obcy, ani sam wyrzucony.
    expect(
      await kod(households.acceptInvitation(obcy, { token: invitation.token })),
    ).toBe('INVITATION_EXPIRED');
    expect(
      await kod(
        households.acceptInvitation(wyrzucany, { token: invitation.token }),
      ),
    ).toBe('INVITATION_EXPIRED');

    // Skład domu się nie zmienił.
    const skład = await prisma.membership.count({ where: { householdId } });
    expect(skład).toBe(1);
  });

  it('właściciel, który wyszedł sam, też zabiera swoje linki', async () => {
    const wychodzacy = await createUser('Wychodzacy');
    const zostajacy = await createUser('ZostajacyB');
    const obcy = await createUser('ObcyB');
    const householdId = await createHousehold(zostajacy, wychodzacy);

    const invitation = await households.createInvitation(
      wychodzacy,
      householdId,
      {},
    );
    await households.leave(wychodzacy, householdId);

    expect(
      await kod(households.acceptInvitation(obcy, { token: invitation.token })),
    ).toBe('INVITATION_EXPIRED');
  });

  it('skasowanie konta wystawcy zamyka link nawet bez wygaszenia wiersza', async () => {
    const kasujacy = await createUser('Kasujacy');
    const zostajacy = await createUser('ZostajacyC');
    const obcy = await createUser('ObcyC');
    const householdId = await createHousehold(zostajacy, kasujacy);

    const invitation = await households.createInvitation(
      kasujacy,
      householdId,
      {},
    );

    // Cofamy wygaszenie zaraz po skasowaniu konta, żeby sprawdzić DRUGĄ
    // bramkę osobno: `createdById` idzie wtedy na `null` (SetNull), a to ma
    // wystarczyć do odmowy. Ten sam stan mają linki wystawione PRZED tą
    // poprawką, których w bazie nikt nie ruszy.
    await users.deleteAccount(kasujacy);
    await prisma.invitation.update({
      where: { id: invitation.id },
      data: { expiresAt: new Date(Date.now() + 86_400_000) },
    });

    const wiersz = await prisma.invitation.findUnique({
      where: { id: invitation.id },
      select: { createdById: true },
    });
    expect(wiersz?.createdById).toBeNull();

    expect(
      await kod(households.acceptInvitation(obcy, { token: invitation.token })),
    ).toBe('INVITATION_EXPIRED');
  });

  it('degradacja OWNER → MEMBER odbiera moc wystawionym linkom', async () => {
    const degradowany = await createUser('Degradowany');
    const zostajacy = await createUser('ZostajacyD');
    const obcy = await createUser('ObcyD');
    const householdId = await createHousehold(zostajacy, degradowany);

    const invitation = await households.createInvitation(
      degradowany,
      householdId,
      {},
    );
    await households.updateMemberRole(zostajacy, householdId, degradowany, {
      role: 'MEMBER',
    });

    expect(
      await kod(households.acceptInvitation(obcy, { token: invitation.token })),
    ).toBe('INVITATION_EXPIRED');
  });

  it('link żywego właściciela nadal działa — bramka nie jest za szeroka', async () => {
    const wlasciciel = await createUser('Wlasciciel');
    const drugi = await createUser('Drugi');
    const dolaczajacy = await createUser('Dolaczajacy');
    const householdId = await createHousehold(wlasciciel, drugi);

    const invitation = await households.createInvitation(
      wlasciciel,
      householdId,
      {},
    );

    await expect(
      households.acceptInvitation(dolaczajacy, { token: invitation.token }),
    ).resolves.toBeDefined();

    const membership = await prisma.membership.findUnique({
      where: {
        userId_householdId: { userId: dolaczajacy, householdId },
      },
      select: { role: true },
    });
    expect(membership?.role).toBe('MEMBER');
  });
});
