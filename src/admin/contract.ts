/**
 * Kontrakt odpowiedzi panelu administratora (`/admin/*`).
 *
 * KOPIA `scoffie-dashboard/src/api/types.ts` (bez typów czysto
 * interfejsowych). Front typuje tymi samymi nazwami, więc każda zmiana
 * kształtu odpowiedzi idzie W OBU repozytoriach naraz — tu pilnuje jej
 * kompilator backendu, tam `pnpm typecheck` panelu.
 *
 * Każde pole ma pokrycie w `prisma/schema.prisma` albo w metrykach
 * `/ops/*` — panel niczego nie wymyśla.
 */

/** ISO 8601 — formatowanie po stronie panelu, strefa Europe/Warsaw. */
export type IsoDate = string;

export type MealType =
  | 'BREAKFAST'
  | 'SECOND_BREAKFAST'
  | 'LUNCH'
  | 'AFTERNOON_SNACK'
  | 'DINNER'
  | 'SNACK';

/** `SUBSCRIPTION_PRODUCTS` z `src/config/subscription-products.ts`. */
export type ProductId =
  | 'app.scoffie.pro.solo.monthly'
  | 'app.scoffie.pro.duet.monthly'
  | 'app.scoffie.pro.family.monthly';

/**
 * Plan gospodarstwa tak, jak liczy go `resolvePlan`: nadanie operatora
 * (`tierOverride = PRO`), subskrypcja któregoś z domowników albo próba.
 */
export type HouseholdPlan =
  | { kind: 'trial' }
  | { kind: 'override' }
  | { kind: 'subscription'; productId: ProductId };

/** Pula z `AiUsageCounter` w zakresie (`sub:<id>`, `trial:<hasz>` albo id domu). */
export interface Pool {
  scopeId: string;
  messages: { used: number; limit: number };
  plans: { used: number; limit: number };
  /** próba nie odnawia się — `null` */
  resetsAt: IsoDate | null;
}

export interface Trend {
  d1: number;
  d7?: number;
}

// ——— Pulpit ———

export interface DayStat {
  date: IsoDate;
  /** `User.createdAt` */
  newUsers: number;
  /** `AgentTurn.createdAt` */
  turns: number;
  /** `PlanItem.createdAt` — dania dodane do planów */
  planItems: number;
  /** `AiUsage.costMicroUsd` / 1e6 */
  aiCostUsd: number;
}

export interface TopRecipe {
  id: string;
  title: string;
  imageUrl: string;
  mealType: MealType;
  kcalPerServing: number;
  prepTimeMinutes: number;
  /** `PlanItem` z tym przepisem w planach bieżącego tygodnia */
  plans: number;
}

export interface Attention {
  /** zgłoszenia z ostatnich 7 dni bez decyzji */
  reports: number;
  /** `MailMessage.status = FAILED` */
  mailsFailed: number;
  /** `Subscription.status = GRACE` */
  subsInGrace: number;
  /** `AppleNotification.processedAt IS NULL` */
  appleUnprocessed: number;
  /** `CookidooIntegration.status = AUTH_FAILED` */
  cookidooFailed: number;
  /** `RefreshToken.revokedReason = REUSE` w ostatniej dobie — sygnał przejęcia */
  tokenReuse24h: number;
}

/** `/ops/health` + `/ops/metrics` */
export interface Production {
  commit: string;
  uptimeSeconds: number;
  requests: number;
  errors5xx: number;
  migrations: { applied: number; latest: string };
  ws: { connected: number };
}

export interface DashboardData {
  /** `User.lastLoginAt` dzisiaj */
  loggedInToday: number;
  loggedInTrend: Trend;
  today: {
    newUsers: number;
    turns: number;
    planItems: number;
    aiCostUsd: number;
  };
  /** tury z dziś według `AgentTurn.status` */
  turnsToday: { done: number; failed: number; running: number };
  mrrZl: number;
  mrrTrend: Trend;
  mrrSpark: number[];
  activeSubs: number;
  subsTrend: Trend;
  subsSpark: number[];
  /** gospodarstwa z `WeeklyPlan` na bieżący tydzień, który ma pozycje */
  plannedHouseholds: number;
  households: number;
  days: DayStat[];
  topRecipes: TopRecipe[];
  attention: Attention;
  production: Production;
}

// ——— Użytkownicy ———

export interface UserListItem {
  id: string;
  displayName: string;
  email: string | null;
  /** adres z przekaźnika Apple (@privaterelay.appleid.com) */
  hiddenEmail: boolean;
  onboardingCompletedAt: IsoDate | null;
  lastLoginAt: IsoDate | null;
  createdAt: IsoDate;
  householdId: string | null;
  householdName: string | null;
  role: 'OWNER' | 'MEMBER' | null;
  plan: HouseholdPlan | null;
  /** czy ta osoba płaci (`Subscription.purchaserUserId`) */
  paying: boolean;
  /** kolor awatara z `User.avatarColor` */
  avatarColor: number;
}

export interface UserListFilters {
  q?: string;
  onboarding?: boolean;
  subscribed?: boolean;
  active7?: boolean;
  noHousehold?: boolean;
}

export interface UserList {
  total: number;
  items: UserListItem[];
  stats: {
    total: number;
    hiddenEmail: number;
    onboarded: number;
    loggedIn7d: number;
    paying: number;
    aiConsent: number;
  };
}

/** `RefreshToken` — rodzina tokenów jednego urządzenia. */
export interface RefreshSession {
  id: string;
  createdAt: IsoDate;
  expiresAt: IsoDate;
  revokedAt: IsoDate | null;
  revokedReason: 'ROTATED' | 'LOGOUT' | 'REUSE' | 'RECOVERED' | null;
}

/** `PushDevice` */
export interface PushDevice {
  id: string;
  appBundleId: string;
  apnsEnvironment: 'SANDBOX' | 'PRODUCTION';
  isActive: boolean;
  createdAt: IsoDate;
  lastSeenAt: IsoDate;
}

export type ConsentKind =
  | 'TERMS'
  | 'PRIVACY'
  | 'AI_ASSISTANT'
  | 'COOKIDOO'
  | 'AGE_16'
  | 'HEALTH_DATA';

/** `ConsentEvent` — tylko dopisywane */
export interface ConsentEvent {
  id: string;
  kind: ConsentKind;
  action: 'GRANTED' | 'REVOKED';
  /** data wersji z `legal-documents.ts` */
  documentVersion: string;
  appVersion: string | null;
  createdAt: IsoDate;
}

export type MailTemplate =
  | 'WELCOME'
  | 'HOUSEHOLD_JOINED'
  | 'AI_TRIAL_EXHAUSTED'
  | 'AI_QUOTA_EXHAUSTED'
  | 'SUBSCRIPTION_GRACE'
  | 'SUBSCRIPTION_EXPIRED'
  | 'LEGAL_UPDATE'
  | 'ACCOUNT_DELETED';

/** `MailMessage` */
export interface Mail {
  id: string;
  template: MailTemplate;
  status: 'QUEUED' | 'SENDING' | 'SENT' | 'FAILED' | 'SKIPPED';
  attempts: number;
  lastError: string | null;
  sentAt: IsoDate | null;
  createdAt: IsoDate;
}

export type SubscriptionStatus = 'ACTIVE' | 'GRACE' | 'EXPIRED' | 'REVOKED';

/** `Subscription` */
export interface Subscription {
  id: string;
  productId: ProductId;
  status: SubscriptionStatus;
  environment: 'Production' | 'Sandbox';
  ownershipType: 'PURCHASED' | 'FAMILY_SHARED';
  expiresAt: IsoDate | null;
  graceExpiresAt: IsoDate | null;
  autoRenewStatus: boolean | null;
  lastVerifiedAt: IsoDate | null;
  operatorHoldAt: IsoDate | null;
  createdAt: IsoDate;
}

export interface UserDetail extends UserListItem {
  householdMembers: number;
  /** `AgentTurn` + `AiUsage` bieżącego miesiąca */
  assistant: {
    turns: number;
    failed: number;
    costUsd: number;
    avgTurnSeconds: number;
    conversations: number;
    proposalsApplied: number;
    daily: number[];
  };
  subscription: Subscription | null;
  pushDevices: PushDevice[];
  sessions: RefreshSession[];
  consents: ConsentEvent[];
  mails: Mail[];
  /** `DailyStepCount.source` z ostatniego zapisu */
  stepsSource: 'APPLE_HEALTH' | 'GARMIN' | null;
  /** notatki `AgentMemory.aboutUserId` — tylko liczba */
  memoryNotes: number;
}

/** `User` + `UserPreference` — dane szczególnej kategorii, dopiero po „Odsłoń”. */
export interface HealthData {
  yearOfBirth: number | null;
  heightCm: number | null;
  weightKg: number | null;
  sex: 'MALE' | 'FEMALE' | null;
  goal: 'HEALTHY' | 'LOSE' | 'GAIN' | 'MAINTAIN' | 'PLAN';
  calorieGoal: number;
  dietPreference:
    | 'NONE'
    | 'VEGETARIAN'
    | 'VEGAN'
    | 'PESCATARIAN'
    | 'KETO'
    | 'PALEO'
    | 'HIGH_PROTEIN';
  allergens: string[];
  activityLevel: number;
  revealedUntil: IsoDate;
}

// ——— Gospodarstwa ———

export interface HouseholdListItem {
  id: string;
  name: string;
  plan: HouseholdPlan;
  members: {
    userId: string;
    displayName: string;
    role: 'OWNER' | 'MEMBER';
    avatarColor: number;
  }[];
  pool: Pool;
  /** `CookidooIntegration.status` */
  cookidoo: 'CONNECTED' | 'AUTH_FAILED' | null;
  lastLoginAt: IsoDate | null;
  createdAt: IsoDate;
}

/** `Invitation` — anonimowy link; adresat znany dopiero po podejrzeniu. */
export interface Invitation {
  id: string;
  createdByName: string | null;
  invitedUserName: string | null;
  redeemedByName: string | null;
  createdAt: IsoDate;
  expiresAt: IsoDate;
  redeemedAt: IsoDate | null;
  declinedAt: IsoDate | null;
}

export interface HouseholdDetail extends HouseholdListItem {
  enabledMealTypes: MealType[];
  /** minuty od północy; brak klucza = pora bez stałej godziny */
  mealSlotTimes: Partial<Record<MealType, number>> | null;
  invitations: Invitation[];
  /** `AiUsage` domu w tym miesiącu wobec `AI_HOUSEHOLD_MONTHLY_COST_USD` */
  costMonthUsd: number;
  costCapUsd: number;
  cookidooInfo: {
    connectedByName: string | null;
    lastVerifiedAt: IsoDate | null;
    lastErrorCode: string | null;
  } | null;
  weeklyPlans: number;
  favorites: number;
  memoryNotes: number;
}

// ——— Asystent ———

export interface ProfitDay {
  date: IsoDate;
  revenueZl: number;
  costUsd: number;
  trialCostUsd: number;
}

/** Wynik liczony per zakres puli (`quotaScopeId`), nie per dom. */
export interface ProfitRow {
  scopeId: string;
  householdId: string;
  householdName: string;
  productId: ProductId;
  revenueZl: number;
  costUsd: number;
  turns: number;
}

export type ProposalStatus =
  | 'PENDING'
  | 'APPLIED'
  | 'UNDONE'
  | 'STALE'
  | 'EXPIRED'
  | 'FAILED';

export interface ProfitData {
  fxUsdPln: number;
  revenueTrend: number;
  marginTrendPp: number;
  trials: number;
  days: ProfitDay[];
  rows: ProfitRow[];
  proposals: Record<ProposalStatus, number>;
  /** `AgentTurn.durationMs` */
  turnHistogram: { bucket: string; count: number }[];
  p50: number;
  p95: number;
  /** `AiUsage.model` */
  models: { model: string; turns: number; costUsd: number }[];
  /** `AgentTurn.errorCode` */
  errors: { code: string; count: number }[];
}

export type ProfitPeriod = '7' | '30' | 'month';

/** Powody z `AGENT_REPORT_REASONS` (backend) = `AssistantReportSheet` (iOS). */
export type ReportReason = 'WRONG' | 'UNSAFE' | 'OFFENSIVE' | 'OTHER';
/** Kolumna `status` na `AgentReport` jest w planie (ROADMAPA §5.5) — dziś zgłoszenie tylko się zapisuje. */
export type ReportStatus = 'NEW' | 'REVIEWED' | 'DISMISSED';

/** `AgentReport` + tura, do której należała wiadomość (`turnId`). */
export interface AgentReport {
  id: string;
  userId: string;
  userName: string;
  reason: ReportReason;
  comment: string | null;
  /** migawka treści — przeżywa 90-dniową retencję rozmów */
  messageText: string;
  createdAt: IsoDate;
  turn: {
    model: string;
    costUsd: number;
    durationMs: number;
    status: 'DONE' | 'FAILED';
    errorCode: string | null;
  } | null;
  status: ReportStatus;
  testId: string | null;
}

// ——— Subskrypcje ———

export interface AppleNotification {
  notificationUuid: string;
  notificationType: string;
  subtype: string | null;
  environment: 'Production' | 'Sandbox';
  /** osoba z subskrypcji po `originalTransactionId` — może jej już nie być */
  userName: string | null;
  receivedAt: IsoDate;
  processedAt: IsoDate | null;
  attempts: number;
  error: string | null;
}

export interface SubscriptionsData {
  mrrZl: number;
  arrZl: number;
  mrrTrend: number;
  mrrSeries: { month: string; value: number }[];
  movement: {
    newSubs: number;
    renewals: number;
    churned: number;
    trends: [number, number, number];
  };
  byProduct: { productId: ProductId; count: number }[];
  familyShared: number;
  sandbox: number;
  risk: {
    userId: string;
    name: string;
    productId: ProductId;
    kind: 'grace' | 'autoRenewOff' | 'operatorHold';
    until: IsoDate | null;
  }[];
  notifications: AppleNotification[];
}

// ——— Katalog ———

export interface RecipeListItem {
  id: string;
  title: string;
  imageUrl: string;
  /** `Recipe.isActive` — wycofany przepis nie pokazuje się w katalogu */
  isActive: boolean;
  mealType: MealType;
  prepTimeMinutes: number;
  kcalPerServing: number;
  /** w ilu planach stoi teraz (przed wycofaniem) */
  inPlans: number;
  favorites: number;
}

export interface Ingredient {
  key: string;
  name: string;
  unit: 'g' | 'ml';
  kcal: number;
  protein: number;
  carbs: number;
  fat: number;
  fiber: number;
  gramsPerPiece: number | null;
  allergens: string[];
  dietTags: string[];
}

export interface RecipeIngredientLine {
  key: string;
  amount: number;
  unit: string;
}

export interface RecipeDetail extends RecipeListItem {
  description: string;
  difficulty: 'EASY' | 'MEDIUM' | 'HARD';
  servings: number;
  suitableMealTypes: MealType[];
  steps: string[];
  ingredients: RecipeIngredientLine[];
  allergens: string[];
  dietTags: string[];
  updatedAt: IsoDate;
}

/**
 * `PUT /admin/catalog/recipes/:id` (step-up) — ciało to `RecipeDetail`
 * z edytora; odpowiedź 200 to świeży `RecipeDetail` (nowe `updatedAt`,
 * przeliczone makro/`kcalPerServing`, alergeny, tagi diet, sloty).
 *
 * Zapisywane: `title`, `description`, `mealType`, `suitableMealTypes`
 * (serwer dokłada podpowiedzi klasyfikatora), `difficulty`,
 * `prepTimeMinutes` (1–1440), `servings` (1–8), `steps` (1–40 niepustych),
 * `ingredients` (1–60, `key` aktywnego składnika, `unit` z listy importu,
 * każdy składnik raz). `updatedAt` z `GET` WYMAGANE. Reszta pól jest
 * pomijana; `imageUrl` inny niż zapisany = 400.
 *
 * Błędy: 403 `STEP_UP_REQUIRED` · 400 `VALIDATION_ERROR` (`details`: pola,
 * „nieznany składnik: …”, „brak makro na 100 g: …”) · 404 `RECIPE_NOT_FOUND`
 * · 409 `CONFLICT` (przepis zmieniony po `GET` — odśwież i nanieś ponownie).
 */
export type RecipeSaveRequest = Pick<
  RecipeDetail,
  | 'title'
  | 'description'
  | 'mealType'
  | 'suitableMealTypes'
  | 'difficulty'
  | 'prepTimeMinutes'
  | 'servings'
  | 'steps'
  | 'ingredients'
  | 'updatedAt'
> &
  Partial<RecipeDetail>;

export interface SearchResults {
  users: UserListItem[];
  households: HouseholdListItem[];
  recipes: RecipeListItem[];
}

// ——— Logowanie do panelu (ROADMAPA §4, warstwa 1) ———
// Kontrakt z backendem: `scoffie-backend/docs/plans/scoffie-admin/API-AUTH.md`.
// Każdy endpoint stoi za bramką Cloudflare Access (bez niej 404), więc
// tożsamość Google jest już potwierdzona — panel dokłada drugi składnik.

/** Passkey (Face ID / Touch ID), kod z Google Authenticator albo kod odzyskiwania. */
export type AdminAuthMethod = 'passkey' | 'totp' | 'recovery';

/** `GET /admin/auth/state` — przed zalogowaniem. */
export interface AuthState {
  /** e-mail z tokenu Cloudflare Access */
  email: string;
  /** w bazie nie ma jeszcze admina, a e-mail = `ADMIN_BOOTSTRAP_EMAIL` — pierwsze wejście */
  bootstrap: boolean;
  /** czym to konto może się zalogować; pusta przy bootstrapie i dla obcego e-maila */
  methods: AdminAuthMethod[];
  /** blokada po 5 nieudanych próbach */
  lockedUntil: IsoDate | null;
}

export interface AdminSession {
  name: string;
  email: string;
  /** czym otwarto tę sesję */
  method: AdminAuthMethod;
  /** twardy koniec sesji (12 h) */
  expiresAt: IsoDate;
  /** potwierdzenie przed groźną akcją ważne do (5 min) */
  stepUpUntil: IsoDate | null;
  /** co jest skonfigurowane — panel prowadzi do dwóch metod wejścia */
  setup: { passkeys: number; totp: boolean; recoveryCodesLeft: number };
  /** wejście kodem odzyskiwania — najpierw nowy passkey albo TOTP */
  mustReenroll: boolean;
}

/** `GET /admin/auth/sessions` */
export interface AdminSessionInfo {
  id: string;
  current: boolean;
  method: AdminAuthMethod;
  createdAt: IsoDate;
  lastSeenAt: IsoDate;
  ip: string | null;
  /** `CF-IPCountry` */
  country: string | null;
  userAgent: string | null;
}

/** `GET /admin/auth/passkeys` */
export interface AdminPasskey {
  id: string;
  name: string;
  createdAt: IsoDate;
  lastUsedAt: IsoDate | null;
}

/** Kody w ciele błędu logowania i uprawnień: `{ code, message, lockedUntil? }`. */
export type AuthErrorCode =
  | 'INVALID_CODE'
  | 'PASSKEY_FAILED'
  | 'LOCKED'
  | 'STEP_UP_REQUIRED'
  | 'LAST_METHOD'
  | 'NOT_ALLOWED';
