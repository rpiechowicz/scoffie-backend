import { ValidationPipe } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { join } from 'path';
import { AccessTokenService } from './auth/access-token.service';
import { AuthIoAdapter } from './common/ws-auth.adapter';
import { RequestMetricsService } from './observability/request-metrics.service';

/**
 * Wszystko, co aplikacja dostaje „na wierzchu” modułów: CORS, globalny
 * `ValidationPipe`, adapter WebSocketu z uwierzytelnieniem, statyczne pliki,
 * hooki zamknięcia.
 *
 * Jedno miejsce, wołane i z `main.ts`, i ze smoke e2e — dawniej e2e bootował
 * `AppModule` bez `ValidationPipe`, więc żaden test nie sprawdzał walidacji
 * DTO po HTTP, a `enableShutdownHooks` nie istniało nigdzie: dwa gotowe
 * `onModuleDestroy` (Prisma, bufory powiadomień) nigdy nie biegły na SIGTERM,
 * mimo starannego `exec` w CMD obrazu.
 *
 * `ValidationPipe` obejmuje TYLKO HTTP — ani `useGlobalPipes`, ani `APP_PIPE`
 * nie docierają do gatewayów (moduł socketów buduje własny kontekst pipe'ów),
 * a pipe na WS i tak rzucałby przed handlerem, omijając ack. Walidacja WS i
 * wywołań in-process idzie jawnie przez `validateDto` (`src/common/validate-dto.ts`)
 * w serwisach i `validateWsPayload` w handlerach — ten sam pipe, ten sam
 * format `details`.
 */
export function configureApp(app: NestExpressApplication): void {
  const extraOrigins = (process.env.CORS_ORIGIN ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
  // Panel deweloperski tylko poza produkcją — wpisany na sztywno
  // `localhost:5173` był dotąd dopuszczony także na prod.
  const devOrigins =
    process.env.NODE_ENV === 'production' ? [] : ['http://localhost:5173'];

  app.enableCors({
    origin: [...devOrigins, ...extraOrigins],
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'x-request-id',
      'x-ops-token',
    ],
    exposedHeaders: ['x-request-id'],
  });
  // Za proxy Railway `req.ip` to adres proxy; `trust proxy` przywraca
  // prawdziwy adres w logach (i pod przyszły throttling).
  app.set('trust proxy', 1);
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  // Auth WebSocketu: JWT z handshake'u, tożsamość w `socket.data`, pokoje per
  // gospodarstwo (`src/common/ws-auth.adapter.ts`). Adapter żyje poza DI,
  // więc zależności bierze z kontenera tutaj — tak samo w main.ts i w e2e.
  const metrics = app.get(RequestMetricsService, { strict: false });
  app.useWebSocketAdapter(
    new AuthIoAdapter(app, {
      accessTokens: app.get(AccessTokenService, { strict: false }),
      onHandshake: (result) =>
        metrics.recordWsHandshake(
          result.outcome === 'unavailable' ? 'rejected' : result.outcome,
          result.outcome === 'rejected'
            ? result.reason
            : result.outcome === 'unavailable'
              ? 'unavailable'
              : undefined,
        ),
    }),
  );
  app.useStaticAssets(join(process.cwd(), 'public'), { prefix: '/static/' });
  app.enableShutdownHooks();
}
