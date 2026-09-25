import { createPrivateKey, type KeyObject } from 'node:crypto';
import { SignJWT } from 'jose';
import { IntegrationError } from './integration-fetch';
import type { AscEnv } from './integrations-env';

/**
 * Token App Store Connect API — JEDEN dla buildów/recenzji
 * (`app-store-connect.client.ts`) i raportów sprzedaży/finansów
 * (`revenue/apple-reports.client.ts`).
 *
 * Jak w `AppStoreServerClient`: ES256 kluczem `.p8`, 5 minut, nowy na każde
 * odświeżenie — ale BEZ `bid` (to claim App Store Server API).
 */
export async function ascToken(env: AscEnv): Promise<string> {
  let key: KeyObject;
  try {
    key = createPrivateKey(env.privateKey);
  } catch {
    // Urwany albo źle wklejony `.p8` — błąd konfiguracji, nie awaria Apple.
    throw new IntegrationError(
      'App Store Connect: nie da się odczytać ADMIN_ASC_PRIVATE_KEY (sprawdź, czy wklejono cały plik .p8)',
    );
  }
  return new SignJWT({})
    .setProtectedHeader({ alg: 'ES256', kid: env.keyId, typ: 'JWT' })
    .setIssuer(env.issuerId)
    .setAudience('appstoreconnect-v1')
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(key);
}
