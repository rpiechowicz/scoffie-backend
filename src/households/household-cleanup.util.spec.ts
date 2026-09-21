import {
  PrismaLike,
  revokeInvitationsCreatedBy,
  settleHouseholdAfterMemberLeft,
} from './household-cleanup.util';

/**
 * Reguła jest krótka, ale kosztowna, gdy się pomyli w którąkolwiek stronę:
 * za ostrożna zostawia w bazie puste gospodarstwa, których nikt nigdy nie
 * odwiedzi, a za gorliwa kasuje dom razem z planami ludzi, którzy w nim
 * zostali. Dlatego obie granice są tu przybite osobno.
 */
describe('settleHouseholdAfterMemberLeft', () => {
  const HOUSEHOLD = 'household-1';

  const makeTx = (
    memberships: { id: string; userId: string; role: 'OWNER' | 'MEMBER' }[],
    catalogRecipes = 0,
  ) => {
    const deletedHouseholds: string[] = [];
    const promoted: { id: string; role: string }[] = [];

    const tx = {
      recipe: { count: jest.fn().mockResolvedValue(catalogRecipes) },
      membership: {
        findMany: jest.fn().mockResolvedValue(memberships),
        update: jest.fn().mockImplementation((args: unknown) => {
          const typed = args as {
            where: { id: string };
            data: { role: string };
          };
          promoted.push({ id: typed.where.id, role: typed.data.role });
          return Promise.resolve({});
        }),
      },
      household: {
        // Zamek składu (`lockHouseholdRoster`) — tu tylko ma się dać zawołać.
        update: jest.fn().mockResolvedValue({}),
        delete: jest.fn().mockImplementation((args: unknown) => {
          const typed = args as { where: { id: string } };
          deletedHouseholds.push(typed.where.id);
          return Promise.resolve({});
        }),
      },
    } as unknown as PrismaLike;

    return { tx, deletedHouseholds, promoted };
  };

  it('kasuje gospodarstwo, w którym nikt nie został', async () => {
    const { tx, deletedHouseholds } = makeTx([]);

    const result = await settleHouseholdAfterMemberLeft(tx, HOUSEHOLD);

    expect(result).toEqual({ outcome: 'DELETED' });
    expect(deletedHouseholds).toEqual([HOUSEHOLD]);
  });

  it('nie rusza gospodarstwa, w którym został właściciel', async () => {
    const { tx, deletedHouseholds, promoted } = makeTx([
      { id: 'm1', userId: 'u1', role: 'OWNER' },
      { id: 'm2', userId: 'u2', role: 'MEMBER' },
    ]);

    const result = await settleHouseholdAfterMemberLeft(tx, HOUSEHOLD);

    expect(result).toEqual({ outcome: 'UNCHANGED' });
    expect(deletedHouseholds).toEqual([]);
    expect(promoted).toEqual([]);
  });

  it('awansuje najstarszego stażem, gdy odszedł jedyny właściciel', async () => {
    // `findMany` w implementacji sortuje po `createdAt` rosnąco, więc pierwszy
    // element to najdłuższy staż — i to on ma przejąć dom.
    const { tx, deletedHouseholds, promoted } = makeTx([
      { id: 'm2', userId: 'u2', role: 'MEMBER' },
      { id: 'm3', userId: 'u3', role: 'MEMBER' },
    ]);

    const result = await settleHouseholdAfterMemberLeft(tx, HOUSEHOLD);

    expect(result).toEqual({ outcome: 'OWNER_PROMOTED', promotedUserId: 'u2' });
    expect(promoted).toEqual([{ id: 'm2', role: 'OWNER' }]);
    expect(deletedHouseholds).toEqual([]);
  });

  it('nie kasuje pustego gospodarstwa, które trzyma wspólny katalog', async () => {
    // Kaskada z domu zabrałaby przepisy katalogowe, a z nimi pozycje planów
    // KAŻDEGO gospodarstwa. Pusty dom katalogu zostaje — to jedyny wyjątek.
    const { tx, deletedHouseholds } = makeTx([], 97);

    const result = await settleHouseholdAfterMemberLeft(tx, HOUSEHOLD);

    expect(result).toEqual({ outcome: 'KEPT_CATALOG' });
    expect(deletedHouseholds).toEqual([]);
  });

  it('nie kasuje gospodarstwa z jedynym pozostałym domownikiem', async () => {
    // Granica, o którą najłatwiej się potknąć: „ostatni odszedł" to zero
    // członków, a nie jeden. Jedna osoba w domu to normalny stan.
    const { tx, deletedHouseholds } = makeTx([
      { id: 'm2', userId: 'u2', role: 'OWNER' },
    ]);

    await settleHouseholdAfterMemberLeft(tx, HOUSEHOLD);

    expect(deletedHouseholds).toEqual([]);
  });
});

// AUDYT 12.09.2026 (P1.10). Zaproszenie to anonimowy link ważny do 30 dni,
// wystawiany wyłącznie przez właściciela. Nic nie wiązało jego życia z życiem
// członkostwa: wyrzucony właściciel wracał WŁASNYM linkiem jako MEMBER,
// z dostępem do planu, listy zakupów, prywatnych przepisów i pamięci
// asystenta — i to samo mógł zrobić każdy, komu link przekazał.
describe('revokeInvitationsCreatedBy', () => {
  const HOUSEHOLD = 'household-1';
  const ODCHODZACY = 'u1';
  const TERAZ = new Date('2026-09-13T10:00:00.000Z');

  const makeTx = () => {
    const wywolania: unknown[] = [];
    const tx = {
      invitation: {
        updateMany: jest.fn().mockImplementation((args: unknown) => {
          wywolania.push(args);
          return Promise.resolve({ count: 2 });
        }),
      },
    } as unknown as PrismaLike;
    return { tx, wywolania };
  };

  it('wygasza tylko linki TEJ osoby, TEGO domu i jeszcze żywe', async () => {
    const { tx, wywolania } = makeTx();

    const count = await revokeInvitationsCreatedBy(
      tx,
      HOUSEHOLD,
      ODCHODZACY,
      TERAZ,
    );

    expect(count).toBe(2);
    expect(wywolania[0]).toEqual({
      where: {
        householdId: HOUSEHOLD,
        createdById: ODCHODZACY,
        // Wykorzystanego linku nie ruszamy: `redeemedAt` jest dowodem, kto
        // i kiedy wszedł, a przestawianie mu terminu zacierałoby ten ślad.
        redeemedAt: null,
        expiresAt: { gt: TERAZ },
      },
      data: { expiresAt: new Date(TERAZ.getTime() - 1_000) },
    });
  });

  it('nowy termin leży w PRZESZŁOŚCI, nie „teraz"', async () => {
    const { tx, wywolania } = makeTx();

    await revokeInvitationsCreatedBy(tx, HOUSEHOLD, ODCHODZACY, TERAZ);

    const { data } = wywolania[0] as { data: { expiresAt: Date } };
    // Porównanie w `acceptInvitation` jest ostre (`<`), a zapis i próba
    // przyjęcia mogą trafić w tę samą milisekundę. Równe „teraz" przepuściłoby
    // link, który miał właśnie umrzeć.
    expect(data.expiresAt.getTime()).toBeLessThan(TERAZ.getTime());
  });

  it('wygaszamy, a nie kasujemy — ślad po zaproszeniu zostaje', async () => {
    const { tx } = makeTx();

    await revokeInvitationsCreatedBy(tx, HOUSEHOLD, ODCHODZACY, TERAZ);

    // Odbiorca dostaje istniejący, zrozumiały `INVITATION_EXPIRED` zamiast
    // „nie znaleziono", a w bazie widać, że link kiedyś był.
    expect(
      (tx as unknown as { invitation: { deleteMany?: unknown } }).invitation
        .deleteMany,
    ).toBeUndefined();
  });
});
