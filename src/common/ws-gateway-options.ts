import { GatewayMetadata } from '@nestjs/websockets';

/**
 * Źródła dopuszczone do socketu.
 *
 * Domyślnie TA SAMA lista, co CORS HTTP (`CORS_ORIGIN`, plus panel
 * deweloperski poza produkcją); `WS_CORS_ORIGIN` ją nadpisuje. Pusta lista na
 * produkcji = `false` (żadna strona przeglądarkowa nie otworzy socketu —
 * aplikacja iOS nie wysyła nagłówka Origin i jej to nie dotyczy). Dawne
 * domyślne `*` z poświadczeniami otwierało socket każdej stronie w sieci.
 */
export function resolveWsAllowedOrigins(
  env: NodeJS.ProcessEnv = process.env,
): string | string[] | boolean {
  const raw = (env.WS_CORS_ORIGIN ?? env.CORS_ORIGIN ?? '').trim();
  const values = raw
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  const production = env.NODE_ENV === 'production';
  if (!production) values.push('http://localhost:5173');
  if (values.includes('*')) return production ? false : '*';
  const unique = [...new Set(values)];
  if (unique.length === 0) return production ? false : '*';
  return unique.length === 1 ? unique[0] : unique;
}

/**
 * Górna granica jednej wiadomości Socket.IO. Domyślne 1 MB engine.io to
 * dziesięciokrotność największego legalnego payloadu (`recipes:create` z
 * opisem, krokami i ~30 składnikami mieści się w kilkunastu KB); przekroczenie
 * nie daje acka — engine.io zamyka transport, więc limit musi mieć zapas.
 * Import z Cookidoo idzie REST-em (`express.json`, osobna gałka).
 */
export const WS_MAX_PAYLOAD_BYTES = 256 * 1024;

/**
 * Pięć gatewayów dzieli jeden serwer, tworzony z opcji PIERWSZEGO z nich —
 * dlatego wszystkie importują ten obiekt, a nie własne kopie.
 */
export const WS_GATEWAY_OPTIONS: GatewayMetadata = {
  cors: {
    origin: resolveWsAllowedOrigins(),
    credentials: true,
  },
  maxHttpBufferSize: WS_MAX_PAYLOAD_BYTES,
};
