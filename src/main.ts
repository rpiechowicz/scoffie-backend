// Sentry przed WSZYSTKIM innym — patrz src/instrument.ts (no-op bez SENTRY_DSN).
import './instrument';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { configureApp } from './app.setup';
import { assertRuntimeEnv } from './config/assert-env';
import { SentryForwardingLogger } from './observability/sentry-logger';

async function bootstrap() {
  // Przed `NestFactory.create`: na produkcji brak sekretów ma zatrzymać start,
  // a nie wyjść dopiero jako podrabialny token przy pierwszym logowaniu.
  assertRuntimeEnv();
  // `rawBody: true` — webhook poczty liczy podpis z BAJTÓW ciała.
  // Przeparsowany i ponownie zserializowany JSON daje inny HMAC, więc bez
  // surowego ciała nie da się odróżnić prawdziwego odrzutu od podrobionego.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    rawBody: true,
    // Na stdout bez zmian; `warn`/`error` także do Sentry Logs (SENTRY_LOGS).
    logger: new SentryForwardingLogger(),
  });
  configureApp(app);
  await app.listen(process.env.PORT ?? 3000);
}

bootstrap().catch((error: unknown) => {
  // Nieobsłużona obietnica kończyła się ostrzeżeniem Node i procesem,
  // który „żyje", ale nie słucha — platforma widziała kontener jako zdrowy.
  console.error('[bootstrap] start failed:', error);
  process.exit(1);
});
