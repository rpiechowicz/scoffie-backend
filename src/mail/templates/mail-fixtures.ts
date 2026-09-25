import { MailPayloads, MailTemplateId } from '../mail-template';

/**
 * Dane przykładowe — JEDNO źródło dla podglądu w przeglądarce, snapshotów
 * w testach i skryptu wysyłki próbnej. Dzięki temu to, co oglądasz na
 * `/ops/mail/preview`, jest dokładnie tym, co sprawdza test.
 *
 * Warianty brzegowe nie są ozdobą: długa nazwa gospodarstwa, alias Apple,
 * nazwa z samych emoji i dom sześcioosobowy to stany, które decydują o tym,
 * czy układ się nie rozjedzie — a wszystkie są w produkcji osiągalne.
 */
export type MailFixture = {
  key: string;
  label: string;
  template: MailTemplateId;
  payload: MailPayloads[MailTemplateId];
};

const DOM: { name: string; avatarColor: number | null }[] = [
  { name: 'Marta Wrona', avatarColor: 0 },
  { name: 'Kuba', avatarColor: 3 },
  { name: 'Zosia', avatarColor: 6 },
];

export const MAIL_FIXTURES: MailFixture[] = [
  {
    key: 'welcome',
    label: 'A · Witaj w Scoffie',
    template: 'WELCOME',
    payload: { displayName: 'Marta', trialMessages: 5, trialPlans: 1 },
  },
  {
    key: 'welcome-emoji',
    label: 'A · nazwa z samych emoji',
    template: 'WELCOME',
    payload: { displayName: '🐙🍜', trialMessages: 5, trialPlans: 1 },
  },
  {
    key: 'joined',
    label: 'B · Witaj w gospodarstwie',
    template: 'HOUSEHOLD_JOINED',
    payload: { householdName: 'Dom na Wiśniowej', members: DOM },
  },
  {
    key: 'joined-solo',
    label: 'B · dom jednoosobowy',
    template: 'HOUSEHOLD_JOINED',
    payload: {
      householdName: 'U mnie',
      members: [{ name: 'Marta Wrona', avatarColor: 0 }],
    },
  },
  {
    key: 'joined-long',
    label: 'B · bardzo długa nazwa i sześć osób',
    template: 'HOUSEHOLD_JOINED',
    payload: {
      householdName:
        'Gospodarstwo Rodziny Wroniewicz-Kowalskich przy Wiśniowej 14 m. 3',
      members: [
        { name: 'Marta Wrona', avatarColor: 0 },
        { name: 'Kuba', avatarColor: 1 },
        { name: 'Zosia', avatarColor: 2 },
        { name: 'Anna-Maria Zawadzka', avatarColor: 9 },
        { name: '🐙', avatarColor: 10 },
        { name: 'Bartek', avatarColor: 11 },
      ],
    },
  },
  {
    key: 'trial-messages',
    label: 'C1 · próba — koniec wiadomości',
    template: 'AI_TRIAL_EXHAUSTED',
    payload: {
      exhausted: 'messages',
      messagesUsed: 5,
      messagesLimit: 5,
      plansUsed: 0,
      plansLimit: 1,
    },
  },
  {
    key: 'trial-plans',
    label: 'C1 · próba — koniec zapisów planu',
    template: 'AI_TRIAL_EXHAUSTED',
    payload: {
      exhausted: 'plans',
      messagesUsed: 1,
      messagesLimit: 5,
      plansUsed: 1,
      plansLimit: 1,
    },
  },
  {
    key: 'quota-payer',
    label: 'C2 · pula w planie — do płatnika',
    template: 'AI_QUOTA_EXHAUSTED',
    payload: {
      exhausted: 'messages',
      planName: 'Solo',
      isPayer: true,
      payerName: 'Marta Wrona',
      messagesUsed: 30,
      messagesLimit: 30,
      plansUsed: 6,
      plansLimit: 8,
      renewsAtIso: '2026-10-14T00:00:00.000Z',
      renews: true,
    },
  },
  {
    key: 'quota-member',
    label: 'C2 · pula w planie — do domownika',
    template: 'AI_QUOTA_EXHAUSTED',
    payload: {
      exhausted: 'messages',
      planName: 'Rodzina',
      isPayer: false,
      payerName: 'Kuba',
      messagesUsed: 75,
      messagesLimit: 75,
      plansUsed: 11,
      plansLimit: 18,
      renewsAtIso: '2026-10-14T00:00:00.000Z',
      renews: true,
    },
  },
  {
    key: 'quota-no-renew',
    label: 'C2 · odnawianie wyłączone',
    template: 'AI_QUOTA_EXHAUSTED',
    payload: {
      exhausted: 'messages',
      planName: 'We dwoje',
      isPayer: true,
      payerName: 'Marta Wrona',
      messagesUsed: 50,
      messagesLimit: 50,
      plansUsed: 12,
      plansLimit: 12,
      renewsAtIso: null,
      renews: false,
    },
  },
  {
    key: 'grace',
    label: 'D · płatność — z datą łaski',
    template: 'SUBSCRIPTION_GRACE',
    payload: { planName: 'Solo', graceEndsAtIso: '2026-09-17T00:00:00.000Z' },
  },
  {
    key: 'grace-no-date',
    label: 'D · płatność — Apple nie podało daty',
    template: 'SUBSCRIPTION_GRACE',
    payload: { planName: 'Solo', graceEndsAtIso: null },
  },
  {
    key: 'expired',
    label: 'E · subskrypcja wygasła',
    template: 'SUBSCRIPTION_EXPIRED',
    payload: {
      planName: 'Solo',
      expiredAtIso: '2026-09-03T00:00:00.000Z',
      revoked: false,
    },
  },
  {
    key: 'revoked',
    label: 'E · zakup cofnięty przez Apple',
    template: 'SUBSCRIPTION_EXPIRED',
    payload: {
      planName: 'Rodzina',
      expiredAtIso: '2026-09-03T00:00:00.000Z',
      revoked: true,
    },
  },
  {
    key: 'deleted',
    label: 'F · konto usunięte, dom zostaje',
    template: 'ACCOUNT_DELETED',
    payload: {
      email: 'marta@icloud.com',
      deletedAtIso: '2026-09-10T20:00:00.000Z',
      householdRemains: true,
      keptRecipes: 12,
      hasLiveSubscription: true,
    },
  },
  {
    key: 'deleted-alone',
    label: 'F · konto usunięte, dom zniknął (alias Apple)',
    template: 'ACCOUNT_DELETED',
    payload: {
      email: 'x8k2m9p4qw@privaterelay.appleid.com',
      deletedAtIso: '2026-09-10T20:00:00.000Z',
      householdRemains: false,
      keptRecipes: 0,
      hasLiveSubscription: false,
    },
  },
  {
    key: 'legal',
    label: 'G · zmiana dokumentów',
    template: 'LEGAL_UPDATE',
    payload: {
      effectiveDateIso: '2026-10-01T00:00:00.000Z',
      version: '2026-10-01',
      requiresConsent: false,
      changes: [
        {
          title: 'Asystent AI',
          body: 'Opisujemy dokładniej, co trafia do modelu — treść Twojej prośby i plan — czego nie wysyłamy i jak długo trzymamy rozmowy.',
        },
        {
          title: 'Usunięcie konta',
          body: 'Precyzujemy, co dzieje się z przepisami i planami, które zostają w gospodarstwie.',
        },
      ],
    },
  },
  {
    key: 'legal-consent',
    label: 'G · zmiana wymagająca zgody',
    template: 'LEGAL_UPDATE',
    payload: {
      effectiveDateIso: '2026-10-01T00:00:00.000Z',
      version: '2026-10-01',
      requiresConsent: true,
      changes: [
        {
          title: 'Nowy odbiorca danych',
          body: 'Dokładamy dostawcę wysyłki e-mail. To zmiana istotna, więc poprosimy o zgodę jeszcze raz.',
        },
      ],
    },
  },
];

/**
 * Maile DO OPERATORA (alert, raport dzienny) — osobna lista, bo mają inną
 * stopkę (bez „dotyczy Twojego konta”) i linki do panelu, a nie do strony,
 * więc reguły z `mail-renderer.spec.ts` dla maili do osób ich nie dotyczą.
 */
export const OPERATOR_MAIL_FIXTURES: MailFixture[] = [
  {
    key: 'ops-alert',
    label: 'Operator · alert krytyczny',
    template: 'OPS_ALERT',
    payload: {
      severity: 'critical',
      title: 'scoffie-backend: wdrożenie padło',
      detail:
        'Ostatnie wdrożenie usługi scoffie-backend ma status FAILED (commit 0e231a1).',
      firstAtIso: '2026-09-25T09:40:00.000Z',
      panelUrl: 'https://dashboard.scoffie.app',
    },
  },
  {
    key: 'ops-alert-warning',
    label: 'Operator · ostrzeżenie',
    template: 'OPS_ALERT',
    payload: {
      severity: 'warning',
      title: 'iOS: crash-free poniżej 99 %',
      detail:
        'Crash-free sesji scoffie-ios w ostatnich 24 h: 98,40 % (próg 99 %).',
      firstAtIso: '2026-09-25T09:40:00.000Z',
      panelUrl: 'https://dashboard.scoffie.app',
    },
  },
  {
    key: 'daily-report',
    label: 'Operator · Scoffie wczoraj',
    template: 'DAILY_REPORT',
    payload: {
      day: '2026-09-24',
      panelUrl: 'https://dashboard.scoffie.app',
      sections: [
        {
          title: 'Ludzie',
          metrics: [
            {
              label: 'Nowe konta',
              value: 12,
              previous: 9,
              format: 'count',
              good: 'up',
            },
            {
              label: 'Osoby z asystentem',
              value: 31,
              previous: 34,
              format: 'count',
              good: 'up',
            },
          ],
        },
        {
          title: 'Asystent',
          metrics: [
            {
              label: 'Tury asystenta',
              value: 184,
              previous: 184,
              format: 'count',
              good: 'neutral',
            },
            {
              label: 'Koszt AI',
              value: 3.42,
              previous: 2.9,
              format: 'usd',
              good: 'down',
            },
            {
              label: 'Koszt AI w złotych',
              value: 12.73,
              previous: 10.8,
              format: 'pln',
              good: 'down',
            },
          ],
        },
        {
          title: 'Subskrypcje',
          metrics: [
            {
              label: 'MRR',
              value: 1249.5,
              previous: 1219.6,
              format: 'pln',
              good: 'up',
            },
            {
              label: 'Odejścia',
              value: 0,
              previous: 1,
              format: 'count',
              good: 'down',
            },
          ],
        },
        {
          title: 'Operacje',
          metrics: [
            {
              label: 'Maile nieudane',
              value: 0,
              previous: 0,
              format: 'count',
              good: 'down',
            },
            {
              label: 'Nowe problemy Sentry (24 h)',
              value: 2,
              previous: null,
              format: 'count',
              good: 'down',
            },
          ],
        },
      ],
      notes: [
        {
          tone: 'warn',
          text: 'Otwarte alerty: 1. Szczegóły na ekranie Alerty.',
        },
      ],
    },
  },
];

export function fixtureByKey(key: string): MailFixture | undefined {
  return [...MAIL_FIXTURES, ...OPERATOR_MAIL_FIXTURES].find(
    (f) => f.key === key,
  );
}
