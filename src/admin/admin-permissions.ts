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
  'mail.write',
  'catalog.read',
  'catalog.publish',
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
