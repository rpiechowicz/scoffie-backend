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
  /**
   * Konto z listy właściciela (`ADMIN_BOOTSTRAP_EMAIL`) — testowy push bez
   * potwierdzenia. Brak pola = starszy backend (panel pyta jak o obcą osobę).
   */
  ownerAccount?: boolean;
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
  /** dzień notowania NBP kursu `fxUsdPln`; `null` — stała cennika (brak kursu w bazie) */
  fxDate?: string | null;
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

export type RuntimeSettingKind = 'boolean' | 'number' | 'list' | 'choice';

export interface RuntimeSettingView {
  /** np. `AI_ENABLED` — biała lista w `src/config/runtime-settings.ts` */
  key: string;
  label: string;
  kind: RuntimeSettingKind;
  /** dozwolone wartości przy `kind: 'choice'` (np. `AI_CARDS_MODE`) */
  options?: string[];
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
  /** `deploy-failed`, `cron-failed`, `crash-free`, `sentry-fatal`, `mail-queue`, `mail-failed`, `mail-domain`, `gdpr-due` */
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

// ——— Wzrost: lejek, kohorty, aktywni (ROADMAPA §5.8) ———

/** `GET /admin/growth?period=7|30|90` — kohorta rejestracji z ostatnich N dób (Warszawa). */
export type GrowthPeriod = '7' | '30' | '90';

/**
 * Kroki lejka po kolei: `User.createdAt` → `onboardingCompletedAt` →
 * pierwsze `Membership` → pierwszy `PlanItem` w domu osoby → zgoda
 * `ConsentEvent` AI_ASSISTANT/GRANTED → pierwsza `AgentTurn` → pierwsza
 * `Subscription` APPLE z produkcji.
 */
export type FunnelStepKey =
  | 'registered'
  | 'onboarded'
  | 'household'
  | 'plan'
  | 'aiConsent'
  | 'firstTurn'
  | 'purchase';

export interface FunnelStep {
  key: FunnelStepKey;
  /** osoby z kohorty, które doszły do tego kroku i do wszystkich poprzednich */
  users: number;
  /** % od rejestracji (0–100, jedno miejsce po przecinku) */
  pctOfStart: number;
  /** % od poprzedniego kroku (pierwszy krok: 100) */
  pctOfPrevious: number;
  /** mediana czasu od rejestracji do kroku w sekundach; `null` — nikt nie doszedł */
  medianSecondsToStep: number | null;
}

/** Tygodniowa kohorta rejestracji (tydzień od poniedziałku, Warszawa). */
export interface Cohort {
  /** poniedziałek tygodnia rejestracji (północ w Warszawie) */
  weekStart: IsoDate;
  users: number;
  /**
   * tydzień 0..8: % osób kohorty aktywnych w tym tygodniu (`UserActivityDay`);
   * `null` — tydzień jeszcze nie nastał albo skończył się przed `activitySince`
   */
  weeks: (number | null)[];
}

/** Doba z `UserActivityDay`: DAU tej doby, WAU z 7 i MAU z 30 dób do niej włącznie. */
export interface ActiveDay {
  /** północ doby w Warszawie */
  date: IsoDate;
  dau: number;
  wau: number;
  mau: number;
}

export interface GrowthData {
  period: GrowthPeriod;
  funnel: FunnelStep[];
  /** ostatnie 12 tygodni, najstarszy pierwszy */
  cohorts: Cohort[];
  /** ostatnie 30 dób do dziś włącznie */
  active: ActiveDay[];
  /** od kiedy zbieramy aktywność (wdrożenie tabeli); `null` — jeszcze nie */
  activitySince: IsoDate | null;
}

// ——— Karta osoby: testowy push, błędy Sentry; rejestr wniosków RODO (ROADMAPA §5.10, §5.11) ———

/**
 * `POST /admin/users/:id/devices/:deviceId/test-push` (step-up). Na
 * urządzenie konta spoza listy właściciela — tylko z `confirmForeign` i powodem.
 */
export interface PushTestInput {
  confirmForeign?: boolean;
  /** 5–500 znaków; wymagany przy obcej osobie */
  reason?: string;
}

/** Odpowiedź APNs na testowy push — bez treści powiadomienia. */
export interface PushTestResult {
  /** APNs przyjął (HTTP 200) */
  ok: boolean;
  /** HTTP z APNs; 0 = brak odpowiedzi */
  status: number;
  /** nagłówek `apns-id` */
  apnsId: string | null;
  /** `BadDeviceToken`, `Unregistered`, `DeviceTokenNotForTopic`, `TopicDisallowed`, `NoResponse`, … */
  reason: string | null;
  environment: 'SANDBOX' | 'PRODUCTION';
  /** `apns-topic` — bundle id urządzenia */
  topic: string;
  sentAt: IsoDate;
}

/** Zdarzenie Sentry osoby (`organizations/{org}/events/`, `user.id`). */
export interface SentryUserEvent {
  id: string;
  title: string;
  level: string;
  /** slug projektu */
  project: string;
  /** wydanie aplikacji, np. `app.scoffie@1.0.3+35` */
  release: string | null;
  at: IsoDate;
  permalink: string;
}

/** `GET /admin/users/:id/sentry` — ostatnie 14 dni */
export interface SentryUserData {
  /** problemy z co najmniej jednym zdarzeniem tej osoby; `count` = zdarzenia w 14 dni (wszystkich osób) */
  issues: SentryIssue[];
  /** najnowsze zdarzenia osoby */
  events: SentryUserEvent[];
  /** `true` — Sentry nie oddał listy zdarzeń (problemy są) */
  eventsUnavailable: boolean;
  /** wyszukiwanie w Sentry po `user.id` */
  url: string;
}

export type SentryUserState = IntegrationState<SentryUserData>;

export type GdprKind =
  | 'ACCESS'
  | 'ERASURE'
  | 'RECTIFICATION'
  | 'RESTRICTION'
  | 'OBJECTION'
  | 'PORTABILITY';
export type GdprStatus = 'OPEN' | 'IN_PROGRESS' | 'DONE' | 'REJECTED';
/** skąd przyszedł wniosek */
export type GdprChannel = 'EMAIL' | 'APP' | 'STORE' | 'POST' | 'OTHER';

/** `GdprRequest` — wiersz rejestru */
export interface GdprRequestRow {
  id: string;
  kind: GdprKind;
  status: GdprStatus;
  receivedAt: IsoDate;
  /** `receivedAt` + 30 dni, po przedłużeniu + 90 */
  dueAt: IsoDate;
  /** przedłużony o 60 dni (art. 12 ust. 3) */
  extended: boolean;
  requesterEmail: string;
  userId: string | null;
  /** `displayName` powiązanego konta; `null` — brak konta albo usunięte */
  userName: string | null;
  channel: GdprChannel;
  closedAt: IsoDate | null;
  createdAt: IsoDate;
}

/** `GET /admin/gdpr?state=open|closed|all&kind=` */
export interface GdprData {
  stats: {
    /** OPEN + IN_PROGRESS */
    open: number;
    /** otwarte, termin za mniej niż 7 dni */
    dueSoon: number;
    /** otwarte po terminie */
    overdue: number;
    /** DONE + REJECTED w ostatnich 30 dniach */
    closed30d: number;
  };
  /** otwarte: najbliższy termin pierwszy; zamknięte: najnowsze pierwsze */
  items: GdprRequestRow[];
}

export interface GdprFilters {
  /** domyślnie `open` */
  state?: 'open' | 'closed' | 'all';
  kind?: GdprKind;
}

/** `GET /admin/gdpr/:id` */
export interface GdprRequestDetail extends GdprRequestRow {
  notes: string | null;
  extensionReason: string | null;
  /** DONE / REJECTED — co odpowiedzieliśmy */
  resolution: string | null;
  /** adres admina, który zamknął */
  closedBy: string | null;
  /** wpisy dziennika audytu z `targetId` = id wniosku, najstarsze pierwsze */
  history: AuditEntry[];
}

/** `POST /admin/gdpr` */
export interface GdprCreateInput {
  kind: GdprKind;
  channel: GdprChannel;
  /** domyślnie teraz; nie z przyszłości */
  receivedAt?: IsoDate;
  requesterEmail: string;
  userId?: string | null;
  notes?: string | null;
}

/** `PATCH /admin/gdpr/:id` — powiązanie z kontem i notatki */
export interface GdprUpdateInput {
  userId?: string | null;
  notes?: string | null;
}

/** `POST /admin/gdpr/:id/status` — tylko otwarte stany */
export interface GdprStatusInput {
  status: 'OPEN' | 'IN_PROGRESS';
}

/** `POST /admin/gdpr/:id/extend` — raz, przed terminem; `reason` = uzasadnienie */
export interface GdprExtendInput {
  reason: string;
}

/** `POST /admin/gdpr/:id/close` — `resolution` trafia też jako powód do dziennika */
export interface GdprCloseInput {
  status: 'DONE' | 'REJECTED';
  resolution: string;
}

// ——— Przychód z Apple i kurs NBP (ROADMAPA §5.6) ———

/** `GET /admin/revenue?period=30|90|365` — dni wstecz od wczoraj. */
export type RevenuePeriod = '30' | '90' | '365';

/** Kurs średni NBP (tabela A); przy pustej tabeli — stała cennika. */
export interface FxInfo {
  /** dzień notowania `YYYY-MM-DD`; `null` — brak kursu w bazie */
  date: string | null;
  usdPln: number;
  /** `null` — brak notowania EUR w bazie */
  eurPln: number | null;
  /** `NBP` — z bazy; `REFERENCE` — `REFERENCE_USD_PLN` z cennika */
  source: 'NBP' | 'REFERENCE';
}

/** Dzień raportu Sales Summary (zakupy w aplikacji). */
export interface RevenueDay {
  /** dzień raportu Apple `YYYY-MM-DD` */
  date: string;
  /** netto (zakupy − zwroty) */
  units: number;
  proceedsPln: number;
  proceedsUsd: number;
}

export interface RevenueProductRow {
  /** SKU = productId subskrypcji */
  sku: string;
  title: string;
  /** `IAY` — subskrypcja odnawialna, `IA1` — jednorazowy zakup, … */
  productType: string;
  units: number;
  /** sztuki ze znakiem minus (zwroty), jako liczba dodatnia */
  refunds: number;
  proceedsPln: number;
}

export interface RevenueCountryRow {
  /** ISO 3166-1 alpha-2 */
  country: string;
  units: number;
  proceedsPln: number;
}

/** Raport finansowy (FINANCIAL, region ZZ) — miesiąc × waluta rozliczenia. */
export interface RevenueFinanceRow {
  /** miesiąc fiskalny Apple `YYYY-MM` */
  month: string;
  currency: string;
  units: number;
  /** w walucie `currency` */
  proceeds: number;
  /** po kursie NBP z ostatniego dnia miesiąca; `null` — waluta spoza tabeli A */
  proceedsPln: number | null;
}

export interface RevenueSync {
  /** ostatnia udana synchronizacja raportów sprzedaży; `null` — jeszcze nie było */
  salesSyncedAt: IsoDate | null;
  financeSyncedAt: IsoDate | null;
  /** najnowszy dzień z jakąkolwiek sprzedażą w bazie */
  lastSaleDate: string | null;
}

export interface RevenueData {
  period: RevenuePeriod;
  /** `off` — brak klucza ASC albo `ADMIN_ASC_VENDOR_NUMBER`; `error` — ostatnia synchronizacja padła (dane poniżej mogą być starsze) */
  state: IntegrationState<RevenueSync>;
  /** każdy dzień okresu, od najstarszego (dni bez sprzedaży = 0) */
  days: RevenueDay[];
  totals: {
    units: number;
    refunds: number;
    proceedsPln: number;
    proceedsUsd: number;
    avgPerDayPln: number;
    /** cena brutto zapłacona przez osoby, w PLN */
    customerPricePln: number;
  };
  /** najwyższy przychód pierwszy */
  byProduct: RevenueProductRow[];
  byCountry: RevenueCountryRow[];
  /** najnowszy miesiąc pierwszy */
  finance: RevenueFinanceRow[];
  fx: FxInfo;
  /** MRR z cennika (brutto) — ta sama liczba co na ekranie Subskrypcje */
  estimatedMrrPln: number;
  /** to samo po VAT i prowizji Apple — do porównania z wypłatą */
  estimatedNetMrrPln: number;
  /** waluty wypłat bez kursu NBP (tabela A) — ich kwot nie ma w sumach w PLN */
  unconverted: string[];
}

// ——— Katalog: jakość i popularność · Baza danych · Ruch · Historia Sterowania ———

/**
 * Rodzaje luk w przepisie katalogu (`GET /admin/catalog/insights`):
 * - `no-image` — brak `imageUrl`
 * - `zero-macros` — kcal ≤ 0 albo białko + tłuszcz + węgle ≈ 0
 * - `kcal-mismatch` — kcal różni się od makro (Atwater) o > 25 %
 * - `ingredient-no-nutrition` — składnik bez wartości odżywczych
 * - `piece-no-grams` — składnik w `szt` bez `gramsPerPiece`
 * - `no-meal-types` — puste `suitableMealTypes` (brak backfillu pór)
 * - `no-steps` — brak kroków przygotowania
 * - `no-ingredients` — przepis bez składników
 */
export type CatalogGapKind =
  | 'no-image'
  | 'zero-macros'
  | 'kcal-mismatch'
  | 'ingredient-no-nutrition'
  | 'piece-no-grams'
  | 'no-meal-types'
  | 'no-steps'
  | 'no-ingredients';

export interface CatalogGapRecipe {
  id: string;
  title: string;
  /** pusty — brak zdjęcia */
  imageUrl: string;
  isActive: boolean;
  mealType: MealType;
  gaps: CatalogGapKind[];
  /** nazwy składników przy `ingredient-no-nutrition` i `piece-no-grams` */
  ingredients: string[];
  /** cały przepis, jak `Recipe.nutritionKcal` */
  kcal: number;
  /** 4·B + 4·W + 9·T + 2·błonnik — do porównania przy `kcal-mismatch` */
  kcalFromMacros: number;
}

/** Pozycja rankingu popularności — tylko przepisy katalogu. */
export interface CatalogRankItem {
  id: string;
  title: string;
  imageUrl: string;
  isActive: boolean;
  count: number;
}

/** Składnik z „czego nie jem” — sama liczba osób, bez osób. */
export interface CatalogExcludedIngredient {
  key: string;
  name: string;
  count: number;
}

export interface CatalogPopularity {
  /** okno rankingów „w planach”, „zjedzone”, „proponowane” */
  days: number;
  /** pozycje planu (`PlanItem`) dodane w oknie */
  planned: CatalogRankItem[];
  /** `PlanItemConsumption` w oknie */
  eaten: CatalogRankItem[];
  /** `RecipeFavorite` — łącznie, bez okna */
  favorites: CatalogRankItem[];
  /** nowe dania w kartach propozycji asystenta (`AgentProposal`) w oknie */
  proposed: CatalogRankItem[];
  /** aktywne przepisy, których nikt nigdy nie dodał do planu (do 50) */
  neverUsed: CatalogRankItem[];
  neverUsedTotal: number;
  /** `UserPreference.excludedIngredientIds` — liczba osób na składnik */
  excludedIngredients: CatalogExcludedIngredient[];
}

/** `GET /admin/catalog/insights` */
export interface CatalogInsights {
  /** liczba przepisów z daną luką */
  gaps: Record<CatalogGapKind, number>;
  /** przepisy z co najmniej jedną luką, najpierw aktywne i z największą liczbą luk */
  recipes: CatalogGapRecipe[];
  popularity: CatalogPopularity;
  generatedAt: IsoDate;
}

export interface DatabaseTable {
  name: string;
  /** `pg_total_relation_size` — z indeksami i TOAST */
  totalBytes: number;
  /** `pg_class.reltuples` — szacunek; `-1`/brak analizy = 0 */
  rowsEstimate: number;
}

/** Zapytanie trwające > 5 s — BEZ tekstu (mógłby zawierać dane). */
export interface DatabaseLongQuery {
  seconds: number;
  /** `active`, `idle in transaction`, … */
  state: string;
  /** `Lock`, `IO`, … — `null`, gdy nie czeka */
  waitEventType: string | null;
}

/** `pg_stat_statements` — tekst znormalizowany (`$1`), przycięty do 200 znaków. */
export interface DatabaseSlowQuery {
  query: string;
  calls: number;
  meanMs: number;
  totalMs: number;
}

/** `GET /admin/ops/database` */
export interface DatabaseData {
  sizeBytes: number;
  /** 10 największych tabel */
  tables: DatabaseTable[];
  /** połączenia klientów tej bazy wg `state` */
  connections: { state: string; count: number }[];
  /** `max_connections` */
  maxConnections: number | null;
  longQueries: DatabaseLongQuery[];
  migrations: {
    /** `null` — brak tabeli `_prisma_migrations` */
    last: { name: string; finishedAt: IsoDate | null } | null;
    applied: number;
    /** nazwy migracji rozpoczętych, niezakończonych i niecofniętych */
    failed: string[];
  };
  /** `null` — rozszerzenie `pg_stat_statements` niewłączone albo niedostępne */
  slowQueries: DatabaseSlowQuery[] | null;
  fetchedAt: IsoDate;
}

export interface TrafficDay {
  /** `YYYY-MM-DD` (UTC, jak w Cloudflare) */
  date: string;
  requests: number;
  /** unikalni odwiedzający danego dnia (`uniq.uniques`) */
  visitors: number;
  pageViews: number;
}

export interface TrafficCount {
  /** ścieżka albo kod kraju (ISO 3166-1 alfa-2) */
  name: string;
  count: number;
}

/** `GET /admin/traffic` — strefa scoffie.app z Cloudflare, 30 dni. */
export interface TrafficData {
  /** cała strefa (także img. i dashboard.), dzień po dniu, bez dziur */
  days: TrafficDay[];
  /** strony `scoffie.app` (bez plików, bez błędów); `null` — niedostępne */
  paths: TrafficCount[] | null;
  countries: TrafficCount[] | null;
  /** wejścia na `/zaproszenie` (landing zaproszeń); `null` — niedostępne */
  invites: { total: number; days: { date: string; count: number }[] } | null;
}

export type TrafficState = IntegrationState<TrafficData>;

/** `GET /admin/settings/changes?days=` — z dziennika audytu, od najstarszej. */
export interface RuntimeSettingChange {
  at: IsoDate;
  key: string;
  action: 'set' | 'clear';
  /** nowa wartość (lista osób = sama liczba); `null` przy `clear` */
  value: string | null;
  previous: string | null;
}

// ——— Flagi funkcji (bety) i komunikaty w aplikacji ———

/** Skąd wartość flagi dla domu: nadpisanie > rollout > globalnie > wyłączona. */
export type FeatureFlagSource = 'override' | 'rollout' | 'global' | 'off';

export interface FeatureFlagRow {
  /** `assistant.voice` — małe litery, cyfry, `.`, `_`, `-` */
  key: string;
  description: string;
  /** włączona dla wszystkich domów */
  enabled: boolean;
  /** 0–100, deterministycznie po haszu klucza i id domu */
  rolloutPercent: number;
  /** nadpisania domów: ile włącza, ile wyłącza */
  overridesOn: number;
  overridesOff: number;
  updatedAt: IsoDate;
  /** adres admina */
  updatedBy: string;
}

/** `GET /admin/flags` */
export interface FeatureFlagsData {
  flags: FeatureFlagRow[];
}

/** `POST /admin/flags` (step-up) */
export interface FeatureFlagCreate {
  key: string;
  description: string;
  enabled: boolean;
  rolloutPercent: number;
  reason: string;
}

/** `PATCH /admin/flags/:key` (step-up) — pola pominięte zostają */
export interface FeatureFlagUpdate {
  description?: string;
  enabled?: boolean;
  rolloutPercent?: number;
  reason: string;
}

export interface HouseholdFlagRow {
  key: string;
  description: string;
  /** nadpisanie tego domu; `null` — brak */
  override: boolean | null;
  /** co dom dostaje teraz */
  effective: boolean;
  source: FeatureFlagSource;
}

/** `GET /admin/flags/households/:householdId` */
export interface HouseholdFlagsData {
  householdId: string;
  flags: HouseholdFlagRow[];
}

/** `PUT /admin/flags/:key/households/:householdId` (step-up); zdjęcie — `DELETE` z `{ reason }` */
export interface HouseholdFlagOverride {
  enabled: boolean;
  reason: string;
}

export type AnnouncementSeverity = 'info' | 'warning' | 'critical';
/** `households` — tylko domy z `householdIds` */
export type AnnouncementAudience = 'all' | 'ios' | 'android' | 'households';
export type AnnouncementState = 'active' | 'scheduled' | 'ended';

export interface AnnouncementRow {
  id: string;
  /** ≤ 80 znaków, czysty tekst */
  title: string;
  /** ≤ 400 znaków, czysty tekst */
  body: string;
  severity: AnnouncementSeverity;
  audience: AnnouncementAudience;
  householdIds: string[];
  startsAt: IsoDate;
  /** `null` — do odwołania */
  endsAt: IsoDate | null;
  dismissible: boolean;
  /** adres admina */
  createdBy: string;
  createdAt: IsoDate;
  state: AnnouncementState;
}

/** `GET /admin/announcements` */
export interface AnnouncementsData {
  /** aktywne teraz, krytyczne pierwsze */
  active: AnnouncementRow[];
  /** start w przyszłości, najbliższe pierwsze */
  scheduled: AnnouncementRow[];
  /** zakończone w ostatnich 30 dniach, najnowsze pierwsze (≤ 50) */
  ended: AnnouncementRow[];
  limits: { titleMax: number; bodyMax: number; maxActive: number };
}

/** `POST /admin/announcements` (step-up) */
export interface AnnouncementCreate {
  title: string;
  body: string;
  severity: AnnouncementSeverity;
  audience: AnnouncementAudience;
  /** wymagane przy `audience = households` (1–50) */
  householdIds?: string[];
  /** brak — od teraz */
  startsAt?: IsoDate | null;
  /** brak — do odwołania */
  endsAt?: IsoDate | null;
  dismissible: boolean;
  reason: string;
}
