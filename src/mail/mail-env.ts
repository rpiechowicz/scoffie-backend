/**
 * Konfiguracja poczty — czytana przy KAŻDYM użyciu, jak `agent-env.ts`
 * i `billing-env.ts`, żeby test mógł ją podmienić bez restartu modułu,
 * a zmiana zmiennej na Railway nie wymagała builda.
 *
 * KAŻDA ZMIENNA MA DOMYŚLNĄ WARTOŚĆ, a domyślnie poczta jest WYŁĄCZONA.
 * Wysyłanie maili do prawdziwych ludzi ma być świadomą decyzją, nie skutkiem
 * ubocznym deploya — dokładnie tak samo, jak przyjmowanie płatności.
 */

export type MailTransport = 'stub' | 'resend';

export type MailEnv = {
  /**
   * Czy w ogóle kolejkujemy maile. `false` NIE oznacza „kolejkuj i nie
   * wysyłaj": nic nie trafia do skrzynki nadawczej.
   *
   * DLACZEGO TAK, A NIE „ZBIERAJ NA PÓŹNIEJ". Gdyby wyłączenie tylko wstrzymywało
   * wysyłkę, pierwsze włączenie na produkcji wypchnęłoby naraz kilka tygodni
   * zaległych powitań i pożegnań — do ludzi, dla których ta treść jest już
   * nieprawdziwa. Zdarzenie, które minęło, nie ma prawa wrócić jako mail.
   */
  enabled: boolean;

  /** `stub` zapisuje maila na dysk i nic nie wysyła; `resend` idzie na świat. */
  transport: MailTransport;

  apiKey: string;

  /** Nadawca w formacie `Nazwa <adres>`. Domena musi być zweryfikowana u dostawcy. */
  from: string;

  /**
   * Adres do odpowiedzi. Wiadomość, na którą nie da się odpowiedzieć, jest
   * sama w sobie sygnałem spamowym — a przy Sign in with Apple to jedyny
   * kanał kontaktu, jaki człowiek ma pod ręką.
   */
  replyTo: string;

  /**
   * BEZPIECZNIK. Niepuste = KAŻDY mail leci pod ten adres, a prawdziwy
   * odbiorca ląduje w temacie i w nagłówku `X-Scoffie-Original-To`.
   *
   * Bez tego pierwsza pomyłka w środowisku deweloperskim wysyła wiadomość
   * prawdziwemu człowiekowi — a maila nie da się odwołać. Na produkcji
   * ustawiona wartość jest błędem konfiguracji i wywraca start.
   */
  redirectTo: string;

  /**
   * Skąd mail bierze obrazki (znak w nagłówku). Osobno od adresu strony
   * i DOMYŚLNIE Z BACKENDU (`/static/`), nie ze `scoffie.app`.
   *
   * Strona stoi za Cloudflare, a Bot Fight Mode (Static Resource Protection)
   * odbija żądania proxy prywatności Apple Mail — w iOS Mail zamiast znaku
   * była pusta ramka, choć ten sam adres z przeglądarki i z Gmaila odpowiadał
   * 200 (11.09.2026, potwierdzone na wiadomości z produkcji). Backend na
   * Railway serwuje ten sam plik bez żadnej bramki po drodze, a wysyłający
   * ma go zawsze przy sobie — niezależnie od tego, co dzieje się ze stroną.
   */
  assetBaseUrl: string;

  /** Adres, na który prowadzą przyciski i linki w treści. */
  siteUrl: string;

  /** Sekret do weryfikacji podpisu webhooka dostawcy (`whsec_…`). */
  webhookSecret: string;

  workerIntervalMs: number;
  maxAttempts: number;
  batchSize: number;

  /** Katalog na maile z transportu `stub`. */
  stubDir: string;
};

const DEFAULTS = {
  from: 'Scoffie <support@scoffie.app>',
  replyTo: 'support@scoffie.app',
  assetBaseUrl: 'https://api.scoffie.app/static',
  siteUrl: 'https://scoffie.app',
  workerIntervalMs: 15_000,
  maxAttempts: 5,
  batchSize: 20,
  stubDir: 'var/mail',
} as const;

function text(raw: string | undefined, fallback = ''): string {
  const value = (raw ?? '').trim();
  return value === '' ? fallback : value;
}

/**
 * `Number('')` to zero, nie `NaN`, a `??` nie łapie pustego stringa — więc
 * `MAIL_WORKER_INTERVAL_MS=` (dokładnie tak, jak stoi w `.env.example`)
 * ustawiłby pętlę na 0 ms. Stąd jawne odrzucanie wartości niedodatnich.
 */
function positive(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function flag(raw: string | undefined, fallback = false): boolean {
  const value = (raw ?? '').trim().toLowerCase();
  if (value === '') return fallback;
  return value === 'true' || value === '1' || value === 'yes';
}

export function readMailEnv(env: NodeJS.ProcessEnv = process.env): MailEnv {
  const transport: MailTransport =
    text(env.MAIL_TRANSPORT, 'stub') === 'resend' ? 'resend' : 'stub';

  return {
    enabled: flag(env.MAIL_ENABLED, false),
    transport,
    apiKey: text(env.RESEND_API_KEY),
    from: text(env.MAIL_FROM, DEFAULTS.from),
    replyTo: text(env.MAIL_REPLY_TO, DEFAULTS.replyTo),
    redirectTo: text(env.MAIL_REDIRECT_TO).toLowerCase(),
    assetBaseUrl: text(env.MAIL_ASSET_BASE_URL, DEFAULTS.assetBaseUrl).replace(
      /\/+$/,
      '',
    ),
    siteUrl: text(env.MAIL_SITE_URL, DEFAULTS.siteUrl).replace(/\/+$/, ''),
    webhookSecret: text(env.MAIL_WEBHOOK_SECRET),
    workerIntervalMs: positive(
      env.MAIL_WORKER_INTERVAL_MS,
      DEFAULTS.workerIntervalMs,
    ),
    maxAttempts: positive(env.MAIL_MAX_ATTEMPTS, DEFAULTS.maxAttempts),
    batchSize: positive(env.MAIL_BATCH_SIZE, DEFAULTS.batchSize),
    stubDir: text(env.MAIL_STUB_DIR, DEFAULTS.stubDir),
  };
}

/**
 * Powody, dla których konfiguracja poczty nie nadaje się na produkcję.
 * Zwracamy LISTĘ, a nie pierwszy błąd — operator ma zobaczyć wszystko naraz,
 * zamiast poprawiać po jednym i czekać na kolejny nieudany deploy.
 * Wołane z `assertRequiredEnv` przy starcie.
 */
export function mailEnvProblems(
  mail: MailEnv = readMailEnv(),
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const problems: string[] = [];
  if (!mail.enabled) return problems;

  if (mail.transport === 'resend' && mail.apiKey === '') {
    problems.push('MAIL_TRANSPORT=resend wymaga RESEND_API_KEY.');
  }
  if (!/^[^<>]*<[^@\s]+@[^@\s]+>$|^[^@\s]+@[^@\s]+$/.test(mail.from)) {
    problems.push(
      'MAIL_FROM musi mieć postać "Nazwa <adres@domena>" albo samego adresu.',
    );
  }
  if (mail.redirectTo !== '' && env.NODE_ENV === 'production') {
    problems.push(
      'MAIL_REDIRECT_TO jest ustawione na produkcji — to bezpiecznik ' +
        'deweloperski, który przekierowałby WSZYSTKIE maile użytkowników ' +
        'pod jeden adres.',
    );
  }
  if (mail.webhookSecret === '' && env.NODE_ENV === 'production') {
    problems.push(
      'MAIL_WEBHOOK_SECRET jest puste — bez niego nie da się przyjąć ' +
        'odrzutów i skarg, a wysyłka na martwe adresy psuje reputację domeny.',
    );
  }
  return problems;
}
