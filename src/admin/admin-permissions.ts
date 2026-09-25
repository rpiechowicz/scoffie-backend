/**
 * Uprawnienia panelu jako lista napisów (ROADMAPA §4 „Role", decyzja D5):
 * dziś jest jeden admin z rolą OWNER, ale druga osoba (np. SUPPORT bez
 * pieniędzy i bez danych o zdrowiu) ma być konfiguracją tego pliku, a nie
 * przebudową kontrolerów. Brak uprawnienia = 404, jak brak trasy.
 */
export const ADMIN_PERMISSIONS = [
  'dashboard.read',
  'users.read',
  /** Odsłonięcie danych szczególnej kategorii (art. 9 RODO). */
  'users.health.reveal',
  'users.sessions.write',
  'users.export',
  'users.delete',
  'households.read',
  /** Nadanie / zdjęcie PRO, reset sufitu kosztu. */
  'billing.write',
  'assistant.read',
  'reports.write',
  'subscriptions.read',
  'subscriptions.write',
  'mail.read',
  'mail.write',
  /** Sentry i Railway — tylko odczyt. */
  'ops.read',
  /** Logi usług Railway — mogą zawierać dane osób z żądań. */
  'ops.logs',
  /** App Store Connect — tylko odczyt. */
  'appstore.read',
  /** Odpowiedzi na recenzje w App Store (step-up). */
  'appstore.write',
  'catalog.read',
  'catalog.publish',
  /** Dziennik audytu panelu — tylko odczyt. */
  'audit.read',
  /** Sterowanie w locie: wyłącznik i limity asystenta (ROADMAPA §5.12). */
  'settings.read',
  'settings.write',
  /** Centrum alertów: odczyt i „Przyjąłem”. */
  'alerts.read',
  'alerts.write',
  /** Raport „Scoffie wczoraj” — podgląd i wysyłka na żądanie (NIE `reports.*`, to zgłoszenia asystenta). */
  'daily-report.read',
  'daily-report.send',
  /** Ekran „Wzrost”: lejek, kohorty, DAU/WAU/MAU (tylko agregaty). */
  'growth.read',
  /** Testowy push na urządzenie osoby (step-up; obcej osoby — z powodem). */
  'users.push.test',
  /** Rejestr wniosków RODO (ROADMAPA §5.11) — odczyt i obsługa. */
  'gdpr.read',
  'gdpr.write',
  /** Wypłaty z Apple (raporty sprzedaży i finansów App Store Connect) i kurs NBP. */
  'revenue.read',
] as const;
export type AdminPermission = (typeof ADMIN_PERMISSIONS)[number];

export const ADMIN_ROLE_PERMISSIONS: Readonly<
  Record<string, readonly AdminPermission[]>
> = {
  OWNER: ADMIN_PERMISSIONS,
};

export function roleHasPermission(
  role: string,
  permission: AdminPermission,
): boolean {
  return (ADMIN_ROLE_PERMISSIONS[role] ?? []).includes(permission);
}
