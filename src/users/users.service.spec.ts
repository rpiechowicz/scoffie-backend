import { Test, TestingModule } from '@nestjs/testing';
import { UsersService } from './users.service';
import { PrismaService } from '../prisma/prisma.service';
import { AppException } from '../common/app-exception';

// Preferencje jada wylacznie WebSocketem, a tam dekoratory DTO nie dzialaja.
// Serwis jest wiec JEDYNA linia obrony — te testy pilnuja, ze nie przepuszcza
// ani smieci w alergenach (ciche wyrzucenie = uzytkownik mysli, ze jest
// chroniony), ani makr spoza zakresu.

const mockUserId = 'user-1';

const mockPreferenceRow = {
  userId: mockUserId,
  dietPreference: 'NONE',
  calorieGoal: 2000,
  allergens: [] as string[],
  goal: 'HEALTHY',
  activityLevel: 2,
  proteinG: null as number | null,
  fatG: null as number | null,
  carbsG: null as number | null,
  pushPlanChanges: true,
  pushShoppingList: true,
  pushHousehold: true,
  pushQuietHours: true,
  timeZone: null as string | null,
};

const makePrismaMock = () => {
  const mock: any = {
    user: {
      findUnique: jest.fn().mockResolvedValue({ id: mockUserId }),
      findMany: jest.fn().mockResolvedValue([]),
    },
    userPreference: {
      findUnique: jest.fn().mockResolvedValue(mockPreferenceRow),
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockResolvedValue(mockPreferenceRow),
      upsert: jest.fn().mockResolvedValue(mockPreferenceRow),
    },
    $transaction: jest.fn().mockImplementation((cbOrOps: any) => {
      if (typeof cbOrOps === 'function') return cbOrOps(mock);
      return Promise.all(cbOrOps);
    }),
  };
  return mock;
};

describe('UsersService.updatePreferences', () => {
  let service: UsersService;
  let prisma: ReturnType<typeof makePrismaMock>;

  beforeEach(async () => {
    prisma = makePrismaMock();

    const module: TestingModule = await Test.createTestingModule({
      providers: [UsersService, { provide: PrismaService, useValue: prisma }],
    }).compile();

    service = module.get<UsersService>(UsersService);
  });

  const upsertArg = () => prisma.userPreference.upsert.mock.calls[0][0];

  const expectValidationError = async (attempt: Promise<unknown>) => {
    await expect(attempt).rejects.toThrow(AppException);
    try {
      await attempt;
    } catch (error) {
      expect((error as AppException).getResponse()).toMatchObject({
        code: 'VALIDATION_ERROR',
      });
      return error as AppException;
    }
    throw new Error('unreachable');
  };

  describe('alergeny', () => {
    it('powinno znormalizować, zdeduplikować i posortować znane alergeny', async () => {
      await service.updatePreferences(mockUserId, {
        allergens: [' Gluten ', 'SOY', 'eggs', 'gluten'],
      });

      expect(prisma.userPreference.upsert).toHaveBeenCalledTimes(1);
      expect(upsertArg().update.allergens).toEqual(['eggs', 'gluten', 'soy']);
      expect(upsertArg().create.allergens).toEqual(['eggs', 'gluten', 'soy']);
    });

    it('powinno odrzucić nieznany alergen jako VALIDATION_ERROR', async () => {
      const error = await expectValidationError(
        service.updatePreferences(mockUserId, {
          allergens: ['gluten', 'shellfish'],
        }),
      );
      expect((error.getResponse() as { message: string }).message).toContain(
        'shellfish',
      );
    });

    it('nie powinno nic zapisać, gdy alergen jest nieznany', async () => {
      await expectValidationError(
        service.updatePreferences(mockUserId, {
          calorieGoal: 2200,
          allergens: ['shellfish'],
        }),
      );
      expect(prisma.userPreference.upsert).not.toHaveBeenCalled();
    });

    it('powinno pozwolić wyczyścić listę pustą tablicą', async () => {
      await service.updatePreferences(mockUserId, { allergens: [] });

      expect(upsertArg().update.allergens).toEqual([]);
    });

    it('nie powinno ruszać alergenów, gdy pole nie przyszło', async () => {
      await service.updatePreferences(mockUserId, { calorieGoal: 2100 });

      expect('allergens' in upsertArg().update).toBe(false);
    });
  });

  describe('makra', () => {
    it.each([
      ['proteinG', 9999, 400],
      ['proteinG', -50, 0],
      ['fatG', 5000, 300],
      ['fatG', -1, 0],
      ['carbsG', 99999, 800],
      ['carbsG', -10, 0],
    ])('powinno przyciąć %s: %i -> %i', async (field, input, expected) => {
      await service.updatePreferences(mockUserId, { [field]: input } as any);

      expect(upsertArg().update[field]).toBe(expected);
      expect(upsertArg().create[field]).toBe(expected);
    });

    it('powinno zaokrąglić wartość ułamkową', async () => {
      await service.updatePreferences(mockUserId, { proteinG: 160.7 });

      expect(upsertArg().update.proteinG).toBe(161);
    });

    it('powinno zachować null jako null', async () => {
      await service.updatePreferences(mockUserId, {
        proteinG: null,
        fatG: null,
        carbsG: null,
      });

      expect(upsertArg().update.proteinG).toBeNull();
      expect(upsertArg().update.fatG).toBeNull();
      expect(upsertArg().update.carbsG).toBeNull();
    });

    it('powinno przepuścić wartości w zakresie bez zmian', async () => {
      await service.updatePreferences(mockUserId, {
        proteinG: 160,
        fatG: 61,
        carbsG: 254,
      });

      expect(upsertArg().update).toMatchObject({
        proteinG: 160,
        fatG: 61,
        carbsG: 254,
      });
    });

    it('nie powinno ruszać makr, które nie przyszły', async () => {
      await service.updatePreferences(mockUserId, { proteinG: 160 });

      expect('fatG' in upsertArg().update).toBe(false);
      expect('carbsG' in upsertArg().update).toBe(false);
    });

    it.each([
      ['proteinG', 'abc'],
      ['fatG', Number.POSITIVE_INFINITY],
      ['carbsG', Number.NaN],
    ])('powinno odrzucić nieliczbowe %s (%p)', async (field, value) => {
      await expectValidationError(
        service.updatePreferences(mockUserId, { [field]: value } as any),
      );
      expect(prisma.userPreference.upsert).not.toHaveBeenCalled();
    });
  });

  describe('regresja pozostałych pól', () => {
    it.each([
      [99, 1200],
      [9999, 3500],
    ])(
      'powinno nadal przycinać calorieGoal %i -> %i',
      async (input, expected) => {
        await service.updatePreferences(mockUserId, { calorieGoal: input });

        expect(upsertArg().update.calorieGoal).toBe(expected);
      },
    );

    it('powinno nadal przycinać activityLevel do 1..4', async () => {
      await service.updatePreferences(mockUserId, { activityLevel: 9 });

      expect(upsertArg().update.activityLevel).toBe(4);
    });

    it('powinno zamienić pusty timeZone na null', async () => {
      await service.updatePreferences(mockUserId, { timeZone: '   ' });

      expect(upsertArg().update.timeZone).toBeNull();
    });
  });

  // ─── Wycofane API ─────────────────────────────────────────────────────────
  //
  // `users:findAll` zrzucał całą tabelę User (e-mail, googleId, appleSub,
  // waga, płeć) po nieuwierzytelnionym sockecie; `users:create` zakładał konto
  // z dowolnym googleId. Żaden klient ich nie używał. Strażnik przed cichym
  // powrotem: metoda ma NIE istnieć.

  describe('wycofane metody', () => {
    it.each(['findAll', 'findById', 'create'])(
      '%s nie istnieje już w serwisie',
      (method) => {
        expect(
          (service as unknown as Record<string, unknown>)[method],
        ).toBeUndefined();
      },
    );
  });
});

describe('UsersService.getPreferencesForUsers', () => {
  let service: UsersService;
  let prisma: ReturnType<typeof makePrismaMock>;

  beforeEach(async () => {
    prisma = makePrismaMock();
    const module: TestingModule = await Test.createTestingModule({
      providers: [UsersService, { provide: PrismaService, useValue: prisma }],
    }).compile();
    service = module.get<UsersService>(UsersService);
  });

  it('pusta lista nie pyta bazy', async () => {
    const result = await service.getPreferencesForUsers([]);
    expect(result.size).toBe(0);
    expect(prisma.userPreference.findMany).not.toHaveBeenCalled();
  });

  it('deduplikuje id, mapuje po userId i pomija użytkowników bez wiersza (nie tworzy ich)', async () => {
    prisma.userPreference.findMany.mockResolvedValue([
      { ...mockPreferenceRow, userId: 'u1', allergens: ['gluten'] },
    ]);
    const result = await service.getPreferencesForUsers(['u1', 'u2', 'u1', '']);
    expect(prisma.userPreference.findMany).toHaveBeenCalledWith({
      where: { userId: { in: ['u1', 'u2'] } },
    });
    expect(Array.from(result.keys())).toEqual(['u1']);
    expect(result.get('u1')?.allergens).toEqual(['gluten']);
    expect(prisma.userPreference.create).not.toHaveBeenCalled();
  });
});
