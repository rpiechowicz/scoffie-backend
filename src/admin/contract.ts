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
  | 'ACCOUNT_DELETED'
  /** do operatora (bez `userId`): alert i raport dzienny */
  | 'OPS_ALERT'
  | 'DAILY_REPORT';

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

// ——— Integracje (ROADMAPA §5.9, §5.10) ———

/**
 * Odpowiedź zewnętrznego serwisu tak, jak widzi ją panel. Brak zmiennych na
 * Railwayu to `off` z ich nazwami (panel mówi, co ustawić), awaria dostawcy
 * to `error` — nigdy wyjątek, który położyłby cały ekran.
 */
export type IntegrationState<T> =
  | { status: 'ok'; data: T; fetchedAt: IsoDate }
  | { status: 'off'; missing: string[] }
  | { status: 'error'; message: string; fetchedAt: IsoDate };

// ——— Poczta ———

export type MailStatus = Mail['status'];

/** Wiersz skrzynki nadawczej (`MailMessage`). */
export interface MailRow extends Mail {
  /** `null` po retencji (30 dni od wysyłki) */
  to: string | null;
  userId: string | null;
  subject: string | null;
  /** adres leży na `MailSuppression` */
  suppressed: boolean;
  /** id wiadomości u Resend — po nim szuka się jej w panelu dostawcy */
  providerMessageId: string | null;
  /** kiedy robotnik spróbuje znowu (QUEUED) */
  nextAttemptAt: IsoDate | null;
}

/** Dzień wysyłki (Europe/Warsaw), wiersze wg `createdAt`. */
export interface MailDay {
  date: IsoDate;
  sent: number;
  failed: number;
  skipped: number;
}

/** `MailSuppression` — `reason`: HARD_BOUNCE | COMPLAINT | MANUAL (tekst od dostawcy bywa inny). */
export interface MailSuppressionRow {
  email: string;
  reason: string;
  detail: string | null;
  createdAt: IsoDate;
}

/** Domena nadawcy u Resend (`GET /domains`). */
export interface MailDomain {
  name: string;
  /** `verified`, `pending`, `failed`, … */
  status: string;
  region: string | null;
}

export interface MailFilters {
  status?: MailStatus;
  template?: MailTemplate;
  /** fragment adresu */
  q?: string;
}

/** `GET /admin/mail` */
export interface MailData {
  /** `MAIL_ENABLED` */
  enabled: boolean;
  transport: 'stub' | 'resend';
  /** `MAIL_REDIRECT_TO` ustawiony — wszystko leci na jeden adres */
  redirected: boolean;
  /** wiersze z ostatnich 30 dni wg statusu */
  last30: Record<MailStatus, number>;
  /** QUEUED + SENDING: ile czeka i od kiedy najstarszy */
  queue: { waiting: number; oldestAt: IsoDate | null };
  /** `MAIL_FROM` i `MAIL_REPLY_TO` — adresy firmowe, nie osób */
  from: string;
  replyTo: string;
  /** ostatnie 30 dni, od najstarszego */
  daily: MailDay[];
  /** najnowsze 100 wg filtrów */
  messages: MailRow[];
  suppressions: MailSuppressionRow[];
  resend: IntegrationState<{ domains: MailDomain[] }>;
}

// ——— Stabilność: Sentry + Railway ———

export interface SentryProjectHealth {
  /** `scoffie-ios`, `scoffie-backend`, `scoffie-dashboard` */
  slug: string;
  /** 0–100, ostatnie 24 h; `null` — projekt bez sesji (backend, panel) */
  crashFreeUsers: number | null;
  crashFreeSessions: number | null;
  /** nierozwiązane z aktywnością w 24 h */
  unresolved: number;
  /** pierwszy raz w 24 h */
  new24h: number;
  /** przyjęte zdarzenia błędów w 24 h; `null` — Sentry nie podał */
  events24h: number | null;
  /** najnowsze wydanie projektu */
  release: { version: string; createdAt: IsoDate } | null;
}

export interface SentryIssue {
  id: string;
  /** `SCOFFIE-IOS-1A` */
  shortId: string;
  title: string;
  culprit: string | null;
  level: string;
  project: string;
  /** zdarzenia w 24 h */
  count: number;
  userCount: number;
  firstSeen: IsoDate;
  lastSeen: IsoDate;
  permalink: string;
}

export interface SentryData {
  projects: SentryProjectHealth[];
  /** nierozwiązane z 24 h, najczęstsze pierwsze (do 15) */
  issues: SentryIssue[];
  /** link do organizacji */
  url: string;
  /** projekty z konfiguracji, których w Sentry nie ma (np. `scoffie-android`) */
  missing: string[];
}

export interface RailwayDeploy {
  id: string;
  /** `SUCCESS`, `FAILED`, `CRASHED`, `BUILDING`, `DEPLOYING`, `SLEEPING`, … */
  status: string;
  createdAt: IsoDate;
  commitHash: string | null;
  commitMessage: string | null;
  branch: string | null;
  /** ostatnia zmiana stanu — z `createdAt` daje czas budowy i startu */
  statusUpdatedAt: IsoDate | null;
  /** autor commita */
  author: string | null;
  /** `deploy`, `redeploy`, `rollback`, … — z `meta.reason` */
  reason: string | null;
}

export interface MetricPoint {
  /** sekundy od epoki */
  ts: number;
  value: number;
}

export interface RailwayService {
  id: string;
  name: string;
  /** usługa cron (np. `db-backup`) */
  cron: string | null;
  nextCronRunAt: IsoDate | null;
  /** np. `europe-west4-drams3a` */
  region: string | null;
  replicas: number | null;
  /** najnowsze pierwsze, do 5 */
  deploys: RailwayDeploy[];
  /** vCPU, 24 h co 30 min */
  cpu: MetricPoint[];
  memoryGb: MetricPoint[];
  url: string;
  /** uruchomienia crona, najnowsze pierwsze, do 7; pusta dla nie-cronów */
  runs: CronRun[];
}

export interface RailwayData {
  services: RailwayService[];
}

/** `GET /admin/ops` */
export interface OpsData {
  sentry: IntegrationState<SentryData>;
  railway: IntegrationState<RailwayData>;
}

// ——— App Store Connect ———

export interface AscBuild {
  id: string;
  /** `CFBundleVersion`, np. `35` */
  build: string;
  /** `CFBundleShortVersionString`, np. `1.0` */
  version: string | null;
  /** `PROCESSING`, `FAILED`, `INVALID`, `VALID` */
  processingState: string;
  uploadedAt: IsoDate;
  expired: boolean;
}

export interface AscVersion {
  id: string;
  version: string;
  /** `appVersionState`: `READY_FOR_DISTRIBUTION`, `WAITING_FOR_REVIEW`, `IN_REVIEW`, `REJECTED`, … */
  state: string;
  createdAt: IsoDate;
}

export interface AscReview {
  id: string;
  rating: number;
  title: string | null;
  body: string | null;
  reviewer: string | null;
  /** ISO 3166-1 alfa-3, np. `POL` */
  territory: string | null;
  createdAt: IsoDate;
  /** `id` — odpowiedź w App Store Connect (`customerReviewResponses`) */
  response: { id: string; body: string; state: string } | null;
}

export interface AppStoreData {
  app: { id: string; name: string; bundleId: string };
  /** najnowsze pierwsze, do 10 */
  builds: AscBuild[];
  /** do 5 */
  versions: AscVersion[];
  /** najnowsze pierwsze, do 20 */
  reviews: AscReview[];
  url: string;
}

/** `GET /admin/app-store` */
export type AppStoreState = IntegrationState<AppStoreData>;

// ——— Szczegóły usługi Railway ———

export type OpsRange = '1h' | '6h' | '24h' | '7d' | '30d';

/** Wdrożenie na stronie usługi — dziś to samo co na liście. */
export type RailwayDeployDetail = RailwayDeploy;

export interface RailwayServiceConfig {
  region: string | null;
  replicas: number | null;
  /** `ON_FAILURE`, `ALWAYS`, `NEVER` */
  restartPolicy: string | null;
  restartMaxRetries: number | null;
  healthcheckPath: string | null;
  startCommand: string | null;
  rootDirectory: string | null;
  /** `RAILPACK`, `NIXPACKS`, `DOCKERFILE`, … */
  builder: string | null;
  repo: string | null;
  image: string | null;
  /** usypianie po bezczynności */
  sleeps: boolean;
  cron: string | null;
  nextCronRunAt: IsoDate | null;
  /** publiczne adresy: własne domeny i `*.up.railway.app` */
  domains: string[];
}

export interface LatencyPoint {
  ts: number;
  /** milisekundy */
  p50: number;
  p95: number;
  p99: number;
}

export interface RailwayServiceDetail {
  id: string;
  name: string;
  url: string;
  range: OpsRange;
  config: RailwayServiceConfig;
  metrics: {
    cpu: MetricPoint[];
    memoryGb: MetricPoint[];
    networkRxGb: MetricPoint[];
    networkTxGb: MetricPoint[];
    diskGb: MetricPoint[];
    /** ostatni znany limit usługi; `null` — Railway go nie podał */
    cpuLimit: number | null;
    memoryLimitGb: number | null;
  };
  /** `null` — usługa bez ruchu HTTP (cron, baza, sieć prywatna) */
  http: {
    /** żądania na krok wykresu wg klasy statusu */
    requests: {
      ts: number;
      ok: number;
      redirect: number;
      clientError: number;
      serverError: number;
    }[];
    latency: LatencyPoint[];
  } | null;
  /** najnowsze pierwsze, do 20 */
  deploys: RailwayDeployDetail[];
  /** uruchomienia crona, najnowsze pierwsze, do 30; pusta dla nie-cronów */
  runs: CronRun[];
}

export interface RailwayLogLine {
  timestamp: IsoDate;
  /** `info`, `warn`, `error`, … — `null`, gdy Railway nie rozpoznał */
  severity: string | null;
  message: string;
}

/** `GET /admin/ops/services/:id/logs` */
export interface RailwayLogs {
  deploymentId: string;
  kind: 'deploy' | 'build';
  lines: RailwayLogLine[];
}

/** `GET /admin/ops/services/:id` */
export type RailwayServiceState = IntegrationState<RailwayServiceDetail>;

// ——— Uruchomienia cronów (Railway) ———

/**
 * Jedno uruchomienie usługi cron (`deploymentInstanceExecutions`). Railway nie
 * podaje kodu wyjścia: `EXITED` = proces się zakończył (jedyny sygnał, że np.
 * kopia bazy powstała), `CRASHED` = nieudane, `CREATED`/`INITIALIZING`/
 * `RUNNING` = w toku, reszta (`SKIPPED`, `STOPPED`, `REMOVED`, …) — inne.
 */
export interface CronRun {
  id: string;
  status: string;
  startedAt: IsoDate;
  /** `null` — jeszcze trwa albo Railway nie podał końca */
  finishedAt: IsoDate | null;
}

// ——— Dziennik audytu panelu ———

export type AuditResult = 'PENDING' | 'SUCCESS' | 'FAILED';

export interface AuditEntry {
  id: string;
  at: IsoDate;
  finishedAt: IsoDate | null;
  adminEmail: string;
  /** np. `mail.suppression.add`, `household.tier.set`, `auth.login` */
  action: string;
  /** np. `User`, `Household`, `MailSuppression`, `Recipe` */
  targetType: string | null;
  /** id celu — przy wykluczeniach poczty to adres e-mail */
  targetId: string | null;
  reason: string | null;
  result: AuditResult;
  /** kod błędu przy `FAILED` */
  errorCode: string | null;
  details: Record<string, unknown> | null;
  ip: string | null;
  country: string | null;
}

export interface AuditFilters {
  action?: string;
  result?: AuditResult;
}

/** `GET /admin/audit?action=&result=&before=&limit=` — najnowsze pierwsze */
export interface AuditPage {
  entries: AuditEntry[];
  /** `before` następnej strony; `null` — to już koniec */
  nextCursor: string | null;
  /** akcje, które są w dzienniku (do filtra), alfabetycznie */
  actions: string[];
}

// ——— Sterowanie w locie i odpowiedzi na recenzje (ROADMAPA §5.12, §5.9) ———

export type RuntimeSettingKind = 'boolean' | 'number' | 'list';

export interface RuntimeSettingView {
  /** np. `AI_ENABLED` — biała lista w `src/config/runtime-settings.ts` */
  key: string;
  label: string;
  kind: RuntimeSettingKind;
  /** surowa wartość z Railwaya; `null` — zmiennej nie ma (działa domyślna) */
  envValue: string | null;
  /** nadpisanie z panelu; `null` — działa env */
  override: string | null;
  /** wartość, która naprawdę działa: `true`/`false`, liczba, `off`, adresy po przecinku */
  effective: string;
  updatedAt: IsoDate | null;
  /** adres admina */
  updatedBy: string | null;
  reason: string | null;
}

/** `GET /admin/settings` */
export interface RuntimeSettingsData {
  settings: RuntimeSettingView[];
}

/** `PUT /admin/settings/:key` (step-up); `DELETE` bierze samo `{ reason }` */
export interface RuntimeSettingUpdate {
  value: string;
  reason: string;
}

/** `POST /admin/app-store/reviews/:id/response` (step-up) */
export interface AscReviewResponseInput {
  /** 1–5970 znaków */
  body: string;
}

/** Odpowiedź po zapisie — ten sam kształt co `AscReview.response`. */
export interface AscReviewResponse {
  id: string;
  body: string;
  /** `PUBLISHED`, `PENDING_PUBLISH` */
  state: string;
}

// ——— Alerty i raport dzienny ———

export type AlertSeverity = 'critical' | 'warning';

/** `AdminAlert` — jeden wiersz na problem (nie na sprawdzenie). */
export interface AdminAlertRow {
  id: string;
  /** np. `deploy-failed:<serviceId>:<deployId>`, `crash-free:scoffie-ios` */
  key: string;
  /** `deploy-failed`, `cron-failed`, `crash-free`, `sentry-fatal`, `mail-queue`, `mail-failed`, `mail-domain` */
  kind: string;
  severity: AlertSeverity;
  title: string;
  /** bez danych osobowych */
  detail: string;
  firstAt: IsoDate;
  /** ostatnie sprawdzenie, które jeszcze widziało problem */
  lastAt: IsoDate;
  resolvedAt: IsoDate | null;
  acknowledgedAt: IsoDate | null;
  /** adres admina z panelu */
  acknowledgedBy: string | null;
}

/** Raport „Scoffie wczoraj” o 7:00 (Europe/Warsaw). */
export interface DailyReportInfo {
  /** `ADMIN_DAILY_REPORT` */
  enabled: boolean;
  /** `ADMIN_REPORT_EMAILS` (pusta = jak alerty) */
  emails: string[];
  /** ostatni `MailMessage` z `dedupeKey` `daily-report:%` */
  lastSentAt: IsoDate | null;
  /** doba, której dotyczył (`YYYY-MM-DD`) */
  lastDay: string | null;
}

/** `GET /admin/alerts?state=open|all` */
export interface AlertsData {
  /** otwarte (bez `resolvedAt`), krytyczne pierwsze */
  open: AdminAlertRow[];
  /** zamknięte z ostatnich 30 dni, najnowsze pierwsze (przy `state=open` puste) */
  recent: AdminAlertRow[];
  /** ostatni przebieg sprawdzeń (co 10 min); `null` — od startu jeszcze nie było */
  lastCheckAt: IsoDate | null;
  channels: {
    /** `OPS_ALERT_WEBHOOK_URL` ustawiony */
    webhook: boolean;
    /** `ADMIN_ALERT_EMAILS` (pusta = pierwszy `ADMIN_BOOTSTRAP_EMAIL`) */
    emails: string[];
    /** `MAIL_ENABLED` — bez tego maile do operatora też nie wychodzą */
    mail: boolean;
    /** `ADMIN_ALERTS` — `false` wyłącza sprawdzenia */
    enabled: boolean;
  };
  report: DailyReportInfo;
}

/** `GET /admin/reports/daily/preview?date=YYYY-MM-DD` */
export interface DailyReportPreview {
  /** doba raportu */
  day: string;
  subject: string;
  html: string;
}

/** `POST /admin/reports/daily/send` (step-up) */
export interface DailyReportSendResult {
  day: string;
  /** ile maili trafiło do skrzynki nadawczej */
  queued: number;
  recipients: string[];
}
