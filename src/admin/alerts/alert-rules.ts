import type {
  AlertSeverity,
  MailDomain,
  RailwayData,
  SentryData,
} from '../contract';
import { plural } from '../../mail/templates/mail-kit';
import {
  GDPR_KIND_LABELS,
  gdprDaysLeft,
  gdprUrgency,
} from '../gdpr/gdpr-rules';

/**
 * Reguły centrum alertów — CZYSTE funkcje: stan świata → lista problemów.
 * Bez bazy, bez zegara, bez sieci; `AdminWatchService` podaje dane,
 * a `planAlerts` decyduje, co otworzyć, odświeżyć, otworzyć ponownie
 * i zamknąć. Dzięki temu każdą regułę da się sprawdzić testem „wykrywa,
 * nie dubluje, rozwiązuje” bez Railwaya, Sentry i Resend.
 *
 * TREŚĆ BEZ DANYCH OSOBOWYCH. Tytuł i szczegół idą webhookiem i mailem,
 * więc reguły piszą je same z nazw usług, statusów i liczb — nigdy nie
 * kopiują tekstu, który mógłby nieść adres, nazwę osoby albo treść żądania
 * (stąd np. przy Sentry `shortId` i miejsce w kodzie, a nie tytuł błędu).
 */

export type AlertKind =
  | 'deploy-failed'
  | 'cron-failed'
  | 'crash-free'
  | 'sentry-fatal'
  | 'mail-queue'
  | 'mail-failed'
  | 'mail-domain'
  | 'gdpr-due'
  | 'apple-reports';

export type DetectedAlert = {
  key: string;
  kind: AlertKind;
  severity: AlertSeverity;
  title: string;
  detail: string;
};

/**
 * Wynik JEDNEJ reguły, która naprawdę się wykonała. Reguła, która nie mogła
 * sprawdzić stanu (brak klucza, dostawca nie odpowiada), nie oddaje nic —
 * i wtedy jej otwarte alerty NIE są zamykane: „nie wiem” to nie „w porządku”.
 */
export type Detection = { kind: AlertKind; problems: DetectedAlert[] };

/** Crash-free sesji iOS poniżej tego progu (w %) = alert. */
export const CRASH_FREE_THRESHOLD = 99;
/** Poniżej tego — krytyczny. */
export const CRASH_FREE_CRITICAL = 97;
/** Mail wymagalny dłużej niż tyle = robotnik skrzynki stoi. */
export const MAIL_STUCK_MS = 15 * 60_000;
const DAY_MS = 24 * 60 * 60_000;

const FAILED_DEPLOY = new Set(['FAILED', 'CRASHED']);

/** 1. Ostatnie wdrożenie każdej usługi Railway `FAILED` / `CRASHED`. */
export function railwayAlerts(data: RailwayData): DetectedAlert[] {
  return data.services.flatMap((service): DetectedAlert[] => {
    const last = service.deploys[0];
    if (!last || !FAILED_DEPLOY.has(last.status)) return [];
    const commit = last.commitHash
      ? ` (commit ${last.commitHash.slice(0, 7)})`
      : '';
    return [
      {
        key: `deploy-failed:${service.id}:${last.id}`,
        kind: 'deploy-failed',
        severity: 'critical',
        title: service.cron
          ? `${service.name}: uruchomienie padło`
          : `${service.name}: wdrożenie padło`,
        detail: `Ostatnie wdrożenie usługi ${service.name} ma status ${last.status}${commit}.`,
      },
    ];
  });
}

/**
 * 1b. Ostatnie uruchomienie usługi cron (`db-backup`) `CRASHED`.
 *
 * Railway nie podaje kodu wyjścia — `EXITED` to „proces się skończył”,
 * `CRASHED` to jedyny pewny sygnał porażki. Klucz z id uruchomienia: kolejne
 * udane zamyka alert, kolejne nieudane otwiera nowy.
 */
export function cronAlerts(data: RailwayData): DetectedAlert[] {
  return data.services.flatMap((service): DetectedAlert[] => {
    const last = (service.runs ?? [])[0];
    if (!service.cron || !last || last.status !== 'CRASHED') return [];
    const backup = service.name === 'db-backup';
    return [
      {
        key: `cron-failed:${service.id}:${last.id}`,
        kind: 'cron-failed',
        severity: 'critical',
        title: backup
          ? 'Kopia bazy nie powstała'
          : `${service.name}: uruchomienie crona padło`,
        detail: `Ostatnie uruchomienie ${service.name} (${last.startedAt.slice(0, 16).replace('T', ' ')} UTC) skończyło się statusem CRASHED.`,
      },
    ];
  });
}

/** 2a. Crash-free sesji `scoffie-ios` w 24 h poniżej progu. */
export function crashFreeAlerts(data: SentryData): DetectedAlert[] {
  const ios = data.projects.find((p) => p.slug === 'scoffie-ios');
  const rate = ios?.crashFreeSessions ?? null;
  if (rate === null || rate >= CRASH_FREE_THRESHOLD) return [];
  return [
    {
      key: 'crash-free:scoffie-ios',
      kind: 'crash-free',
      severity: rate < CRASH_FREE_CRITICAL ? 'critical' : 'warning',
      title: 'iOS: crash-free poniżej 99 %',
      detail: `Crash-free sesji scoffie-ios w ostatnich 24 h: ${rate.toFixed(2).replace('.', ',')} % (próg ${CRASH_FREE_THRESHOLD} %).`,
    },
  ];
}

/**
 * 2b. Nowe problemy Sentry o poziomie `fatal` (pierwszy raz w 24 h).
 *
 * Źródło to lista `fetchSentry` — 15 najczęstszych nierozwiązanych z 24 h.
 * Rzadki crash spoza piętnastki umknie tej regule, ale podbije crash-free.
 * Po 24 h problem przestaje być „nowy” i alert się zamyka.
 */
export function sentryFatalAlerts(
  data: SentryData,
  now: Date,
): DetectedAlert[] {
  return data.issues
    .filter(
      (issue) =>
        issue.level === 'fatal' &&
        now.getTime() - new Date(issue.firstSeen).getTime() <= DAY_MS,
    )
    .map((issue) => ({
      key: `sentry-fatal:${issue.id}`,
      kind: 'sentry-fatal' as const,
      severity: 'critical' as const,
      title: `Nowy crash ${issue.shortId}`,
      detail: `${issue.project || 'Sentry'}: nowy problem fatal${issue.culprit ? ` w ${issue.culprit.slice(0, 120)}` : ''} — ${issue.count} zdarzeń, ${issue.userCount} osób w 24 h.`,
    }));
}

/**
 * 3a. Robotnik skrzynki stoi: mail wymagalny (albo zajęty `SENDING`) od
 * ponad 15 minut. Pętla robotnika chodzi co 15 s, a wiersz z `SENDING`
 * sam wraca do kolejki po 10 min — 15 min bez ruchu to już nie przypadek.
 */
export function mailQueueAlerts(input: {
  mailEnabled: boolean;
  /** Najstarsza chwila, od której mail czeka na robotnika. */
  oldestWaitingSince: Date | null;
  now: Date;
}): DetectedAlert[] {
  if (!input.mailEnabled || !input.oldestWaitingSince) return [];
  const waitedMs = input.now.getTime() - input.oldestWaitingSince.getTime();
  if (waitedMs <= MAIL_STUCK_MS) return [];
  return [
    {
      key: 'mail-queue-stuck',
      kind: 'mail-queue',
      severity: 'critical',
      title: 'Poczta stoi',
      detail: `Najstarszy mail czeka na wysyłkę od ${Math.floor(waitedMs / 60_000)} min — robotnik skrzynki nadawczej nie wysyła.`,
    },
  ];
}

/**
 * 3b. Maile `FAILED` z ostatnich 24 h. Alert trwa, dopóki w oknie są
 * porażki (liczba w szczególe rośnie z każdą nową), i zamyka się dobę po
 * ostatniej.
 */
export function mailFailedAlerts(failed24h: number): DetectedAlert[] {
  if (failed24h <= 0) return [];
  return [
    {
      key: 'mail-failed',
      kind: 'mail-failed',
      severity: 'warning',
      title: 'Maile nie wychodzą',
      detail: `${failed24h} ${plural(failed24h, 'mail', 'maile', 'maili')} ze statusem FAILED w ostatnich 24 h — powód w panelu Poczta.`,
    },
  ];
}

/** 3c. Domena nadawcy u Resend inna niż `verified` (SPF/DKIM się rozjechały). */
export function domainAlerts(domains: readonly MailDomain[]): DetectedAlert[] {
  return domains
    .filter((domain) => domain.status !== 'verified')
    .map((domain) => ({
      key: `mail-domain:${domain.name}`,
      kind: 'mail-domain' as const,
      severity: 'critical' as const,
      title: `Domena ${domain.name} niezweryfikowana`,
      detail: `Resend podaje status „${domain.status}” dla domeny nadawcy ${domain.name} — maile mogą lądować w spamie albo nie wychodzić.`,
    }));
}

/**
 * 4. Wnioski RODO: otwarty wniosek mniej niż 7 dni przed terminem →
 * `warning`, po terminie → `critical` (ten sam klucz — przebieg po terminie
 * podbija wagę istniejącego alertu). Zamknięcie wniosku zamyka alert.
 *
 * Treść bez adresu wnioskodawcy: rodzaj, skrót id i data — reszta w panelu.
 */
export function gdprAlerts(
  open: readonly { id: string; kind: string; dueAt: Date }[],
  now: Date,
): DetectedAlert[] {
  return open.flatMap((request): DetectedAlert[] => {
    const urgency = gdprUrgency(request.dueAt, now);
    if (urgency === 'ok') return [];
    const label =
      GDPR_KIND_LABELS[request.kind as keyof typeof GDPR_KIND_LABELS] ??
      request.kind;
    const days = gdprDaysLeft(request.dueAt, now);
    const due = request.dueAt.toISOString().slice(0, 10);
    const short = request.id.slice(0, 8);
    return [
      urgency === 'overdue'
        ? {
            key: `gdpr-due:${request.id}`,
            kind: 'gdpr-due',
            severity: 'critical',
            title: 'RODO: wniosek po terminie',
            detail: `Wniosek ${short} — ${label} — miał termin ${due} (${-days} ${plural(-days, 'dzień', 'dni', 'dni')} temu). Odpowiedz i zamknij go w panelu RODO.`,
          }
        : {
            key: `gdpr-due:${request.id}`,
            kind: 'gdpr-due',
            severity: 'warning',
            title: 'RODO: zbliża się termin wniosku',
            detail: `Wniosek ${short} — ${label} — termin ${due}, za ${days} ${plural(days, 'dzień', 'dni', 'dni')}.`,
          },
    ];
  });
}

/**
 * 5. Raporty App Store Connect (przychód z Apple) nie schodzą — najczęściej
 * klucz bez roli Finance/Sales. Komunikat to nasz tekst z kodem HTTP
 * (`apple-reports.client.ts`), bez danych osób.
 */
export function appleReportAlerts(
  states: readonly { kind: string; lastError: string | null }[],
): DetectedAlert[] {
  return states
    .filter((state) => state.lastError)
    .map((state) => ({
      key: `apple-reports:${state.kind}`,
      kind: 'apple-reports' as const,
      severity: 'warning' as const,
      title:
        state.kind === 'finance'
          ? 'Raporty finansowe Apple się nie pobierają'
          : 'Raporty sprzedaży Apple się nie pobierają',
      detail: (state.lastError ?? '').slice(0, 300),
    }));
}

/* ── uzgadnianie z bazą ─────────────────────────────────────────────────── */

export type StoredAlert = {
  id: string;
  key: string;
  kind: string;
  resolvedAt: Date | null;
};

export type AlertPlan = {
  /** Nowy klucz — wiersz + powiadomienie. */
  open: DetectedAlert[];
  /** Klucz wrócił po rozwiązaniu — wiersz odżywa + powiadomienie. */
  reopen: { row: StoredAlert; alert: DetectedAlert }[];
  /** Trwa — odświeżenie `lastAt` i szczegółu, BEZ powiadomienia. */
  touch: { row: StoredAlert; alert: DetectedAlert }[];
  /** Zniknął — `resolvedAt`. */
  resolve: StoredAlert[];
};

/**
 * @param stored wiersze o kluczach z `detections` ORAZ wszystkie otwarte
 */
export function planAlerts(
  stored: readonly StoredAlert[],
  detections: readonly Detection[],
): AlertPlan {
  const byKey = new Map(stored.map((row) => [row.key, row]));
  const detected = new Map<string, DetectedAlert>();
  for (const detection of detections) {
    for (const alert of detection.problems) detected.set(alert.key, alert);
  }
  const checked = new Set(detections.map((d) => d.kind as string));

  const plan: AlertPlan = { open: [], reopen: [], touch: [], resolve: [] };
  for (const alert of detected.values()) {
    const row = byKey.get(alert.key);
    if (!row) plan.open.push(alert);
    else if (row.resolvedAt) plan.reopen.push({ row, alert });
    else plan.touch.push({ row, alert });
  }
  for (const row of stored) {
    if (
      row.resolvedAt === null &&
      checked.has(row.kind) &&
      !detected.has(row.key)
    ) {
      plan.resolve.push(row);
    }
  }
  return plan;
}
