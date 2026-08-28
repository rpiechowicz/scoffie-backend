import { ValidationPipe } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { join } from 'path';

/**
 * Wszystko, co aplikacja dostaje „na wierzchu” modułów: CORS, globalny
 * `ValidationPipe`, statyczne pliki, hooki zamknięcia.
 *
 * Jedno miejsce, wołane i z `main.ts`, i ze smoke e2e — dawniej e2e bootował
 * `AppModule` bez `ValidationPipe`, więc żaden test nie sprawdzał walidacji
 * DTO po HTTP, a `enableShutdownHooks` nie istniało nigdzie: dwa gotowe
 * `onModuleDestroy` (Prisma, bufory powiadomień) nigdy nie biegły na SIGTERM,
 * mimo starannego `exec` w CMD obrazu.
 *
 * `ValidationPipe` celowo przez `useGlobalPipes`, nie `APP_PIPE`: `APP_PIPE`
 * objąłby też gatewaye, a `forbidNonWhitelisted` zacząłby odrzucać payloady
 * WS, których klasy-koperty nie mają dekoratorów.
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
    exposedHeaders: ['x-access-token', 'x-request-id'],
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
  app.useStaticAssets(join(process.cwd(), 'public'), { prefix: '/static/' });
  app.enableShutdownHooks();
}
