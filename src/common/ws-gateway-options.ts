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

export const WS_GATEWAY_OPTIONS: GatewayMetadata = {
  cors: {
    origin: resolveAllowedOrigins(),
    credentials: true,
  },
};
