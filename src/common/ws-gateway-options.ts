import { GatewayMetadata } from '@nestjs/websockets';

function resolveAllowedOrigins(): string | string[] {
  const raw = process.env.WS_CORS_ORIGIN;
  if (!raw) {
    return '*';
  }

  const values = raw
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);

  return values.length <= 1 ? (values[0] ?? '*') : values;
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
    origin: resolveAllowedOrigins(),
    credentials: true,
  },
  maxHttpBufferSize: WS_MAX_PAYLOAD_BYTES,
};
