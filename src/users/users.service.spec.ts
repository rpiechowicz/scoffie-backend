import { Test, TestingModule } from '@nestjs/testing';
import { UsersService } from './users.service';
import { PrismaService } from '../prisma/prisma.service';
import { AppException } from '../common/app-exception';

// Preferencje i profil jadą wyłącznie WebSocketem, gdzie dekoratory DTO same z
// siebie nie działają — serwis woła `validateDto` na wejściu i jest JEDYNĄ
// linią obrony (także dla narzędzi asystenta, które wołają go in-process).
// Te testy pilnują, że złe wejście = AppException VALIDATION_ERROR z listą
// dozwolonych w `details`, a Prisma nie jest wołana; oraz że normalizacje
// (alergeny, timeZone, `null` w makrach) nadal działają dla poprawnych danych.

const mockUserId = '3fa85f64-5717-4562-b3fc-2c963f66afa6';

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

const mockUserRow = {
  id: mockUserId,
  displayName: 'Rafał',
  email: 'r@example.com',
  avatarUrl: null,
  yearOfBirth: 1992,
  heightCm: 178,
  weightKg: 83.5,
  sex: 'MALE',
  avatarColor: 1,
  onboardingCompletedAt: null,
};

const makePrismaMock = () => {
  const mock: any = {
    user: {
      findUnique: jest.fn().mockResolvedValue({ id: mockUserId }),
      findMany: jest.fn().mockResolvedValue([]),
      update: jest.fn().mockResolvedValue(mockUserRow),
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

const DIET_PREFERENCE_VALUES =
  'NONE, VEGETARIAN, VEGAN, PESCATARIAN, KETO, PALEO, HIGH_PROTEIN';
const USER_GOAL_VALUES = 'HEALTHY, LOSE, GAIN, MAINTAIN, PLAN';

/**
 * `AppException` z kodem VALIDATION_ERROR; oddaje wyjątek, żeby test mógł
 * zajrzeć w `details` (listę dozwolonych wartości dla klienta i asystenta).
 */
const expectValidationError = async (attempt: Promise<unknown>) => {
  await expect(attempt).rejects.toThrow(AppException);
  try {
    await attempt;
  } catch (error) {
    expect((error as AppException).getResponse()).toMatchObject({
      code: 'VALIDATION_ERROR',
    });
    expect((error as AppException).getStatus()).toBe(400);
    return error as AppException;
  }
  throw new Error('unreachable');
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

  describe('enumy Prismy', () => {
    it('powinno zapisać poprawne dietPreference i goal', async () => {
      await service.updatePreferences(mockUserId, {
        dietPreference: 'VEGAN',
        goal: 'LOSE',
      } as any);

      expect(upsertArg().update).toMatchObject({
        dietPreference: 'VEGAN',
        goal: 'LOSE',
      });
      expect(upsertArg().create).toMatchObject({
        dietPreference: 'VEGAN',
        goal: 'LOSE',
      });
    });

    it("dietPreference 'vegan' (mała litera) → VALIDATION_ERROR z listą enumu, upsert nie wywołany", async () => {
      const error = await expectValidationError(
        service.updatePreferences(mockUserId, {
          dietPreference: 'vegan',
        } as any),
      );

      expect(error.details).toEqual([
        `dietPreference must be one of the following values: ${DIET_PREFERENCE_VALUES}`,
      ]);
      expect(prisma.userPreference.upsert).not.toHaveBeenCalled();
    });

    it("goal 'lose' → VALIDATION_ERROR z listą enumu", async () => {
      const error = await expectValidationError(
        service.updatePreferences(mockUserId, { goal: 'lose' } as any),
      );

      expect(error.details).toEqual([
        `goal must be one of the following values: ${USER_GOAL_VALUES}`,
      ]);
      expect(prisma.userPreference.upsert).not.toHaveBeenCalled();
    });
  });

  describe('booleany push*', () => {
    it.each([
      'pushPlanChanges',
      'pushShoppingList',
      'pushHousehold',
      'pushQuietHours',
    ])(
      "%s: string 'true' → VALIDATION_ERROR, upsert nie wywołany",
      async (field) => {
        const error = await expectValidationError(
          service.updatePreferences(mockUserId, { [field]: 'true' } as any),
        );

        expect(error.details).toEqual([`${field} must be a boolean value`]);
        expect(prisma.userPreference.upsert).not.toHaveBeenCalled();
      },
    );

    it('prawdziwe booleany przechodzą (także false)', async () => {
      await service.updatePreferences(mockUserId, {
        pushPlanChanges: false,
        pushQuietHours: true,
      });

      expect(upsertArg().update).toMatchObject({
        pushPlanChanges: false,
        pushQuietHours: true,
      });
      expect('pushHousehold' in upsertArg().update).toBe(false);
    });
  });

  describe('alergeny', () => {
    it('powinno zdeduplikować i posortować znane alergeny', async () => {
      await service.updatePreferences(mockUserId, {
        allergens: ['soy', 'gluten', 'eggs'],
      });

      expect(prisma.userPreference.upsert).toHaveBeenCalledTimes(1);
      expect(upsertArg().update.allergens).toEqual(['eggs', 'gluten', 'soy']);
      expect(upsertArg().create.allergens).toEqual(['eggs', 'gluten', 'soy']);
    });

    it('powinno odrzucić nieznany alergen jako VALIDATION_ERROR z listą dozwolonych', async () => {
      const error = await expectValidationError(
        service.updatePreferences(mockUserId, {
          allergens: ['gluten', 'shellfish'],
        }),
      );
      expect(error.details).toEqual([
        'each value in allergens must be one of the following values: ' +
          'gluten, lactose, eggs, nuts, peanuts, fish, soy, celery, mustard, sesame, ' +
          'milk, crustaceans, molluscs, lupin, sulphites',
      ]);
    });

    // Biała lista to DOKŁADNIE `rawValue` enuma iOS (małe litery) — inna
    // wielkość liter albo spacje to błąd klienta, nie wartość do naprawienia.
    it("powinno odrzucić ' Gluten ' i 'SOY' (inna pisownia niż rawValue iOS)", async () => {
      await expectValidationError(
        service.updatePreferences(mockUserId, {
          allergens: [' Gluten ', 'SOY'],
        }),
      );
      expect(prisma.userPreference.upsert).not.toHaveBeenCalled();
    });

    it('powinno odrzucić duplikaty (ArrayUnique)', async () => {
      await expectValidationError(
        service.updatePreferences(mockUserId, {
          allergens: ['gluten', 'gluten'],
        }),
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
      ['proteinG', 9999, 'proteinG must not be greater than 400'],
      ['proteinG', -50, 'proteinG must not be less than 0'],
      ['fatG', 5000, 'fatG must not be greater than 300'],
      ['fatG', -1, 'fatG must not be less than 0'],
      ['carbsG', 99999, 'carbsG must not be greater than 800'],
      ['carbsG', -10, 'carbsG must not be less than 0'],
    ])(
      'powinno odrzucić %s = %i poza zakresem (VALIDATION_ERROR, bez upsertu)',
      async (field, input, detail) => {
        const error = await expectValidationError(
          service.updatePreferences(mockUserId, { [field]: input } as any),
        );

        expect(error.details).toEqual([detail]);
        expect(prisma.userPreference.upsert).not.toHaveBeenCalled();
      },
    );

    it('powinno odrzucić wartość ułamkową (makra są całkowite)', async () => {
      const error = await expectValidationError(
        service.updatePreferences(mockUserId, { proteinG: 160.7 }),
      );

      expect(error.details).toEqual(['proteinG must be an integer number']);
    });

    it('powinno zachować null jako null (powrót do liczenia automatem)', async () => {
      await service.updatePreferences(mockUserId, {
        proteinG: null,
        fatG: null,
        carbsG: null,
      });

      expect(upsertArg().update.proteinG).toBeNull();
      expect(upsertArg().update.fatG).toBeNull();
      expect(upsertArg().update.carbsG).toBeNull();
      expect(upsertArg().create.proteinG).toBeNull();
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
      ['proteinG', '160'],
    ])('powinno odrzucić nieliczbowe %s (%p)', async (field, value) => {
      await expectValidationError(
        service.updatePreferences(mockUserId, { [field]: value } as any),
      );
      expect(prisma.userPreference.upsert).not.toHaveBeenCalled();
    });
  });

  describe('calorieGoal, activityLevel, timeZone', () => {
    it.each([
      [99, 'calorieGoal must not be less than 1200'],
      [9999, 'calorieGoal must not be greater than 3500'],
    ])(
      'calorieGoal %i poza zakresem → VALIDATION_ERROR (klamra w serwisie jest drugą linią)',
      async (input, detail) => {
        const error = await expectValidationError(
          service.updatePreferences(mockUserId, { calorieGoal: input }),
        );

        expect(error.details).toEqual([detail]);
        expect(prisma.userPreference.upsert).not.toHaveBeenCalled();
      },
    );

    it("calorieGoal '2000' (string liczbowy) → VALIDATION_ERROR, bez cichej konwersji", async () => {
      const error = await expectValidationError(
        service.updatePreferences(mockUserId, { calorieGoal: '2000' } as any),
      );

      expect(error.details).toEqual([
        'calorieGoal must not be greater than 3500',
        'calorieGoal must not be less than 1200',
        'calorieGoal must be an integer number',
      ]);
    });

    it('calorieGoal w zakresie przechodzi', async () => {
      await service.updatePreferences(mockUserId, { calorieGoal: 2200 });

      expect(upsertArg().update.calorieGoal).toBe(2200);
    });

    it('activityLevel 9 → VALIDATION_ERROR', async () => {
      const error = await expectValidationError(
        service.updatePreferences(mockUserId, { activityLevel: 9 }),
      );

      expect(error.details).toEqual([
        'activityLevel must not be greater than 4',
      ]);
    });

    it('activityLevel 1..4 przechodzi', async () => {
      await service.updatePreferences(mockUserId, { activityLevel: 4 });

      expect(upsertArg().update.activityLevel).toBe(4);
    });

    it('powinno zamienić pusty timeZone na null', async () => {
      await service.updatePreferences(mockUserId, { timeZone: '   ' });

      expect(upsertArg().update.timeZone).toBeNull();
    });

    it('timeZone nie-string → VALIDATION_ERROR, nie TypeError', async () => {
      const error = await expectValidationError(
        service.updatePreferences(mockUserId, { timeZone: 42 } as any),
      );

      expect(error.details).toEqual([
        'timeZone must be shorter than or equal to 64 characters',
        'timeZone must be a string',
      ]);
    });

    it('timeZone dłuższy niż 64 znaki → VALIDATION_ERROR', async () => {
      await expectValidationError(
        service.updatePreferences(mockUserId, { timeZone: 'x'.repeat(65) }),
      );
    });
  });

  describe('kształt wejścia', () => {
    it('nieznane pole (halucynacja asystenta) → VALIDATION_ERROR', async () => {
      const error = await expectValidationError(
        service.updatePreferences(mockUserId, {
          dietTags: ['VEGAN'],
        } as any),
      );

      expect(error.details).toEqual(['property dietTags should not exist']);
      expect(prisma.userPreference.upsert).not.toHaveBeenCalled();
    });

    it('kilka błędów naraz → wszystkie w details, jeden zapis nie idzie', async () => {
      const error = await expectValidationError(
        service.updatePreferences(mockUserId, {
          dietPreference: 'vegan',
          pushPlanChanges: 'true',
        } as any),
      );

      expect(error.details).toHaveLength(2);
      expect(prisma.userPreference.upsert).not.toHaveBeenCalled();
    });

    it('puste wejście (undefined) → pusty upsert zamiast TypeError', async () => {
      await service.updatePreferences(mockUserId, undefined as any);

      expect(upsertArg().update).toEqual({});
      expect(upsertArg().where).toEqual({ userId: mockUserId });
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

describe('UsersService.updateProfile', () => {
  let service: UsersService;
  let prisma: ReturnType<typeof makePrismaMock>;

  beforeEach(async () => {
    prisma = makePrismaMock();
    const module: TestingModule = await Test.createTestingModule({
      providers: [UsersService, { provide: PrismaService, useValue: prisma }],
    }).compile();
    service = module.get<UsersService>(UsersService);
  });

  const updateArg = () => prisma.user.update.mock.calls[0][0];

  it('zapisuje tylko przysłane pola, displayName po trimie', async () => {
    const result = await service.updateProfile(mockUserId, {
      displayName: '  Ania ',
      weightKg: 83.5,
      sex: 'FEMALE',
    } as any);

    expect(updateArg()).toEqual({
      where: { id: mockUserId },
      data: { displayName: 'Ania', weightKg: 83.5, sex: 'FEMALE' },
    });
    expect(result).toMatchObject({ id: mockUserId, displayName: 'Rafał' });
  });

  it('displayName z samych spacji przechodzi DTO, ale nie nadpisuje nazwy', async () => {
    await service.updateProfile(mockUserId, { displayName: '   ' });

    expect(updateArg().data).toEqual({});
  });

  it('weightKg 835 → VALIDATION_ERROR, update nie wywołany', async () => {
    const error = await expectValidationError(
      service.updateProfile(mockUserId, { weightKg: 835 }),
    );

    expect(error.details).toEqual(['weightKg must not be greater than 300']);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("sex 'X' → VALIDATION_ERROR z listą enumu Prismy", async () => {
    const error = await expectValidationError(
      service.updateProfile(mockUserId, { sex: 'X' } as any),
    );

    expect(error.details).toEqual([
      'sex must be one of the following values: MALE, FEMALE',
    ]);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it.each([
    ['yearOfBirth', 1850, 'yearOfBirth must not be less than 1900'],
    ['yearOfBirth', 1992.5, 'yearOfBirth must be an integer number'],
    ['heightCm', 30, 'heightCm must not be less than 80'],
    ['heightCm', 999, 'heightCm must not be greater than 260'],
    ['weightKg', 10, 'weightKg must not be less than 30'],
    [
      'weightKg',
      83.55,
      'weightKg must be a number conforming to the specified constraints',
    ],
    [
      'displayName',
      '',
      'displayName must be longer than or equal to 1 characters',
    ],
    [
      'displayName',
      'x'.repeat(65),
      'displayName must be shorter than or equal to 64 characters',
    ],
  ])('%s = %p → VALIDATION_ERROR', async (field, value, detail) => {
    const error = await expectValidationError(
      service.updateProfile(mockUserId, { [field]: value } as any),
    );

    expect(error.details).toEqual([detail]);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("heightCm '178' (string liczbowy) → VALIDATION_ERROR, bez cichej konwersji", async () => {
    await expectValidationError(
      service.updateProfile(mockUserId, { heightCm: '178' } as any),
    );
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('nieznane pole → VALIDATION_ERROR', async () => {
    const error = await expectValidationError(
      service.updateProfile(mockUserId, { email: 'x@y.z' } as any),
    );

    expect(error.details).toEqual(['property email should not exist']);
  });
});

describe('UsersService — brak użytkownika', () => {
  let service: UsersService;
  let prisma: ReturnType<typeof makePrismaMock>;

  beforeEach(async () => {
    prisma = makePrismaMock();
    prisma.user.findUnique.mockResolvedValue(null);
    const module: TestingModule = await Test.createTestingModule({
      providers: [UsersService, { provide: PrismaService, useValue: prisma }],
    }).compile();
    service = module.get<UsersService>(UsersService);
  });

  it('deleteAccount → AppException NOT_FOUND 404 (po polsku), bez transakcji', async () => {
    await expect(service.deleteAccount(mockUserId)).rejects.toMatchObject({
      response: { code: 'NOT_FOUND', message: 'Nie znaleziono użytkownika.' },
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('completeOnboarding → AppException NOT_FOUND 404', async () => {
    await expect(service.completeOnboarding(mockUserId)).rejects.toMatchObject({
      response: { code: 'NOT_FOUND' },
    });
    expect(prisma.user.update).not.toHaveBeenCalled();
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
