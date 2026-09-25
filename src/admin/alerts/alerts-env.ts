import { readAdminEnv } from '../../config/admin-env';
import { looksLikeEmail } from '../../mail/mail-eligibility';

/**
 * Centrum alertów i raport dzienny — konfiguracja czytana PER WYWOŁANIE
 * (jak `readMailEnv`): zmiana na Railwayu działa po restarcie bez builda,
 * test podmienia ją bez przebudowy modułu.
 *
 * - `ADMIN_ALERTS` — domyślnie WŁĄCZONE (`false` wyłącza pętlę sprawdzeń).
 *   Samo wykrywanie niczego nie wysyła do ludzi z aplikacji; maile do
 *   operatora i tak wymagają `MAIL_ENABLED=true`.
 * - `ADMIN_ALERT_EMAILS` — adresaci alertów po przecinku; pusta = PIERWSZY
 *   adres z `ADMIN_BOOTSTRAP_EMAIL` (właściciel panelu).
 * - `ADMIN_DAILY_REPORT` — raport o 7:00, domyślnie WYŁĄCZONY, jak cała
 *   poczta: codzienny mail ma być świadomą decyzją, nie skutkiem deploya.
 * - `ADMIN_REPORT_EMAILS` — adresaci raportu; pusta = jak alerty.
 */
export type AlertsEnv = {
  enabled: boolean;
  alertEmails: string[];
  reportEnabled: boolean;
  reportEmails: string[];
  /** Adres panelu w mailach — pierwszy `ADMIN_WEBAUTHN_ORIGIN` albo produkcja. */
  panelUrl: string;
};

export const DEFAULT_PANEL_URL = 'https://dashboard.scoffie.app';

function flag(raw: string | undefined, fallback: boolean): boolean {
  const value = (raw ?? '').trim().toLowerCase();
  if (value === '') return fallback;
  return value === 'true' || value === '1' || value === 'yes';
}

/** Adresy po przecinku: bez pustych, bez nie-adresów, bez powtórzeń. */
export function emailList(raw: string | undefined): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of (raw ?? '').split(',')) {
    const email = item.trim();
    if (!email || !looksLikeEmail(email)) continue;
    const key = email.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(email);
  }
  return out;
}

export function readAlertsEnv(env: NodeJS.ProcessEnv = process.env): AlertsEnv {
  const owner = readAdminEnv(env).ownerEmails.find((email) =>
    looksLikeEmail(email),
  );
  const explicitAlerts = emailList(env.ADMIN_ALERT_EMAILS);
  const alertEmails =
    explicitAlerts.length > 0 ? explicitAlerts : owner ? [owner] : [];
  const explicitReport = emailList(env.ADMIN_REPORT_EMAILS);
  const origin = readAdminEnv(env).webauthnOrigins[0];
  return {
    enabled: flag(env.ADMIN_ALERTS, true),
    alertEmails,
    reportEnabled: flag(env.ADMIN_DAILY_REPORT, false),
    reportEmails: explicitReport.length > 0 ? explicitReport : alertEmails,
    panelUrl: (origin || DEFAULT_PANEL_URL).replace(/\/+$/, ''),
  };
}
