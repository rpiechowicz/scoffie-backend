import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { configureApp } from './app.setup';
import { assertRuntimeEnv } from './config/assert-env';

async function bootstrap() {
  // Przed `NestFactory.create`: na produkcji brak sekretów ma zatrzymać start,
  // a nie wyjść dopiero jako podrabialny token przy pierwszym logowaniu.
  assertRuntimeEnv();
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  configureApp(app);
  await app.listen(process.env.PORT ?? 3000);
}

bootstrap().catch((error: unknown) => {
  // Nieobsłużona obietnica kończyła się ostrzeżeniem Node i procesem,
  // który „żyje", ale nie słucha — platforma widziała kontener jako zdrowy.
  console.error('[bootstrap] start failed:', error);
  process.exit(1);
});
