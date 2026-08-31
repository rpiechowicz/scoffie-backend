/**
 * Fixture'y kopert zdarzeń WS dla testów refleksyjnych po wszystkich
 * handlerach (`ws-handlers-auth.spec.ts`, `ws-handlers-validation.spec.ts`).
 *
 * Jedno źródło prawdy: KAŻDE zdarzenie `@SubscribeMessage` w repo ma tu
 * wpis w `VALID_PAYLOADS`, a każde czytające coś z koperty — także w
 * `INVALID_PAYLOADS`. Snapshoty w spec-ach pilnują, żeby nowy handler nie
 * wszedł bez fixture (czerwony test z czytelnym komunikatem).
 *
 * `INVALID_PAYLOADS` to WYŁĄCZNIE błędy KOPERTY (brak/zły typ `data`, nie-UUID,
 * zły typ `weekStart`/`weekLabel`) — w harnessie serwisy są mockami, więc
 * zawartość `data`/`filters` (zły enum, zakres liczb) sprawdzają spec-i
 * serwisów per moduł i e2e (`test/ws-validation.e2e-spec.ts`).
 *
 * Plik nie jest suitą (nie kończy się na `.spec.ts`) i nie wchodzi do builda
 * (`tsconfig.build.json` wyklucza `**\/*.spec-helper.ts`).
 */

export const HH = '3fa85f64-5717-4562-b3fc-2c963f66afa6';
export const RECIPE = '7adf5ec0-e3e5-4b28-8bb4-5515c780948c';
export const RECIPE_2 = '22222222-2222-4222-8222-222222222222';
export const MEMBER = '22222222-2222-4222-8222-222222222222';
export const ARCHIVE = '44444444-4444-4444-8444-444444444444';
export const USER = '11111111-1111-4111-8111-111111111111';
export const WEEK_START = '2026-08-31';

/**
 * Handlery, które nie czytają z koperty nic poza legacy `userId` — nie wołają
 * `validateWsPayload`, więc nie mają wpisu w `INVALID_PAYLOADS`; muszą za to
 * przeżyć `payload === undefined` (znosi to `actorId`).
 */
export const HANDLERS_WITHOUT_INPUT: ReadonlySet<string> = new Set([
  'users:me',
  'users:preferences:get',
  'users:delete',
  'users:onboarding:complete',
  'households:findAll',
  'households:listPendingInvitations',
]);

/**
 * Handlery, które z założenia nie wołają żadnego serwisu (stub/deprecated).
 * Dla pozostałych test z tokenem wymaga, żeby serwis został wywołany —
 * inaczej „żaden argument nie zawiera 'attacker'" byłoby prawdziwe pusto.
 */
export const HANDLERS_WITHOUT_SERVICE: ReadonlySet<string> = new Set([
  'weeklyPlans:getSavedPlan',
]);

/**
 * Handlery, które WOŁAJĄ serwis, ale nie przekazują mu tożsamości — bo zasób
 * jest wspólny dla całej instalacji i nie zależy od tego, kto pyta.
 *
 * Kontrola dodatnia „tożsamość z socketu faktycznie została użyta" ich nie
 * dotyczy; wciąż obowiązuje je jednak wymóg, żeby `payload.userId` atakującego
 * nie dotarł nigdzie, i żeby anonimowy socket dostał UNAUTHORIZED.
 */
export const HANDLERS_WITHOUT_IDENTITY_ARG: ReadonlySet<string> = new Set([
  // Katalog składników jest jeden dla wszystkich gospodarstw.
  'ingredients:search',
]);

export type InvalidCase = {
  /** Krótki opis do nazwy testu. */
  name: string;
  payload: unknown;
  /** Podciąg, który MUSI pojawić się w `details` (opcjonalnie). */
  detail?: string;
};

const hhWeek = { householdId: HH, weekStart: WEEK_START };

/** Jedna POPRAWNA koperta per zdarzenie (wartości takie, jakie wysyła iOS). */
export const VALID_PAYLOADS: Readonly<Record<string, object>> = {
  // UsersGateway
  'users:me': { userId: HH },
  'users:preferences:get': {},
  'users:preferences:update': {
    userId: HH,
    data: {
      dietPreference: 'VEGAN',
      goal: 'LOSE',
      calorieGoal: 2200,
      allergens: ['gluten', 'soy'],
      activityLevel: 3,
      proteinG: 160,
      fatG: null,
      carbsG: 254,
      pushPlanChanges: true,
      pushShoppingList: false,
      pushHousehold: true,
      pushQuietHours: true,
      timeZone: 'Europe/Warsaw',
    },
  },
  'users:profile:update': {
    userId: HH,
    data: {
      displayName: 'Ania',
      yearOfBirth: 1992,
      heightCm: 178,
      weightKg: 83.5,
      sex: 'FEMALE',
    },
  },
  'users:delete': {},
  'users:onboarding:complete': {},
  // RecipesGateway
  'recipes:findAll': {
    householdId: HH,
    filters: {
      householdId: HH,
      mealType: 'DINNER',
      isFavorite: false,
      page: 1,
      // iOS prosi o pełną stronę 100 (`RecipeCatalogStore.pageSize`) — to
      // brzeg `@Max` w FindRecipesDto; fixture ma go pilnować.
      limit: 100,
    },
  },
  'recipes:findById': { id: RECIPE, householdId: HH },
  'ingredients:search': { filters: { query: 'kurczak', limit: 5 } },
  'recipes:create': {
    data: {
      householdId: HH,
      title: 'Makaron z pomidorami',
      description: 'Prosty makaron z sosem pomidorowym.',
      mealType: 'DINNER',
      suitableMealTypes: ['LUNCH'],
      difficulty: 'EASY',
      prepTimeMinutes: 20,
      servings: 2,
      nutritionKcal: 520,
      nutritionProtein: 18,
      nutritionFat: 12,
      nutritionCarbs: 80,
      nutritionFiber: 6,
      nutritionSalt: 1.2,
    },
  },
  'recipes:setFavorite': {
    data: { recipeId: RECIPE, householdId: HH, isFavorite: true },
  },
  // NotificationsGateway
  'notifications:registerDevice': {
    data: {
      deviceToken:
        'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789',
      platform: 'IOS',
      appBundleId: 'com.example.weeklymeals',
      apnsEnvironment: 'SANDBOX',
    },
  },
  // WeeklyPlansGateway
  'weeklyPlans:getByWeek': { ...hhWeek },
  'weeklyPlans:getShoppingList': { ...hhWeek },
  'weeklyPlans:getShoppingListState': { ...hhWeek },
  'weeklyPlans:archiveShoppingList': { ...hhWeek, weekLabel: 'Tydzień 36' },
  'weeklyPlans:selectShoppingListArchive': {
    householdId: HH,
    archiveId: ARCHIVE,
  },
  'weeklyPlans:deleteShoppingListArchive': {
    householdId: HH,
    archiveId: ARCHIVE,
  },
  'weeklyPlans:deleteAllShoppingListArchives': { ...hhWeek },
  'weeklyPlans:setShoppingItemChecked': {
    ...hhWeek,
    data: { productKey: 'mleko::l', isChecked: true },
  },
  'weeklyPlans:upsertWeekSlot': {
    ...hhWeek,
    data: {
      dayOfWeek: 'MON',
      mealType: 'DINNER',
      recipeId: RECIPE_2,
      participantIds: [],
      plannedServings: 2,
    },
  },
  'weeklyPlans:applyWeekPlan': {
    ...hhWeek,
    data: {
      slots: [
        {
          dayOfWeek: 'MON',
          mealType: 'DINNER',
          recipeId: RECIPE_2,
          participantIds: [],
          plannedServings: 2,
        },
      ],
      dryRun: true,
    },
  },
  'weeklyPlans:removeWeekSlot': {
    ...hhWeek,
    data: { dayOfWeek: 'MON', mealType: 'DINNER', recipeId: RECIPE_2 },
  },
  'weeklyPlans:setMealEaten': {
    ...hhWeek,
    data: {
      dayOfWeek: 'MON',
      mealType: 'DINNER',
      recipeId: RECIPE_2,
      isEaten: true,
    },
  },
  'weeklyPlans:getSavedPlan': { ...hhWeek },
  'weeklyPlans:clearWeekPlan': { ...hhWeek },
  // HouseholdsGateway
  'households:findAll': { userId: USER },
  'households:findById': { id: HH },
  'households:create': { data: { name: 'Dom' } },
  'households:createInvitation': { householdId: HH, data: {} },
  'households:acceptInvitation': {
    data: { token: 'tok-12345678', leaveOtherHouseholds: true },
  },
  'households:previewInvitation': { data: { token: 'tok-12345678' } },
  'households:listPendingInvitations': { userId: USER },
  'households:declineInvitation': { data: { token: 'tok-12345678' } },
  'households:updateName': { householdId: HH, data: { name: 'Nowy dom' } },
  'households:updateMealTypes': {
    householdId: HH,
    data: { mealTypes: ['BREAKFAST', 'LUNCH', 'DINNER', 'SNACK'] },
  },
  'households:updateMealTimes': {
    householdId: HH,
    data: { mealSlotTimes: { BREAKFAST: 480, LUNCH: 840, DINNER: 1200 } },
  },
  'households:listMembers': { householdId: HH },
  'households:memberPreferences': { householdId: HH },
  'households:updateMemberRole': {
    householdId: HH,
    memberUserId: MEMBER,
    data: { role: 'OWNER' },
  },
  'households:removeMember': { householdId: HH, memberUserId: MEMBER },
  'households:leave': { householdId: HH },
};

const NOT_UUID = 'hh-1';
const UUID_DETAIL = 'must be a UUID';
const DATA_DETAIL = 'data must be an object';

const badHouseholdId = (rest: object): InvalidCase => ({
  name: 'householdId nie-UUID',
  payload: { ...rest, householdId: NOT_UUID },
  detail: 'householdId must be a UUID',
});
const missingData = (rest: object): InvalidCase => ({
  name: 'brak data',
  payload: { ...rest },
  detail: DATA_DETAIL,
});
const dataNotObject = (rest: object, value: unknown): InvalidCase => ({
  name: `data = ${JSON.stringify(value)}`,
  payload: { ...rest, data: value },
  detail: DATA_DETAIL,
});

/** 1–3 ZŁE koperty per zdarzenie z wejściem (błędy koperty, nie zawartości `data`). */
export const INVALID_PAYLOADS: Readonly<Record<string, InvalidCase[]>> = {
  // UsersGateway
  'users:preferences:update': [
    missingData({}),
    dataNotObject({}, 'VEGAN'),
    dataNotObject({}, ['VEGAN']),
  ],
  'users:profile:update': [missingData({}), dataNotObject({}, 'Ania')],
  // RecipesGateway
  'recipes:findAll': [
    badHouseholdId({ filters: {} }),
    {
      name: 'filters jako napis',
      payload: { filters: 'all' },
      detail: 'filters must be an object',
    },
  ],
  'recipes:findById': [
    {
      name: 'brak id',
      payload: { householdId: HH },
      detail: 'id must be a UUID',
    },
    { name: 'id nie-UUID', payload: { id: 'recipe-1' }, detail: UUID_DETAIL },
    {
      name: 'householdId nie-UUID',
      payload: { id: RECIPE, householdId: NOT_UUID },
      detail: 'householdId must be a UUID',
    },
  ],
  'ingredients:search': [
    {
      name: 'filters nie jest obiektem',
      payload: { filters: 'kurczak' },
      detail: 'filters must be an object',
    },
  ],
  'recipes:create': [missingData({}), dataNotObject({}, 'Makaron')],
  'recipes:setFavorite': [missingData({}), dataNotObject({}, 42)],
  // NotificationsGateway
  'notifications:registerDevice': [
    missingData({ userId: HH }),
    dataNotObject({}, 'abcdef0123456789'),
  ],
  // WeeklyPlansGateway
  'weeklyPlans:getByWeek': [
    badHouseholdId({ weekStart: WEEK_START }),
    {
      name: 'brak weekStart',
      payload: { householdId: HH },
      detail: 'weekStart must be a string',
    },
  ],
  'weeklyPlans:getShoppingList': [
    {
      name: 'brak householdId',
      payload: { weekStart: WEEK_START },
      detail: 'householdId must be a UUID',
    },
    {
      name: 'weekStart liczbą',
      payload: { householdId: HH, weekStart: 20260831 },
      detail: 'weekStart must be a string',
    },
  ],
  'weeklyPlans:getShoppingListState': [
    badHouseholdId({ weekStart: WEEK_START }),
    { name: 'pusta koperta', payload: {}, detail: UUID_DETAIL },
  ],
  'weeklyPlans:archiveShoppingList': [
    {
      name: 'brak weekLabel',
      payload: { ...hhWeek },
      detail: 'weekLabel must be a string',
    },
    {
      name: 'weekLabel liczbą',
      payload: { ...hhWeek, weekLabel: 36 },
      detail: 'weekLabel must be a string',
    },
  ],
  'weeklyPlans:selectShoppingListArchive': [
    {
      name: 'archiveId nie-UUID',
      payload: { householdId: HH, archiveId: 'arch-1' },
      detail: 'archiveId must be a UUID',
    },
    {
      name: 'brak archiveId',
      payload: { householdId: HH },
      detail: 'archiveId must be a UUID',
    },
  ],
  'weeklyPlans:deleteShoppingListArchive': [
    {
      name: 'archiveId nie-UUID',
      payload: { householdId: HH, archiveId: 'arch-1' },
      detail: 'archiveId must be a UUID',
    },
    badHouseholdId({ archiveId: ARCHIVE }),
  ],
  'weeklyPlans:deleteAllShoppingListArchives': [
    badHouseholdId({ weekStart: WEEK_START }),
    {
      name: 'brak weekStart',
      payload: { householdId: HH },
      detail: 'weekStart must be a string',
    },
  ],
  'weeklyPlans:setShoppingItemChecked': [
    missingData(hhWeek),
    dataNotObject(hhWeek, 'mleko::l'),
  ],
  'weeklyPlans:applyWeekPlan': [
    missingData(hhWeek),
    dataNotObject(hhWeek, 'wszystko'),
    badHouseholdId({ weekStart: WEEK_START, data: { slots: [] } }),
  ],
  'weeklyPlans:upsertWeekSlot': [
    missingData(hhWeek),
    badHouseholdId({
      weekStart: WEEK_START,
      data: { dayOfWeek: 'MON', mealType: 'DINNER', recipeId: RECIPE_2 },
    }),
    dataNotObject(hhWeek, []),
  ],
  'weeklyPlans:removeWeekSlot': [
    dataNotObject(hhWeek, 'MON'),
    {
      name: 'weekStart null',
      payload: {
        householdId: HH,
        weekStart: null,
        data: { dayOfWeek: 'MON', mealType: 'DINNER' },
      },
      detail: 'weekStart must be a string',
    },
  ],
  'weeklyPlans:setMealEaten': [
    missingData(hhWeek),
    dataNotObject(hhWeek, null),
  ],
  'weeklyPlans:getSavedPlan': [
    badHouseholdId({ weekStart: WEEK_START }),
    {
      name: 'brak weekStart',
      payload: { householdId: HH },
      detail: 'weekStart must be a string',
    },
  ],
  'weeklyPlans:clearWeekPlan': [
    badHouseholdId({ weekStart: WEEK_START }),
    {
      name: 'weekStart liczbą',
      payload: { householdId: HH, weekStart: 123 },
      detail: 'weekStart must be a string',
    },
  ],
  // HouseholdsGateway
  'households:findById': [
    {
      name: 'id nie-UUID',
      payload: { id: NOT_UUID },
      detail: 'id must be a UUID',
    },
    { name: 'pusta koperta', payload: {}, detail: 'id must be a UUID' },
  ],
  'households:create': [missingData({}), dataNotObject({}, 'Dom')],
  'households:createInvitation': [
    badHouseholdId({}),
    dataNotObject({ householdId: HH }, 'jutro'),
  ],
  'households:acceptInvitation': [
    missingData({}),
    dataNotObject({}, 'tok-12345678'),
  ],
  'households:previewInvitation': [
    dataNotObject({}, 'tok-12345678'),
    dataNotObject({}, null),
  ],
  'households:declineInvitation': [missingData({}), dataNotObject({}, 7)],
  'households:updateName': [
    missingData({ householdId: HH }),
    badHouseholdId({ data: { name: 'Nowy dom' } }),
  ],
  'households:updateMealTypes': [
    badHouseholdId({ data: { mealTypes: ['DINNER'] } }),
    dataNotObject({ householdId: HH }, ['DINNER']),
  ],
  'households:updateMealTimes': [
    missingData({ householdId: HH }),
    {
      name: 'brak householdId',
      payload: { data: { mealSlotTimes: { BREAKFAST: 480 } } },
      detail: 'householdId must be a UUID',
    },
  ],
  'households:listMembers': [
    {
      name: 'pusta koperta',
      payload: {},
      detail: 'householdId must be a UUID',
    },
    badHouseholdId({}),
  ],
  'households:memberPreferences': [
    {
      name: 'pusta koperta',
      payload: {},
      detail: 'householdId must be a UUID',
    },
    badHouseholdId({}),
  ],
  'households:updateMemberRole': [
    {
      name: 'memberUserId nie-UUID',
      payload: {
        householdId: HH,
        memberUserId: 'user-2',
        data: { role: 'OWNER' },
      },
      detail: 'memberUserId must be a UUID',
    },
    missingData({ householdId: HH, memberUserId: MEMBER }),
  ],
  'households:removeMember': [
    {
      name: 'brak memberUserId',
      payload: { householdId: HH },
      detail: 'memberUserId must be a UUID',
    },
    {
      name: 'memberUserId nie-UUID',
      payload: { householdId: HH, memberUserId: 'member-1' },
      detail: 'memberUserId must be a UUID',
    },
  ],
  'households:leave': [
    badHouseholdId({}),
    {
      name: 'pusta koperta',
      payload: {},
      detail: 'householdId must be a UUID',
    },
  ],
};
