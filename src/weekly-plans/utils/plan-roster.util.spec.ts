import { PrismaLike, onMemberLeft, onRosterChanged } from './plan-roster.util';

/**
 * Hook składu gospodarstwa jest tani w kodzie i drogi w skutkach: za
 * ostrożny zostawia duchy uczestników (i `PLAN_PARTICIPANT_NOT_IN_HOUSEHOLD`
 * przy każdej edycji), za gorliwy kasuje posiłki ludziom, którzy zostali,
 * albo przepisuje historię. Dlatego test biegnie na pamięciowym sklepie
 * itemów, a nie na kształcie `where` — „ręczna wartość zostaje" ma być
 * obserwowanym zachowaniem, nie zgadywaniem, co Prisma zrobi z filtrem.
 */

const HOUSEHOLD = 'hh-1';
const LEAVER = 'user-2';
const STAYER = 'user-1';
// Czwartek. Bieżący poniedziałek = 2026-08-24.
const NOW = new Date('2026-08-27T10:00:00.000Z');
const MONDAY = new Date('2026-08-24T00:00:00.000Z');
const NEXT_WEEK = new Date('2026-08-31T00:00:00.000Z');
const LAST_WEEK = new Date('2026-08-17T00:00:00.000Z');

type StoredItem = {
  id: string;
  weekStart: Date;
  plannedServings: number;
  participants: string[];
};

const item = (
  id: string,
  weekStart: Date,
  plannedServings: number,
  participants: string[] = [],
): StoredItem => ({ id, weekStart, plannedServings, participants });

/**
 * Pamięciowy `tx`. Obsługuje dokładnie te filtry, których używa hook:
 * `weeklyPlan.weekStart.gte`, `participants.some/none`, `plannedServings`,
 * `id.in`, `userId`. Cokolwiek innego to błąd testu, nie implementacji.
 */
const makeTx = (params: { items?: StoredItem[]; memberCount?: number }) => {
  const items: StoredItem[] = (params.items ?? []).map((i) => ({
    ...i,
    participants: [...i.participants],
  }));
  const memberCount = params.memberCount ?? 1;

  const inScope = (i: StoredItem, where: any) => {
    const gte: Date | undefined = where?.weeklyPlan?.weekStart?.gte;
    return gte ? i.weekStart.getTime() >= gte.getTime() : true;
  };

  const tx = {
    weeklyPlan: {
      findMany: jest.fn().mockImplementation(({ where }: any) => {
        const gte: Date = where.weekStart.gte;
        const weeks = Array.from(
          new Set(
            items
              .filter((i) => i.weekStart.getTime() >= gte.getTime())
              .map((i) => i.weekStart.getTime()),
          ),
        ).sort();
        return Promise.resolve(weeks.map((t) => ({ weekStart: new Date(t) })));
      }),
    },
    planItem: {
      findMany: jest.fn().mockImplementation(({ where }: any) => {
        const someUser: string | undefined = where?.participants?.some?.userId;
        return Promise.resolve(
          items
            .filter((i) => inScope(i, where))
            .filter((i) =>
              someUser ? i.participants.includes(someUser) : true,
            )
            .map((i) => ({
              id: i.id,
              participants: i.participants.map((userId) => ({ userId })),
            })),
        );
      }),
      deleteMany: jest.fn().mockImplementation(({ where }: any) => {
        const ids: string[] = where.id.in;
        const before = items.length;
        for (let k = items.length - 1; k >= 0; k -= 1) {
          if (ids.includes(items[k].id)) items.splice(k, 1);
        }
        return Promise.resolve({ count: before - items.length });
      }),
      updateMany: jest.fn().mockImplementation(({ where, data }: any) => {
        let count = 0;
        for (const i of items) {
          if (!inScope(i, where)) continue;
          if (where.participants?.none && i.participants.length > 0) continue;
          if (
            where.plannedServings != null &&
            i.plannedServings !== where.plannedServings
          )
            continue;
          i.plannedServings = data.plannedServings;
          count += 1;
        }
        return Promise.resolve({ count });
      }),
    },
    planItemParticipant: {
      deleteMany: jest.fn().mockImplementation(({ where }: any) => {
        let count = 0;
        for (const i of items) {
          if (!inScope(i, where.planItem)) continue;
          const before = i.participants.length;
          i.participants = i.participants.filter((u) => u !== where.userId);
          count += before - i.participants.length;
        }
        return Promise.resolve({ count });
      }),
    },
    planItemConsumption: {
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    membership: {
      count: jest.fn().mockResolvedValue(memberCount),
    },
    shoppingList: {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
  };

  return { tx: tx as unknown as PrismaLike, mocks: tx, items };
};

const byId = (items: StoredItem[], id: string) =>
  items.find((i) => i.id === id);

describe('onMemberLeft', () => {
  it('usuwa wiersze ducha tylko w tygodniach od bieżącego poniedziałku', async () => {
    const { tx, mocks } = makeTx({
      items: [
        item('past', LAST_WEEK, 2, [STAYER, LEAVER]),
        item('now', MONDAY, 2, [STAYER, LEAVER]),
        item('next', NEXT_WEEK, 2, [STAYER, LEAVER]),
      ],
    });

    await onMemberLeft(tx, HOUSEHOLD, LEAVER, NOW);

    const scope = {
      userId: LEAVER,
      planItem: {
        weeklyPlan: { householdId: HOUSEHOLD, weekStart: { gte: MONDAY } },
      },
    };
    expect(mocks.planItemParticipant.deleteMany).toHaveBeenCalledTimes(1);
    expect(mocks.planItemParticipant.deleteMany).toHaveBeenCalledWith({
      where: scope,
    });
    expect(mocks.planItemConsumption.deleteMany).toHaveBeenCalledWith({
      where: scope,
    });
  });

  it('kasuje item, na którym odchodzący był jedynym uczestnikiem', async () => {
    const { tx, mocks, items } = makeTx({
      items: [
        item('solo', MONDAY, 1, [LEAVER]),
        item('duo', MONDAY, 2, [STAYER, LEAVER]),
      ],
    });

    const result = await onMemberLeft(tx, HOUSEHOLD, LEAVER, NOW);

    expect(mocks.planItem.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ['solo'] } },
    });
    expect(result.deletedItemIds).toEqual(['solo']);
    expect(byId(items, 'solo')).toBeUndefined();
    expect(byId(items, 'duo')).toBeDefined();
  });

  it('nie kasuje itemu współdzielonego z pozostającym domownikiem — zdejmuje tylko ducha', async () => {
    const { tx, items } = makeTx({
      items: [item('duo', MONDAY, 2, [STAYER, LEAVER])],
    });

    await onMemberLeft(tx, HOUSEHOLD, LEAVER, NOW);

    expect(byId(items, 'duo')?.participants).toEqual([STAYER]);
  });

  it('nie kasuje niczego, gdy odchodzący nie miał posiłków imiennych', async () => {
    const { tx, mocks } = makeTx({
      items: [item('shared', MONDAY, 2, [])],
    });

    const result = await onMemberLeft(tx, HOUSEHOLD, LEAVER, NOW);

    expect(mocks.planItem.deleteMany).not.toHaveBeenCalled();
    expect(result.deletedItemIds).toEqual([]);
  });

  it('nie rusza tygodni z przeszłości', async () => {
    const { tx, items } = makeTx({
      items: [
        item('past-solo', LAST_WEEK, 1, [LEAVER]),
        item('past-duo', LAST_WEEK, 2, [STAYER, LEAVER]),
        item('past-shared', LAST_WEEK, 2, []),
      ],
      memberCount: 1,
    });

    const result = await onMemberLeft(tx, HOUSEHOLD, LEAVER, NOW);

    expect(result.deletedItemIds).toEqual([]);
    expect(byId(items, 'past-solo')).toBeDefined();
    expect(byId(items, 'past-duo')?.participants).toEqual([STAYER, LEAVER]);
    expect(byId(items, 'past-shared')?.plannedServings).toBe(2);
  });

  it('przelicza Wspólne z 2 na 1 po odejściu', async () => {
    const { tx, items } = makeTx({
      items: [item('shared', MONDAY, 2, [])],
      memberCount: 1,
    });

    const result = await onMemberLeft(tx, HOUSEHOLD, LEAVER, NOW);

    expect(byId(items, 'shared')?.plannedServings).toBe(1);
    expect(result.reDerivedItemCount).toBe(1);
  });

  it('nie rusza wartości ręcznej', async () => {
    // 4 porcje w domu dwuosobowym nie wychodzą z żadnej reguły auto — to
    // świadomy wybór i ma przeżyć zmianę składu.
    const { tx, items } = makeTx({
      items: [item('auto', MONDAY, 2, []), item('manual', MONDAY, 4, [])],
      memberCount: 1,
    });

    await onMemberLeft(tx, HOUSEHOLD, LEAVER, NOW);

    expect(byId(items, 'auto')?.plannedServings).toBe(1);
    expect(byId(items, 'manual')?.plannedServings).toBe(4);
  });

  it('nie rusza porcji itemów imiennych', async () => {
    const { tx, items } = makeTx({
      items: [item('named', MONDAY, 2, [STAYER])],
      memberCount: 1,
    });

    await onMemberLeft(tx, HOUSEHOLD, LEAVER, NOW);

    expect(byId(items, 'named')?.plannedServings).toBe(2);
  });

  it('oznacza listy zakupów od bieżącego poniedziałku jako nieaktualne', async () => {
    const { tx, mocks } = makeTx({});

    await onMemberLeft(tx, HOUSEHOLD, LEAVER, NOW);

    expect(mocks.shoppingList.updateMany).toHaveBeenCalledWith({
      where: { householdId: HOUSEHOLD, weekStart: { gte: MONDAY } },
      data: { isStale: true },
    });
  });

  it('zwraca klucze dotkniętych tygodni', async () => {
    const { tx } = makeTx({
      items: [
        item('a', LAST_WEEK, 2, []),
        item('b', MONDAY, 2, []),
        item('c', NEXT_WEEK, 2, []),
      ],
    });

    const result = await onMemberLeft(tx, HOUSEHOLD, LEAVER, NOW);

    expect(result.touchedWeekStarts).toEqual(['2026-08-24', '2026-08-31']);
  });
});

describe('onRosterChanged', () => {
  it('przelicza Wspólne z 1 na 2 po dołączeniu domownika', async () => {
    const { tx, mocks, items } = makeTx({
      items: [item('shared', MONDAY, 1, [])],
    });

    const result = await onRosterChanged(tx, HOUSEHOLD, 1, 2, NOW);

    expect(byId(items, 'shared')?.plannedServings).toBe(2);
    expect(result.reDerivedItemCount).toBe(1);
    expect(result.touchedWeekStarts).toEqual(['2026-08-24']);
    expect(mocks.shoppingList.updateMany).toHaveBeenCalledTimes(1);
  });

  it('zostawia ręczne 4 porcje po dołączeniu domownika', async () => {
    const { tx, items } = makeTx({
      items: [item('manual', MONDAY, 4, [])],
    });

    await onRosterChanged(tx, HOUSEHOLD, 1, 2, NOW);

    expect(byId(items, 'manual')?.plannedServings).toBe(4);
  });

  it('nie robi nic, gdy skład się nie zmienił', async () => {
    const { tx, mocks } = makeTx({ items: [item('shared', MONDAY, 2, [])] });

    const result = await onRosterChanged(tx, HOUSEHOLD, 2, 2, NOW);

    expect(mocks.planItem.updateMany).not.toHaveBeenCalled();
    expect(mocks.shoppingList.updateMany).not.toHaveBeenCalled();
    expect(result).toEqual({ touchedWeekStarts: [], reDerivedItemCount: 0 });
  });

  it.each([
    [13, 14],
    [12, 15],
  ])(
    'nie robi nic, gdy %i i %i przycinają się do tego samego sufitu',
    async (before, after) => {
      const { tx, mocks } = makeTx({ items: [item('shared', MONDAY, 12, [])] });

      const result = await onRosterChanged(tx, HOUSEHOLD, before, after, NOW);

      expect(mocks.planItem.updateMany).not.toHaveBeenCalled();
      expect(result.reDerivedItemCount).toBe(0);
    },
  );

  it('nie oznacza list nieaktualnymi, gdy nic nie przeliczono', async () => {
    const { tx, mocks } = makeTx({ items: [item('manual', MONDAY, 4, [])] });

    const result = await onRosterChanged(tx, HOUSEHOLD, 1, 2, NOW);

    expect(mocks.shoppingList.updateMany).not.toHaveBeenCalled();
    expect(result.touchedWeekStarts).toEqual([]);
  });
});
