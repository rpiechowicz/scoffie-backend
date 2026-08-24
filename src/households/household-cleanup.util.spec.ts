import {
  PrismaLike,
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
  ) => {
    const deletedHouseholds: string[] = [];
    const promoted: { id: string; role: string }[] = [];

    const tx = {
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
