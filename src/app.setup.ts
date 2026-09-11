import { ValidationPipe } from '@nestjs/common';
import helmet from 'helmet';
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
  // Nagłówki bezpieczeństwa; `hidePoweredBy` w zestawie. CSP w wersji
  // „nic nie wolno": to API JSON plus kilka obrazków, więc żadna odpowiedź
  // nie ma prawa wykonać skryptu ani zostać osadzona w ramce — gdyby kiedyś
  // strona błędu albo Swagger trafiły na produkcję, przeglądarka i tak nic z
  // nich nie uruchomi. `crossOriginResourcePolicy` na `cross-origin`, bo
  // obrazki z `/static/` czyta aplikacja spoza tej domeny.
  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: false,
        directives: {
          'default-src': ["'none'"],
          'frame-ancestors': ["'none'"],
          'base-uri': ["'none'"],
          'form-action': ["'none'"],
        },
      },
      crossOriginResourcePolicy: { policy: 'cross-origin' },
    }),
  );
  app.disable('x-powered-by');
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
  // `maxAge`: znak do maili leci stąd (patrz `MAIL_ASSET_BASE_URL`), a klient
  // pocztowy otwiera tę samą wiadomość wiele razy — doba w cache zamiast
  // pobierania przy każdym otwarciu. Pliki w `public/` nie zmieniają się
  // częściej niż raz na wydanie.
  app.useStaticAssets(join(process.cwd(), 'public'), {
    prefix: '/static/',
    maxAge: 24 * 60 * 60 * 1000,
  });
  app.enableShutdownHooks();
}
