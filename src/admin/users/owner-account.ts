import { readAdminEnv } from '../../config/admin-env';

/**
 * Czy konto aplikacji należy do właściciela panelu — adres konta jest na
 * liście `ADMIN_BOOTSTRAP_EMAIL`. Testowy push na takie urządzenie nie
 * wymaga potwierdzenia (patrz `AdminPushTestService`).
 */
export function isOwnerAccount(
  email: string | null,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const normalized = (email ?? '').trim().toLowerCase();
  return (
    normalized !== '' && readAdminEnv(env).ownerEmails.includes(normalized)
  );
}
